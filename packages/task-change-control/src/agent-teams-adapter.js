// G3: optional AgentTeams lifecycle adapter.
import { WORK_ITEM_SYSTEM } from './service.js';

/**
 * AgentTeams lifecycle adapter.
 *
 * Bridges public AgentTeams session/task lifecycle events into Change Control
 * role bindings and append-only audit evidence. The adapter never reads
 * AgentTeams private state, never calls Task Orchestrator scheduling/claim/
 * start/retry APIs, and only uses the public lifecycle service plus Change
 * Control's public `findByWorkItem`, `bindRole`, `getBinding`, `unbindRole`,
 * and `appendAudit` methods when available.
 *
 * Session lifecycle semantics:
 * - A known session ID is processed exactly once in the lifecycle
 *   started → released state. Unknown session IDs are ignored without change
 *   lookups or mutations.
 * - `session.started` performs at most one binding. The public `getBinding`
 *   result is authoritative: a real existing binding is accepted idempotently
 *   only when its role matches the derived role; a conflicting role is a
 *   structured role-conflict failure. Unexpected `getBinding` errors are
 *   propagated, never converted to absence.
 * - `session.settled` and `session.removed` release exactly once. When local
 *   state is absent (restart/idempotence), the adapter resolves the Change and
 *   consults `getBinding` before unbinding. Only the expected no-binding /
 *   NOT_FOUND race is tolerated; every other failure is propagated.
 * - `task.completed` forwards stable lifecycle identifiers through
 *   `appendAudit`; unexpected failures are propagated.
 */

/** Exact enum tokens accepted for Change role mapping. */
const REVIEWER_TOKENS = new Set(['review', 'reviewer']);
const WORKER_TOKENS = new Set(['test', 'implementation', 'repair', 'worker']);

/**
 * @param {{ agentTeamsLifecycle?: any, changeControl?: any }} [deps]
 * @returns {{ dispose: () => void }} adapter
 */
