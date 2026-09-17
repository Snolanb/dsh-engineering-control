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
  let disposed = false;
  /** @type {(() => void) | undefined} */
  let unsubscribe;

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
    if (typeof event.sessionId !== 'string') return;
    if (sessionState.has(event.sessionId)) return;
    const role = mapRole(event);
    if (!role) return;
    if (!acquire(event.sessionId)) return;
    try {
      const change = await findChangeForEvent(event);
      if (!change || typeof change.id !== 'string') return;

      if (typeof cc.getBinding === 'function') {
        const existing = await Promise.resolve(cc.getBinding(change.id, event.sessionId));
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
        await Promise.resolve(cc.bindRole(change.id, event.sessionId, role, options));
      }
      sessionState.set(event.sessionId, 'active');
    } finally {
      releaseLock(event.sessionId);
    }
  }

  /**
   * @param {any} event
   */
  async function handleSessionReleased(event) {
    if (typeof event.sessionId !== 'string') return;
    const state = sessionState.get(event.sessionId);
    if (state === 'released') return;
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
        if (!change || typeof change.id !== 'string') return;
        const existing = await Promise.resolve(cc.getBinding(change.id, event.sessionId));
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
              sessionState.set(event.sessionId, 'released');
            } else {
              throw err;
            }
          }
        }
        sessionState.set(event.sessionId, 'released');
      } finally {
        releaseLock(event.sessionId);
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
      if (change && typeof change.id === 'string' && typeof cc.getBinding === 'function') {
        const existing = await Promise.resolve(cc.getBinding(change.id, event.sessionId));
        if (existing && existing.role !== role) {
          /** @type {Error & { code?: string }} */
          const err = new Error(
            `release-role-conflict: session ${event.sessionId} bound as ${existing.role}; release event maps to ${role}`,
          );
          err.code = 'ROLE_CONFLICT';
          throw err;
        }
      }
      if (change && typeof change.id === 'string' && typeof cc.unbindRole === 'function') {
        try {
          await Promise.resolve(cc.unbindRole(change.id, event.sessionId, {}));
        } catch (err) {
          if (!isExpectedNoBindingError(err)) throw err;
        }
      }
      sessionState.set(event.sessionId, 'released');
    } finally {
      releaseLock(event.sessionId);
    }
  }

  /**
   * @param {any} error
   * @returns {boolean}
   */
  function isExpectedNoBindingError(error) {
    if (!(error instanceof Error)) return false;
    const e = /** @type {Error & { code?: string }} */ (error);
    if (e.code === 'NOT_FOUND' || e.code === 'NO_BINDING') return true;
    return false;
  }

  /**
   * @param {any} event
   */
  async function handleTaskCompleted(event) {
    const change = await findChangeForEvent(event);
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
  }

  if (lifecycle && typeof lifecycle.subscribe === 'function') {
    unsubscribe = lifecycle.subscribe((/** @type {any} */ event) => handleEvent(event));
  }

  return { dispose };
}
