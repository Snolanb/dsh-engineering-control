// @ts-nocheck — defineTool's ValueSchemaSpec genrics don't map onto JSDoc; same convention as dsh-change-control src/tools.
import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * The entire model-facing integration surface: exactly two tools.
 * No generic change_create/change_bind will ever exist here — creation and
 * role binding are host/controller responsibilities only.
 *
 * @param {{ getChangeForTask: Function, bootstrapTask: Function }} service the taskChangeControl service
 */
export function createIntegrationTools(service) {
  const out = { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v };
  return [
    defineTool({
      name: 'change_for_task',
      description: 'Resolve the Change linked to a Task Orchestrator task. Never fabricates: unlinked tasks return a structured not-linked result.',
      parameters: { taskId: { type: 'string' } },
      output: out,
      execute: async (args) => {
        if (typeof args?.taskId !== 'string' || args.taskId.trim() === '') {
          throw Object.assign(new Error('taskId is required and must be a string'), { code: 'INVALID_TASK_ID' });
        }
        const change = await service.getChangeForTask(args.taskId);
        return change ? { linked: true, taskId: args.taskId, change } : { linked: false, taskId: args.taskId, change: null };
      },
    }),
    defineTool({
      name: 'change_bootstrap_task',
      description: 'Bootstrap a governed Change for a Task Orchestrator task. Snapshots the canonical task record into a DRAFT Change linked to the task. Idempotent; never approves plans or grants roles.',
      parameters: { taskId: { type: 'string' } },
      output: out,
      execute: async (args) => {
        if (typeof args?.taskId !== 'string' || args.taskId.trim() === '') {
          throw Object.assign(new Error('taskId is required and must be a string'), { code: 'INVALID_TASK_ID' });
        }
        return service.bootstrapTask(args.taskId);
      },
    }),
  ];
}