export function createAgentTeamsAdapter({ agentTeamsLifecycle, changeControl } = {}) {
  const lifecycle = agentTeamsLifecycle ?? null;
  const cc = changeControl ?? null;

  /** @type {Map<string, string>} */
  const inFlight = new Map();
  /** @type {Map<string, 'active' | 'released'>} */
  const sessionState = new Map();
  /** @type {Map<string, Array<{ type: string, event: any, resolve?: (value?: unknown) => void, reject?: (reason?: unknown) => void, settle?: () => void }>>} */
  const pendingReleases = new Map();
  // C3-R3-F1: per-session draining guard. While the guard is held, the owner
  // drains every entry. queueRelease during a drain re-inserts the entry and
  // returns a deferred Promise; the owner's loop re-reads it and settles the
  // deferred. The finally-block drain is a recursive call, but the re-inserted
  // entries settle before the recursive call can run, so the recursive call
  // sees an empty queue and the outer firstError is never overwritten.
  /** @type {Map<string, boolean>} */
  const draining = new Map();
  let disposed = false;
  /** @type {(() => void) | undefined} */
  let unsubscribe;
  // C3-R4-F3/F4: tracks every live deferred so dispose can settle it
  // deterministically. Entries are removed when the deferred is settled.
  /** @type {Set<() => void>} */
  const pendingDeferreds = new Set();

  /**
   * Safely extract a public error code from a thrown value. Returns the
   * `code` string when the value is a non-null object or function carrying a
   * string `code`; returns undefined for null/undefined/primitives and for
   * values whose `code` is not a string. The original value is never mutated.
   * @param {unknown} error
   * @returns {string | undefined}
   */
  function safeErrorCode(error) {
    if (error === null || error === undefined) return undefined;
    if (typeof error !== 'object' && typeof error !== 'function') return undefined;
    /** @type {any} */
    const e = /** @type {any} */ (error);
    if (typeof e.code !== 'string') return undefined;
    return e.code;
  }

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  function isExpectedNoBindingError(error) {
    // F4: tolerate exact public no-binding codes regardless of Error prototype;
    // plain objects {code:'NOT_FOUND'}/{code:'NO_BINDING'} must also be accepted.
    const code = safeErrorCode(error);
    if (code === 'NOT_FOUND' || code === 'NO_BINDING') return true;
    return false;
  }

  /**
   * Enqueue a release event for a session whose operation is currently in
   * flight (or being drained). Returns a deferred Promise that settles only
   * when the queued release has actually been handled. The owner of the drain
   * guard picks up re-inserted entries in the same loop and settles each
   * deferred before the finally-block drain can re-enter.
   * @param {string} sessionId
   * @param {any} event
   * @returns {Promise<void>}
   */
  function queueRelease(sessionId, event) {
    /** @type {(value?: unknown) => void} */
    let resolve = () => {};
    /** @type {(reason?: unknown) => void} */
    let reject = () => {};
    /** @type {Promise<void>} */
    const deferred = new Promise((res, rej) => {
      resolve = /** @type {(value?: unknown) => void} */ (res);
      reject = /** @type {(reason?: unknown) => void} */ (rej);
    });
    // Track a settle closure so dispose() can resolve the deferred
    // deterministically if the drain never runs.
    const settle = () => {
      pendingDeferreds.delete(settle);
      resolve();
    };
    pendingDeferreds.add(settle);
    let q = pendingReleases.get(sessionId);
    if (!q) {
      q = [];
      pendingReleases.set(sessionId, q);
    }
    q.push({ type: event.type, event, resolve, reject, settle });
    return deferred;
  }

  /**
   * Drain queued settled/removed events for a session. Per-session draining
   * guard ensures single-owner processing: the guard holder owns every drain
   * pass. While the guard is held, queueRelease re-inserts entries and
   * returns a deferred Promise; the owner's loop re-reads the array and
   * settles the deferred before the finally-block drain can re-enter.
   * Unexpected failures are preserved per entry; the outer drain throws the
   * first unexpected error after all entries have been handled.
   * @param {string} sessionId
   */
  /**
   * @type {Array<{ type: string, event: any, resolve?: (value?: unknown) => void, reject?: (reason?: unknown) => void, settle?: () => void }>}
   */
  /** @param {string} sessionId */
  async function drainReleases(sessionId) {
    if (draining.get(sessionId)) return; // recursive re-entry — already owned
    draining.set(sessionId, true);
    try {
      let firstError;
      let hasError = false;
      for (;;) {
        // C3-R4-F4: if dispose ran before this iteration dispatches, settle
        // all remaining deferreds as teardown no-ops and stop dispatching.
        if (disposed) {
          const queue = pendingReleases.get(sessionId);
          if (queue) {
            for (const e of queue) {
              if (e.settle) {
                e.settle();
                pendingDeferreds.delete(e.settle);
              }
            }
            pendingReleases.delete(sessionId);
          }
          break;
        }
        const queue = pendingReleases.get(sessionId);
        if (!queue || queue.length === 0) {
          pendingReleases.delete(sessionId);
          break;
        }
        const entry = queue.shift();
        if (entry === undefined) continue;
        try {
          await handleSessionReleased(entry.event);
          entry.resolve?.();
          if (entry.settle) pendingDeferreds.delete(entry.settle);
        } catch (err) {
          // The deferred belongs to the queued emitter, not to this drain:
          // settle it with the exact error so the originating lifecycle.emit
          // Promise rejects with its own operation's failure.
          entry.reject?.(err);
          if (entry.settle) pendingDeferreds.delete(entry.settle);
          // Remember the outer drain's first unexpected error; queued entry
          // errors are already delivered through their own deferreds.
          if (!hasError) {
            firstError = err;
            hasError = true;
          }
        }
      }
      if (hasError) throw firstError;
    } finally {
      draining.delete(sessionId);
    }
  }

  /**
   * Map generic taskKind/role metadata to a Change Control role using exact
   * enum-token matching. Reviewer tokens win; worker tokens map to worker;
   * unknown or conflicting values are ignored. Provider/model fields are
   * intentionally never inspected.
   * @param {any} event
   * @returns {string | null}
   */
  function mapRole(event) {
    if (!event || typeof event !== 'object') return null;
    const tokens = [event.taskKind, event.role]
      .filter((value) => typeof value === 'string')
      .map((value) => value.toLowerCase());
    if (tokens.some((t) => REVIEWER_TOKENS.has(t))) return 'reviewer';
    if (tokens.some((t) => WORKER_TOKENS.has(t))) return 'worker';
    return null;
  }

  /**
   * @param {string} sessionId
   * @returns {boolean}
   */
  function acquire(sessionId) {
    if (inFlight.has(sessionId)) return false;
    inFlight.set(sessionId, 'pending');
    return true;
  }

  /** @param {string} sessionId */
  function releaseLock(sessionId) {
    inFlight.delete(sessionId);
  }

  /**
   * Resolve the active Change for a governed team using only public lifecycle
   * `getTeam` and Change Control `findByWorkItem`.
   * @param {any} event
   * @returns {Promise<any | null>}
   */
  async function findChangeForEvent(event) {
    if (!cc || typeof lifecycle?.getTeam !== 'function' || typeof cc.findByWorkItem !== 'function') return null;
    if (typeof event.teamId !== 'string' || event.teamId === '') return null;
    const team = await Promise.resolve(lifecycle.getTeam(event.teamId));
    if (!team || typeof team.taskId !== 'string') return null;
    return await Promise.resolve(cc.findByWorkItem(WORK_ITEM_SYSTEM, team.taskId));
  }

  /**
   * @param {any} event
   */
  async function handleSessionStarted(event) {
    if (typeof event.sessionId !== 'string' || event.sessionId === '') return;
    if (sessionState.has(event.sessionId)) return;
    const role = mapRole(event);
    if (!role) return;
    if (!acquire(event.sessionId)) return;
    try {
      const change = await findChangeForEvent(event);
      if (disposed) return;
      if (!change || typeof change.id !== 'string') return;

      if (typeof cc.getBinding === 'function') {
        const existing = await Promise.resolve(cc.getBinding(change.id, event.sessionId));
        if (disposed) return;
        if (existing) {
          if (existing.role !== role) {
            /** @type {Error & { code?: string }} */
            const err = new Error(
              `role-conflict: session ${event.sessionId} already bound as ${existing.role}; expected ${role}`,
            );
            err.code = 'ROLE_CONFLICT';
            throw err;
          }
          sessionState.set(event.sessionId, 'active');
          return;
        }
      }

      /** @type {{ worker?: string }} */
      const options = {};
      if (typeof event.attemptId === 'string' && event.attemptId !== '') {
        options.worker = event.attemptId;
      }
      if (typeof cc.bindRole === 'function') {
        try {
          await Promise.resolve(cc.bindRole(change.id, event.sessionId, role, options));
        } catch (err) {
          // F2: duplicate-bind race — two instances/restart both saw null,
          // both called bindRole; the second gets ALREADY_BOUND/DUPLICATE.
          // Re-read getBinding and accept only a matching role.
          const code = safeErrorCode(err);
          if (code === 'ALREADY_BOUND' || code === 'DUPLICATE') {
            if (disposed) return;
            const re = await Promise.resolve(cc.getBinding(change.id, event.sessionId));
            if (disposed) return;
            if (re && re.role === role) {
              sessionState.set(event.sessionId, 'active');
            } else if (re) {
              /** @type {Error & { code?: string }} */
              const rc = new Error(
                `role-conflict: session ${event.sessionId} re-bound as ${re.role}; expected ${role}`,
              );
              rc.code = 'ROLE_CONFLICT';
              throw rc;
            }
            return;
          }
          throw err;
        }
      }
      if (disposed) return;
      sessionState.set(event.sessionId, 'active');
    } finally {
      releaseLock(event.sessionId);
      // F1: drain any settled/removed events that were queued while this
      // started was in flight, so a pending release is never dropped.
      if (!disposed) await drainReleases(event.sessionId);
    }
  }

  /**
   * @param {any} event
   * @returns {Promise<void>}
   */
  async function handleSessionReleased(event) {
    if (typeof event.sessionId !== 'string' || event.sessionId === '') return;
    const state = sessionState.get(event.sessionId);
    if (state === 'released') return;
    // A started (or another release) is in flight for this session — queue
    // this release and return its deferred promise so the originating
    // lifecycle.emit promise stays pending until drainReleases settles it.
    if (inFlight.has(event.sessionId)) {
      return queueRelease(event.sessionId, event);
    }
    if (state === undefined) {
      // No local state: only a binding actually present on Change Control
      // makes this release actionable. Tolerating a missing binding avoids
      // Change lookups for ignored/unknown sessions.
      const role = mapRole(event);
      if (role === null) return;
      if (!acquire(event.sessionId)) return;
      try {
        if (!(typeof cc?.getBinding === 'function')) return;
        const change = await findChangeForEvent(event);
        if (disposed) return;
        if (!change || typeof change.id !== 'string') return;
        const existing = await Promise.resolve(cc.getBinding(change.id, event.sessionId));
        if (disposed) return;
        if (existing) {
          if (existing.role !== role) {
            /** @type {Error & { code?: string }} */
            const err = new Error(
              `release-role-conflict: session ${event.sessionId} bound as ${existing.role}; release event maps to ${role}`,
            );
            err.code = 'ROLE_CONFLICT';
            throw err;
          }
          if (typeof cc.unbindRole !== 'function') return;
          try {
            await Promise.resolve(cc.unbindRole(change.id, event.sessionId, {}));
          } catch (err) {
            if (isExpectedNoBindingError(err)) {
              if (disposed) return;
              sessionState.set(event.sessionId, 'released');
            } else {
              throw err;
            }
          }
        }
        if (disposed) return;
        sessionState.set(event.sessionId, 'released');
      } finally {
        releaseLock(event.sessionId);
        if (!disposed) await drainReleases(event.sessionId);
      }
      return;
    }

    // Local state === 'active': require the accepted release role before
    // consulting getBinding so unknown/malformed events perform no lookups.
    const role = mapRole(event);
    if (role === null) return;
    if (!acquire(event.sessionId)) return;
    try {
      const change = await findChangeForEvent(event);
      if (disposed) return;
      // F6: when Change resolution returns null, leave active state so a
      // later terminal event can retry; do NOT mark released.
      if (!change || typeof change.id !== 'string') return;
      if (typeof cc.getBinding === 'function') {
        const existing = await Promise.resolve(cc.getBinding(change.id, event.sessionId));
        if (disposed) return;
        if (existing && existing.role !== role) {
          /** @type {Error & { code?: string }} */
          const err = new Error(
            `release-role-conflict: session ${event.sessionId} bound as ${existing.role}; release event maps to ${role}`,
          );
          err.code = 'ROLE_CONFLICT';
          throw err;
        }
      }
      if (typeof cc.unbindRole === 'function') {
        try {
          await Promise.resolve(cc.unbindRole(change.id, event.sessionId, {}));
        } catch (err) {
          if (!isExpectedNoBindingError(err)) throw err;
        }
      }
      if (disposed) return;
      sessionState.set(event.sessionId, 'released');
    } finally {
      releaseLock(event.sessionId);
      if (!disposed) await drainReleases(event.sessionId);
    }
  }

  /**
   * @param {any} event
   */
  async function handleTaskCompleted(event) {
    // F3: require non-empty primitive session identifier before any lookup.
    if (typeof event.sessionId !== 'string' || event.sessionId === '') return;
    const change = await findChangeForEvent(event);
    if (disposed) return;
    if (!change || typeof change.id !== 'string') return;
    if (typeof cc.appendAudit !== 'function') return;
    await Promise.resolve(cc.appendAudit({
      type: event.type,
      teamId: event.teamId ?? null,
      agentTaskId: event.agentTaskId ?? null,
      attemptId: event.attemptId ?? null,
      sessionId: event.sessionId ?? null,
      status: event.status ?? null,
      result: event.result ?? null,
    }));
  }

  /**
   * @param {any} event
   */
  async function handleEvent(event) {
    if (disposed || !event || typeof event !== 'object') return;
    switch (event.type) {
      case 'session.started':
        await handleSessionStarted(event);
        break;
      case 'session.settled':
      case 'session.removed':
        await handleSessionReleased(event);
        break;
      case 'task.completed':
        await handleTaskCompleted(event);
        break;
      default:
        break;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
    // C3-R4-F3: deterministically settle every live deferred so no
    // originating lifecycle.emit Promise can hang after teardown.
    for (const settle of pendingDeferreds) {
      settle();
    }
    pendingDeferreds.clear();
  }

  if (lifecycle && typeof lifecycle.subscribe === 'function') {
    unsubscribe = lifecycle.subscribe((/** @type {any} */ event) => handleEvent(event));
  }

  return { dispose };
}
