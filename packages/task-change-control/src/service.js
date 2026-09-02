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
 * @typedef {{ get: (id: string) => Promise<any>, findByWorkItem: (system: string, id: string) => Promise<any>, findOrCreateForWorkItem: (input: { system: string, id: string, change: object }) => Promise<any> }} ChangeControlApi
 * @param {object} deps
 * @param {() => TaskOrchestratorApi | undefined} deps.taskOrchestrator accessor (may be absent)
 * @param {() => ChangeControlApi | undefined} deps.changeControl accessor (may be absent)
 */
export function createTaskChangeControlService({ taskOrchestrator, changeControl }) {
  const requireTask = () => { const s = taskOrchestrator(); if (!s) throw unavailable('taskOrchestrator service not provided'); return s; };
  const requireChange = () => { const s = changeControl(); if (!s) throw unavailable('changeControl service not provided'); return s; };
  /** @param {string} taskId */
  const requireTaskId = (taskId) => {
    if (typeof taskId !== 'string' || taskId.trim() === '' || taskId !== taskId.trim()) {
      throw Object.assign(new Error('taskId is required and must be a non-blank string'), { code: 'INVALID_TASK_ID' });
    }
    return taskId;
  };

  const api = {
    /**
     * Resolve the Change for a task. Change-side workItem is authoritative;
     * the task metadata projection is a hint only. Returns the public Change
     * summary or null when unlinked.
     * @param {string} taskId
     * @returns {Promise<any | null>}
     */
    getChangeForTask(taskId) {
      requireTaskId(taskId);
      const t = requireTask();
      const c = requireChange();
      void t; // task service presence still required: drone ops must not half-work
      return (async () => {
        // Change-side workItem is the ONLY authoritative resolution. The task
        // metadata projection is a denormalized cache, never a fallback: a
        // stale or forged projection must not resolve to another task's
        // Change (or resurrect a terminal one).
        return c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
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
      requireTaskId(taskId);
      const t = requireTask();
      const c = requireChange();
      return (async () => {
        const change = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
        if (!change) {
          throw Object.assign(new Error(`no Change linked to task ${taskId}`), { code: 'TASK_NOT_LINKED' });
        }
        // Task Orchestrator service methods are synchronous (the facade
        // binds them directly); Promise.resolve normalizes either shape.
        // get() returns null for a missing task — surface a structured error
        // instead of dereferencing null mid-mutation.
        const task = await Promise.resolve(t.get(taskId));
        if (!task) {
          throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
        }
        const metadata = { ...(task.metadata ?? {}), changeControl: { ...(task.metadata?.changeControl ?? {}), changeId: change.id } };
        await Promise.resolve(t.update(taskId, { metadata }));
        return { taskId, changeId: change.id };
      })();
    },

    /**
     * Bootstrap a governed unit of work: snapshot the CANONICAL task record
     * (never caller-supplied content) into one linked Change in DRAFT, and
     * write the denormalized task-side projection. Idempotent.
     * Never approves a plan, never grants roles.
     * @param {string} taskId
     * @returns {Promise<{ change: any, snapshot: object }>}
     */
    bootstrapTask(taskId) {
      requireTaskId(taskId);
      const t = requireTask();
      const c = requireChange();
      return (async () => {
        // get() returns null for a missing task; genuine accessor errors
        // must propagate — never silently reclassified as TASK_NOT_FOUND.
        const task = await Promise.resolve(t.get(taskId));
        if (!task) {
          throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
        }
        // Snapshot ONLY from the canonical task record. No caller override
        // parameter exists — content below is deliberately task-only.
        const snapshot = {
          title: task.title,
          description: task.description ?? '',
          acceptance_criteria: [...(task.acceptance_criteria ?? [])],
          workspace: task.workspace ?? null,
          repo: task.repo ?? null,
          branch: task.branch ?? null,
          task_type: task.task_type ?? null,
          project_id: task.project_id ?? null,
          milestone_id: task.milestone_id ?? null,
        };
        // Lock-safe find-or-create owns the at-most-one-nonterminal invariant.
        const change = await c.findOrCreateForWorkItem({
          system: WORK_ITEM_SYSTEM,
          id: taskId,
          change: {
            title: snapshot.title,
            objective: snapshot.description || snapshot.title,
            acceptanceCriteria: snapshot.acceptance_criteria,
          },
        });
        // Denormalized projection (repairs drift; Change side stays canon).
        await api.linkTaskChange(taskId);
        return { change, snapshot };
      })();
    },

    /** True when both domain services are resolvable right now. */
    isAvailable() {
      return Boolean(taskOrchestrator() && changeControl());
    },
  };
  return Object.freeze(api);
}
