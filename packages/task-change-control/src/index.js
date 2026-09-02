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

    // Model-facing surface: exactly two tools, registered only when a tools
    // registry exists (probed defensively, same pattern as change-control's
    // host commands). Registry health errors fail loudly.
    const registry = ctx.get('tools');
    if (registry) {
      for (const tool of createIntegrationTools(service)) registry.register(tool);
    }
  },
};
