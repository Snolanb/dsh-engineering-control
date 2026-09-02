/**
 * taskChangeControl integration service.
 *
 * Sole operations this phase: project the authoritative Change-side linkage
 * into task metadata, and resolve task → Change with the Change side canonical.
 * No TaskStore/ChangeStore imports here — only the two Cordis services.
 */

/** The task-orchestrator identity on the Change-side workItem. */
export const WORK_ITEM_SYSTEM = 'dsh-task-orchestrator';

/**
 * @param {string} detail
 * @returns {Error & { code: 'LINKAGE_UNAVAILABLE' }}
 */
function unavailable(detail) {
  return Object.assign(
    new Error(`taskChangeControl linkage unavailable: ${detail}`),
    /** @type {{ code: 'LINKAGE_UNAVAILABLE' }} */({ code: 'LINKAGE_UNAVAILABLE' }),
  );
}

/**
 * Minimal typed views of the two domain services this package depends on.
 * @typedef {{ get: (id: string) => Promise<any>, update: (id: string, patch: any) => Promise<any> }} TaskOrchestratorApi
 * @typedef {{ get: (id: string) => Promise<any>, findByWorkItem: (system: string, id: string) => Promise<any> }} ChangeControlApi
 * @param {object} deps
 * @param {() => TaskOrchestratorApi | undefined} deps.taskOrchestrator accessor (may be absent)
 * @param {() => ChangeControlApi | undefined} deps.changeControl accessor (may be absent)
 */
export function createTaskChangeControlService({ taskOrchestrator, changeControl }) {
  const requireTask = () => { const s = taskOrchestrator(); if (!s) throw unavailable('taskOrchestrator service not provided'); return s; };
  const requireChange = () => { const s = changeControl(); if (!s) throw unavailable('changeControl service not provided'); return s; };

  const api = {
    /**
     * Resolve the Change for a task. Change-side workItem is authoritative;
     * the task metadata projection is a hint only. Returns the public Change
     * summary or null when unlinked.
     * @param {string} taskId
     * @returns {Promise<any | null>}
     */
    getChangeForTask(taskId) {
      const t = requireTask();
      const c = requireChange();
      return (async () => {
        const byWorkItem = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
        if (byWorkItem) return byWorkItem;
        const task = await t.get(taskId).catch(() => null);
        const hinted = task?.metadata?.changeControl?.changeId;
        if (!hinted) return null;
        return c.get(hinted).catch(() => null);
      })();
    },

    /**
     * Project the authoritative linkage into task metadata. Idempotent;
     * repairs a stale projection. Throws TASK_NOT_LINKED when no Change-side
     * workItem exists for the task (linkage is Change-owned).
     * @param {string} taskId
     * @returns {Promise<{ taskId: string, changeId: string }>}
     */
    linkTaskChange(taskId) {
      const t = requireTask();
      const c = requireChange();
      return (async () => {
        const change = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
        if (!change) {
          throw Object.assign(new Error(`no Change linked to task ${taskId}`), { code: 'TASK_NOT_LINKED' });
        }
        const task = await t.get(taskId);
        const metadata = { ...(task.metadata ?? {}), changeControl: { ...(task.metadata?.changeControl ?? {}), changeId: change.id } };
        await t.update(taskId, { metadata });
        return { taskId, changeId: change.id };
      })();
    },

    /** True when both domain services are resolvable right now. */
    isAvailable() {
      return Boolean(taskOrchestrator() && changeControl());
    },
  };
  return Object.freeze(api);
}
