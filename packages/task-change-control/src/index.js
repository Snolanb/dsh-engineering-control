import { createTaskChangeControlService, WORK_ITEM_SYSTEM } from './service.js';
import { createIntegrationTools } from './tools.js';

export { WORK_ITEM_SYSTEM };

/**
 * T9.1 — mandatory-governance task-context provider.
 *
 * Resolves sessionId → governed task context through the Change-side bindings
 * graph ONLY (session → role binding → Change → canonical work item):
 *   { changeId, taskId, taskStatus, role } | null
 * A Change whose workItem.system is not the canonical WORK_ITEM_SYSTEM is not
 * a Task Orchestrator task, so taskId resolves to null (denied downstream).
 *
 * Exported as a factory so the plugin and boundary tests construct the same
 * provider without reaching across the ChangeStore package boundary.
 *
 * @param {object} deps
 * @param {() => any} deps.taskOrchestrator accessor for the Task Orchestrator service (may resolve undefined)
 * @param {() => any} deps.changeControl accessor for the changeControl facade (may resolve undefined)
 */
export function createMandatoryGovernanceProvider({ taskOrchestrator, changeControl }) {
  return {
    /** @param {{ sessionId: string }} input */
    async lookup({ sessionId }) {
      const cc = changeControl();
      if (!cc || typeof cc.listRoleBindings !== 'function') return null;
      const bindings = await cc.listRoleBindings();
      const hit = bindings.find((/** @type {any} */ b) => b.sessionId === sessionId);
      if (!hit) return null;
      const change = await cc.get(hit.changeId);
      const taskId = change?.workItem?.system === WORK_ITEM_SYSTEM ? change.workItem.id : null;
      const t = taskOrchestrator();
      let taskStatus = null;
      if (taskId && t && typeof t.get === 'function') {
        const task = await t.get(taskId);
        taskStatus = task?.status ?? null;
      }
      return { changeId: hit.changeId, taskId, taskStatus, role: hit.role };
    },
  };
}

/**
 * Task ↔ Change integration plugin.
 *
 * Backstop design rule: dsh-task-orchestrator and dsh-change-control each
 * remain fully functional when this package is absent. This plugin therefore
 * injects NOTHING hard: it probes both domain services lazily so it can load
 * in partial compositions and degrade per-linkage (LINKAGE_UNAVAILABLE)
 * rather than blocking host startup.
 */
export default {
  name: 'dsh-task-change-control',
  inject: [],
  /** @param {import('@deepseek-ai/cordis').Context} ctx */
  async apply(ctx) {
    const service = createTaskChangeControlService({
      taskOrchestrator: () => ctx.get('taskOrchestrator'),
      changeControl: () => ctx.get('changeControl'),
    });
    ctx.provide('taskChangeControl', service);

    // T9.1 — mandatory governance provider: resolves sessionId → task
    // context using the bindings graph (session → change → workItem).
    // Install only when the change-control facade exposes the hook
    // (older/static change-control compositions ignore this).
    const changeControl = ctx.get('changeControl');
    if (changeControl && typeof changeControl.registerGovernanceProvider === 'function') {
      changeControl.registerGovernanceProvider(createMandatoryGovernanceProvider({
        taskOrchestrator: () => ctx.get('taskOrchestrator'),
        changeControl: () => ctx.get('changeControl'),
      }));
    }

    // Model-facing surface: exactly two tools, registered only when a tools
    // registry exists (probed defensively, same pattern as change-control's
    // host commands). Registry health errors fail loudly.
    const registry = ctx.get('tools');
    if (registry) {
      for (const tool of createIntegrationTools(service)) registry.register(tool);
    }
  },
};
