import { createTaskChangeControlService } from './service.js';
import { createIntegrationTools } from './tools.js';

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
      changeControl.registerGovernanceProvider({
        lookup: async (/** @type {{sessionId: string}} */ { sessionId }) => {
          const bindings = await changeControl.listRoleBindings();
          const hit = bindings.find((/** @type {any} */ b) => b.sessionId === sessionId);
          if (!hit) return null;
          const change = await changeControl.get(hit.changeId);
          const taskId = change?.workItem?.system === 'task-orchestrator' ? change.workItem.id : null;
          const t = ctx.get('taskOrchestrator');
          let taskStatus = null;
          if (taskId && t && typeof t.get === 'function') {
            const task = await t.get(taskId);
            taskStatus = task?.status ?? null;
          }
          return { changeId: hit.changeId, taskId, taskStatus, role: hit.role };
        },
      });
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
