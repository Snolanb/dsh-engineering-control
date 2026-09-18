// G2 lifecycle auto-bootstrap controller.
// Subscribes to taskOrchestrator.subscribe (no event payload) and on every
// notification rescan persisted tasks in the four active lifecycle states
// (ready, claimed, running, in_review). For each governed task (G1 policy
// required === true), ensures exactly one nonterminal linked Change exists —
// create one when missing via the existing service.bootstrapTask.
// Reconcile-on-startup + rescan-on-notification make it idempotent under
// duplicate events, concurrent fires, and process restart.
// @ts-nocheck
import { resolveGovernancePolicy } from './policy.js';
import { WORK_ITEM_SYSTEM } from './service.js';

const ACTIVE = Object.freeze(['ready', 'claimed', 'running', 'in_review']);

/**
 * @param {object} deps
 * @param {object} deps.taskOrchestrator  Task Orchestrator facade (exposes subscribe, list, get)
 * @param {object} deps.changeControl     Change Control facade (exposes findByWorkItem)
 * @param {(taskId: string) => Promise<any>} deps.bootstrapTask  service-bound bootstrapTask
 * @param {(task: object) => { required: boolean, [k: string]: any }} [deps.resolvePolicy]
 *        defaults to G1 resolveGovernancePolicy
 * @param {(taskId: string, changeId: string, state: string) => void} [deps.publishChangeState]
 *        G4: optional snapshot publish hook called on the existing-link branch
 */
export function createLifecycleBootstrapper({ taskOrchestrator, changeControl, bootstrapTask, resolvePolicy = resolveGovernancePolicy, publishChangeState } = /** @type {object} */ (undefined)) {
  let active = false;
  let dispose = null;
  // Per-task in-flight set: duplicate notifications for the same task are
  // coalesced onto one bootstrap call; different tasks reconcile concurrently.
  const inFlight = new Set();

  /** @param {any} task */
  async function bootstrapTaskSafe(task) {
    if (!ACTIVE.includes(task?.status)) return;
    const taskId = task.id;
    let policy;
    try {
      policy = resolvePolicy(task);
    } catch {
      return; // malformed task — skip, never abort sibling reconciliation
    }
    if (policy?.required !== true) return;
    if (inFlight.has(taskId)) return; // coalesce duplicate notification
    inFlight.add(taskId);
    try {
      // Re-read the canonical task: the notification row may be stale.
      const fresh = taskOrchestrator.get(taskId);
      if (!fresh || !ACTIVE.includes(fresh.status)) return;
      let link;
      try {
        link = await changeControl.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
      } catch {
        return; // Change-side lookup unavailable — the next notification retries
      }
      if (link) {
        // G4: publish the authoritative link into the sync snapshot so the
        // lifecycle guard sees this task as governed even when the task's
        // row was re-read and the bootstrapTask path did not run (idempotent
        // existing-link case). Fail-closed: the guard now has the entry.
        try { publishChangeState?.(taskId, link.id, link.state); } catch { /* best-effort */ }
        return; // already linked — idempotent no-op
      }
      await bootstrapTask(taskId);
    } catch {
      // Bootstrap failure never poisons sibling reconciliation.
    } finally {
      inFlight.delete(taskId);
    }
  }

  async function reconcile() {
    const pageSize = 100;
    let offset = 0;
    for (;;) {
      let page;
      try {
        page = taskOrchestrator.list({ statuses: ACTIVE, limit: pageSize, offset });
      } catch {
        break; // store unavailable — the next notification or restart retries
      }
      const tasks = Array.isArray(page) ? page : [];
      if (tasks.length === 0) break;
      for (const task of tasks) {
        await bootstrapTaskSafe(task); // sequential per task; in-flight set converges duplicates
      }
      if (tasks.length < pageSize) break;
      offset += pageSize;
    }
  }

  function start() {
    if (dispose) return dispose; // already started — disposer is stable
    active = true;
    const cancel = taskOrchestrator.subscribe(() => {
      if (!active) return;
      void reconcile().catch(() => {}); // notification carries no payload — rescan
    });
    void reconcile().catch(() => {}); // startup rescan — recover from prior crash
    dispose = () => {
      active = false;
      if (typeof cancel === 'function') cancel();
      dispose = null;
    };
    return dispose;
  }

  return { start, reconcile };
}
