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
 * injects NOTHING hard: it loads in partial compositions, provides
 * taskChangeControl immediately, and wires every OPTIONAL surface through a
 * parked Cordis inject fiber instead of a startup-time probe. Each fiber runs
 * only once its service exists (including late arrival), and Cordis
 * unloads/re-runs it on service removal/re-addition — registering exactly
 * once per activation and disposing on teardown, with no polling. Linkage
 * operations degrade per-call (LINKAGE_UNAVAILABLE) while a domain service is
 * missing rather than blocking host startup.
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

    // Model-facing surface: exactly two tools, wired to the tools registry's
    // lifecycle. Absent at startup → nothing; late registry → registered;
    // registry removal/unload → disposed; re-addition → one fresh
    // registration. tools.register is itself fiber-effect scoped, so Cordis
    // removes the tools with this activation automatically.
    await ctx.inject(['tools'], (c) => {
      const registry = c.get('tools');
      if (!registry) throw new Error('tools service inactive in its own inject fiber');
      for (const tool of createIntegrationTools(service)) registry.register(tool);
    });

    // T9.1 — mandatory governance provider: resolves sessionId → task
    // context using the bindings graph (session → change → workItem).
    // Installed only while the change-control facade exposes the hook; the
    // returned unregister is this activation's teardown effect, so removal or
    // plugin unload clears the in-memory provider and re-addition installs
    // exactly one fresh instance.
    await ctx.inject(['changeControl'], (c) => {
      const changeControl = c.get('changeControl');
      if (!changeControl) throw new Error('changeControl service inactive in its own inject fiber');
      if (typeof changeControl.registerGovernanceProvider !== 'function') return;
      const { unregister } = changeControl.registerGovernanceProvider(createMandatoryGovernanceProvider({
        taskOrchestrator: () => ctx.get('taskOrchestrator'),
        changeControl: () => ctx.get('changeControl'),
      }));
      return () => { if (typeof unregister === 'function') unregister(); };
    });

    // T-H11 — automatic reviewer-settlement wake-up. When both domain
    // services are present (the real governed composition), subscribe to the
    // change-control review-settled event and resume the controller with NO
    // model-supplied verdict: runGovernedSdlc re-reads the persisted
    // Task/Change pair and converges APPROVED→done / REPAIR→changes_requested
    // from durable state. Convergence is CAS/idempotent (updateIf), so
    // duplicate/concurrent deliveries settle exactly once. Started in the
    // same fiber, a crash AFTER review persistence but BEFORE task
    // convergence is recovered at startup by re-scanning every in_review
    // task whose Change already advanced. No polling: native lifecycle events
    // plus one persisted-state scan per service activation.
    await ctx.inject(['taskOrchestrator', 'changeControl'], (c) => {
      const cc = c.get('changeControl');
      const orch = c.get('taskOrchestrator');
      if (!cc || !orch) throw new Error('taskOrchestrator/changeControl inactive in the H11 wake fiber');

      const converge = async (changeId) => {
        // Resolve the authoritative task from the Change-side work item (the
        // canonical linkage), then resume the controller with no verdict.
        let change;
        try { change = await cc.get(changeId); } catch { return; }
        if (!change?.workItem || change.workItem.system !== WORK_ITEM_SYSTEM) return;
        try { await service.runGovernedSdlc(change.workItem.id, {}); } catch { /* resumable; converge on next wake */ }
      };

      const disposed = ctx.events.on('change-control/review-settled', (payload) => {
        if (payload && typeof payload.changeId === 'string') converge(payload.changeId);
      });

      // Startup/restart recovery: resume in_review tasks whose Change already
      // advanced past REVIEW (persisted post-crash). Idempotent — runGovernedSdlc
      // re-reads and CAS-converges; a task that is still legitimately in REVIEW
      // is left alone (its Change state is REVIEW, not APPROVED/REPAIR).
      // Fire-and-forget: the fiber's teardown only unsubscribes the listener.
      (async () => {
        let tasks = [];
        try { tasks = orch.list({ in_review: true, limit: 500 }) ?? []; } catch { return; }
        for (const task of tasks) {
          const all = await cc.listByWorkItem(WORK_ITEM_SYSTEM, task.id).catch(() => []);
          const change = (Array.isArray(all) ? all : []).at(-1);
          if (change && (change.state === 'APPROVED' || change.state === 'REPAIR')) {
            try { await service.runGovernedSdlc(task.id, {}); } catch { /* resumable */ }
          }
        }
      })();

      return () => {
        if (typeof disposed === 'function') disposed();
      };
    });
  },
};
