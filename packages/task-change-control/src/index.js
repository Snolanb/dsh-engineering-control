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
    // duplicate/concurrent deliveries settle exactly once. Durable persisted
    // state (not the in-memory event) is the recovery source: a crash at ANY
    // FAIL-stage point (in_review, changes_requested, ready, or an expired
    // claimed/running repair) is reconciled at startup by a paginated scan
    // over every relevant task status. No polling: native lifecycle events
    // plus one persisted-state scan per service activation.
    await ctx.inject(['taskOrchestrator', 'changeControl'], (c) => {
      const cc = c.get('changeControl');
      const orch = c.get('taskOrchestrator');
      if (!cc || !orch) throw new Error('taskOrchestrator/changeControl inactive in the H11 wake fiber');

      /** @param {string} changeId */
      const converge = async (changeId) => {
        // Resolve the authoritative task from the Change-side work item (the
        // canonical linkage), then resume the controller with no verdict.
        let change;
        try { change = await cc.get(changeId); } catch { return; }
        if (!change?.workItem || change.workItem.system !== WORK_ITEM_SYSTEM) return;
        await resumeTask(change.workItem.id);
      };

      /** @param {string} taskId */
      const resumeTask = async (taskId) => {
        // runGovernedSdlc is idempotent/resumable (re-reads persisted state,
        // CAS-converges via updateIf) — a throw leaves the durable state
        // untouched, so the next wake or restart retries rather than strands.
        try {
          await service.runGovernedSdlc(taskId, {});
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          // Best-effort audit so a failed convergence is not invisible; never
          // re-throw (the event dispatch must not disrupt other listeners).
          try {
            const link = await cc.findByWorkItem(WORK_ITEM_SYSTEM, taskId).catch(() => null)
              ?? (await cc.listByWorkItem(WORK_ITEM_SYSTEM, taskId).catch(() => []))?.at?.(-1);
            if (link) await cc.appendAudit({ kind: 'review_orchestration', changeId: link.id, action: 'review_wake_failed', detail });
          } catch { /* audit is best-effort */ }
        }
      };

      const disposed = ctx.events.on('change-control/review-settled', (payload) => {
        if (payload && typeof payload.changeId === 'string') converge(payload.changeId);
      });

      // Startup/restart recovery. Paginate each scan until a short page is
      // returned so every relevant row is examined (no 500-row cap). Cover the
      // full FAIL-stage task surface — in_review (APPROVED|REPAIR) plus
      // changes_requested/ready (REPAIR) plus expired claimed/running repair
      // claims (REPAIR) — and CAS-reconcile each through the idempotent
      // controller. Per-task failure is isolated (cannot strand or duplicate:
      // t.claim/updateIf are the single writers).
      const pageSize = 100;
      /** @param {object} opts taskOrchestrator list options (statuses|in_review|expired_claims) */
      const scanAndResume = async (opts) => {
        for (let offset = 0; ; offset += pageSize) {
          let page = [];
          try { page = (await orch.list({ ...opts, limit: pageSize, offset })) ?? []; } catch { return; }
          for (const task of page) {
            await resumeTask(task.id);
          }
          if (page.length < pageSize) break;
        }
      };
      // Fire-and-forget recovery; the fiber's teardown only unsubscribes the listener.
      (async () => {
        // 1. in_review → Change APPROVED (PASS) or REPAIR (FAIL) persisted.
        await scanAndResume({ in_review: true });
        // 2. FAIL settled to changes_requested / prepared to ready, Change REPAIR.
        await scanAndResume({ statuses: ['changes_requested', 'ready'] });
        // 3. Expired repair claims (claimed/running past their lease), Change REPAIR:
        //    CAS-reset to ready so the controller re-claims, never re-runs a dead lease.
        for (let offset = 0; ; offset += pageSize) {
          let page = [];
          try { page = (await orch.list({ expired_claims: true, limit: pageSize, offset })) ?? []; } catch { break; }
          for (const task of page) {
            const all = await cc.listByWorkItem(WORK_ITEM_SYSTEM, task.id).catch(() => []);
            const change = (Array.isArray(all) ? all : []).at(-1);
            if (change && change.state === 'REPAIR') {
              // Only release OUR observed expired lease (CAS on claimed_by+status+lease).
              try {
                orch.updateIf(task.id, { status: task.status, claimed_by: task.claimed_by, lease_expires_at: task.lease_expires_at }, { status: 'ready' });
              } catch { /* still-claimed by a live owner → leave untouched */ }
              await resumeTask(task.id);
            }
          }
          if (page.length < pageSize) break;
        }
      })();

      return () => {
        if (typeof disposed === 'function') disposed();
      };
    });
  },
};
