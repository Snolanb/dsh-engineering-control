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
 * - `session.started` performs at most one binding, using the public
 *   `getBinding` surface when available so duplicate delivery after an adapter
 *   restart is idempotent and conflicting roles fail closed.
 * - `session.settled` and `session.removed` perform at most one release.
 * - `task.completed` forwards stable lifecycle identifiers through
 *   `appendAudit` without scheduling or inventing Change transitions.
 */

/**
 * @param {object} deps
 * @param {any} deps.agentTeamsLifecycle optional lifecycle service exposing `subscribe` and `getTeam`
 * @param {any} deps.changeControl Change Control facade
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
   * Map generic taskKind/role metadata to a Change Control role.
   * Reviewer indicators win; worker/test/implementation/repair indicators map
   * to worker; unknown indicators are ignored. Provider/model fields are
   * intentionally never inspected.
   * @param {any} event
   * @returns {string | null}
   */
  function mapRole(event) {
    if (!event || typeof event !== 'object') return null;
    const text = [event.taskKind, event.role]
      .filter((value) => value !== null && value !== undefined)
      .map((value) => String(value).toLowerCase())
      .join(' ');
    if (text.includes('review')) return 'reviewer';
    if (['test', 'implementation', 'repair', 'worker'].some((token) => text.includes(token))) return 'worker';
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
      let existing = null;
      if (typeof cc.getBinding === 'function') {
        try {
          existing = await Promise.resolve(cc.getBinding(change.id, event.sessionId));
        } catch {
          existing = null;
        }
      }
      if (existing) return;
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
    if (state !== 'active') return;
    if (!acquire(event.sessionId)) return;
    try {
      const change = await findChangeForEvent(event);
      if (change && typeof change.id === 'string' && typeof cc.unbindRole === 'function') {
        await Promise.resolve(cc.unbindRole(change.id, event.sessionId, {})).catch(() => {});
      }
      sessionState.set(event.sessionId, 'released');
    } finally {
      releaseLock(event.sessionId);
    }
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
    })).catch(() => {});
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
    unsubscribe = lifecycle.subscribe((event) => {
      handleEvent(event).catch(() => {});
      return undefined;
    });
  }

  return { dispose };
}
