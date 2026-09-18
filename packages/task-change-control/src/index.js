import { createTaskChangeControlService, WORK_ITEM_SYSTEM } from './service.js';
import { createIntegrationTools } from './tools.js';
import { createLifecycleBootstrapper } from './lifecycle-bootstrap.js';
import { createAgentTeamsAdapter } from './agent-teams-adapter.js';
import { GOVERNED_COMPLETION_PENDING } from './g4-guard.js';

export { WORK_ITEM_SYSTEM };
export { createAgentTeamsAdapter };

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
    // G4 — sync authoritative Change-state snapshot owned by this activation.
    // The TaskStore lifecycle guard runs SYNC inside SQLite writes and cannot
    // await the async changeControl facade; the guard therefore consults this
    // Map<taskId, {changeId, state}>, populated from durable state at
    // activation and published by the approval/recovery lifecycle (the
    // convergence paths publish APPROVED immediately before their
    // in_review→done CAS, and review-settled refreshes keep it accurate).
    /** @type {Map<string, { changeId: string, state: string }>} */
    const changeStateSnapshotMap = new Map();
    const changeStateSnapshot = {
      /** @param {string} taskId @param {string} changeId @param {string} state */
      publish: (taskId, changeId, state) => {
        changeStateSnapshotMap.set(taskId, { changeId, state });
      },
      /** @param {string} taskId */
      remove: (taskId) => { changeStateSnapshotMap.delete(taskId); },
      /** @param {string} taskId @returns {{ changeId: string, state: string } | undefined} */
      get: (taskId) => changeStateSnapshotMap.get(taskId),
    };

    const service = createTaskChangeControlService({
      taskOrchestrator: () => ctx.get('taskOrchestrator'),
      changeControl: () => ctx.get('changeControl'),
      changeStateSnapshot,
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
        // G4: publish the terminal state into the sync snapshot so the
        // TaskStore lifecycle guard permits the convergence CAS below.
        changeStateSnapshot.publish(change.workItem.id, change.id, change.state);
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

      // Startup/restart recovery. Snapshot every relevant task ID before any
      // recovery mutation. This is intentionally one stable candidate set:
      // paging a result set while the controller changes its rows would skip
      // tasks after the first page. Each candidate is then re-read and CAS
      // reconciled against the authoritative Change state.
      const pageSize = 100;
      const recoveryTimers = new Map();
      /** @param {object} opts taskOrchestrator list options */
      const collectIds = async (opts) => {
        const ids = new Set();
        for (let offset = 0; ; offset += pageSize) {
          let page = [];
          try { page = (await Promise.resolve(orch.list({ ...opts, limit: pageSize, offset }))) ?? []; } catch { break; }
          for (const task of page) if (typeof task?.id === 'string') ids.add(task.id);
          if (page.length < pageSize) break;
        }
        return [...ids];
      };
      /** @param {string} id @returns {Promise<any>} */
      const taskFor = (id) => {
        try { return Promise.resolve(orch.get(id)); } catch (error) { return Promise.reject(error); }
      };
      /** @param {string} id @returns {Promise<any|null>} */
      const latestChangeFor = async (id) => {
        try {
          const all = await Promise.resolve(cc.listByWorkItem(WORK_ITEM_SYSTEM, id));
          return (Array.isArray(all) ? all : []).at(-1) ?? null;
        } catch { return null; }
      };
      /** @param {string} changeId @param {string} action @param {string} detail */
      const auditRecovery = async (changeId, action, detail) => {
        try {
          await Promise.resolve(cc.appendAudit({ kind: 'review_orchestration', changeId, action, detail }));
        } catch { /* recovery evidence is best-effort, state writes remain CAS */ }
      };
      /** @param {any} task */
      const releaseExpired = (task) => {
        if (!task || (task.status !== 'claimed' && task.status !== 'running')) return false;
        if (Number(task.lease_expires_at ?? 0) > Date.now()) return false;
        try {
          const released = orch.updateIf(
            task.id,
            { status: task.status, claimed_by: task.claimed_by, lease_expires_at: task.lease_expires_at },
            { status: 'ready' },
          );
          return Boolean(released);
        } catch { return false; }
      };
      /** @param {any} task @param {string} changeId */
      const scheduleLeaseRecovery = (task, changeId) => {
        if (!task || (task.status !== 'claimed' && task.status !== 'running')) return;
        if (recoveryTimers.has(task.id)) return;
        const expiresAt = Number(task.lease_expires_at);
        const delay = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now() + 1) : 0;
        const timer = /** @type {any} */ (setTimeout(async () => {
          recoveryTimers.delete(task.id);
          let current;
          try { current = await taskFor(task.id); } catch { return; }
          if (!current || (current.status !== 'claimed' && current.status !== 'running')) return;
          if (Number(current.lease_expires_at ?? 0) > Date.now()) {
            scheduleLeaseRecovery(current, changeId);
            return;
          }
          releaseExpired(current);
          try { await reconcileCandidate(task.id); } catch { /* next wake or restart retries */ }
        }, delay));
        timer.unref?.();
        recoveryTimers.set(task.id, timer);
      };
      /** @param {any} task @param {any} change @param {any} status */
      const recoverPartialRepair = async (task, change, status) => {
        const proof = status?.proof;
        const patch = proof && typeof proof === 'object'
          ? {
              status: 'in_review',
              commit_sha: proof.commit_sha,
              files_changed: Array.isArray(proof.files_changed) ? proof.files_changed : [],
              tests_run: Array.isArray(proof.tests_run) ? proof.tests_run : [],
              remaining_blockers: Array.isArray(proof.remaining_blockers) ? proof.remaining_blockers : [],
              result_summary: proof.summary ?? 'recovered repair proof for review',
            }
          : null;
        if (task.status === 'in_review') {
          await resumeTask(task.id);
          return;
        }
        if (task.status === 'claimed' || task.status === 'running') {
          if (Number(task.lease_expires_at ?? 0) > Date.now()) {
            scheduleLeaseRecovery(task, change.id);
            return;
          }
          if (patch) {
            try {
              const recovered = orch.updateIf(task.id, {
                status: task.status,
                claimed_by: task.claimed_by,
                lease_expires_at: task.lease_expires_at,
              }, patch);
              if (recovered) {
                await auditRecovery(change.id, 'repair_partial_recovered', 'recovered persisted repair proof after task-side crash');
                await resumeTask(task.id);
                return;
              }
            } catch { /* fall through to an explicit failed-closed audit */ }
          }
        }
        if (task.status === 'ready' || task.status === 'claimed' || task.status === 'running') {
          // A legacy partial commit may already have been released to ready.
          // There is no legal ready→in_review transition without a task claim;
          // fail it closed rather than silently reusing a proof against an
          // unknown task-side lease/criteria snapshot.
          try {
            const failed = orch.updateIf(task.id, { status: task.status }, {
              status: 'failed',
              result_summary: 'repair proof persisted but governed task completion was not recoverable',
            });
            if (failed) await auditRecovery(change.id, 'repair_partial_failed_closed', 'persisted PREFLIGHT repair proof had no safe task-side recovery');
          } catch { await auditRecovery(change.id, 'repair_partial_recovery_failed', 'task-side recovery mutation was rejected'); }
        }
      };
      /** @param {string} id */
      async function reconcileCandidate(id) {
        /** @type {any} */
        let task;
        try { task = await taskFor(id); } catch { return; }
        if (!task) return;
        const change = await latestChangeFor(id);
        if (!change) return;
        if (change.state === 'APPROVED') {
          if (task.status === 'in_review') {
            // G4: publish the authoritative APPROVED state into the sync
            // snapshot so the TaskStore lifecycle guard permits the
            // in_review→done CAS, then converge directly (bypasses the
            // full runGovernedSdlc loop for the terminal path).
            changeStateSnapshot.publish(id, change.id, 'APPROVED');
            const converged = orch.updateIf(id, { status: 'in_review' }, { status: 'done' });
            if (converged) {
              try { await cc.appendAudit({ kind: 'reconciliation', changeId: change.id, action: 'g4_terminal_converged_restart' }); } catch { /* best-effort */ }
            }
          }
          return;
        }
        if (change.state === 'REPAIR') {
          if (task.status === 'claimed' || task.status === 'running') {
            if (Number(task.lease_expires_at ?? 0) <= Date.now()) {
              releaseExpired(task);
              task = await taskFor(id).catch(() => task);
            } else {
              scheduleLeaseRecovery(task, change.id);
              return;
            }
          }
          if (task.status === 'in_review' || task.status === 'changes_requested' || task.status === 'ready') await resumeTask(id);
          return;
        }
        if (change.state === 'REVIEW') {
          // T-H12 round-5 (F1): an unsettled review across a controller
          // restart must resume — re-reading durable state reattaches turn
          // observation to the round's persisted session (never completing
          // the round from binding alone).
          if (task.status === 'in_review') await resumeTask(id);
          return;
        }
        if (change.state === 'PREFLIGHT') {
          let status = null;
          try { status = await Promise.resolve(cc.status(change.id)); } catch { return; }
          const attempts = Array.isArray(status?.attempts) ? status.attempts : [];
          if (attempts.at(-1)?.status === 'repair_submitted') await recoverPartialRepair(task, change, status);
        }
      }

      // Fire-and-forget recovery; every candidate is isolated so one malformed
      // task or synchronous facade error cannot abort the remaining scan.
      (async () => {
        const candidateIds = await collectIds({ statuses: ['in_review', 'changes_requested', 'ready', 'claimed', 'running'] });
        for (const id of candidateIds) {
          try { await reconcileCandidate(id); } catch { /* next candidate owns its retry */ }
        }
      })();

      return () => {
        if (typeof disposed === 'function') disposed();
        // T-H12 round-5 (F1): a disposing controller stops recovering the
        // reviewer turns it observed — the fresh (restarted) host owns them.
        try { service.stopReviewerObservation?.(); } catch { /* best-effort */ }
        for (const timer of recoveryTimers.values()) clearTimeout(timer);
        recoveryTimers.clear();
      };
    });

    // G2 — lifecycle auto-bootstrap: governed tasks that enter an active
    // state (ready/claimed/running/in_review) get exactly one linked Change
    // without a captain bootstrap call. Subscribes to the store's notification
    // channel (no event payload) and rescans persisted tasks; reconciles
    // active tasks on startup. The disposer returned by start() un-subscribes
    // on plugin teardown, matching the plugin activation lifetime.
    // Mocks or test hosts that provide a taskOrchestrator facade without
    // subscribe() (e.g. worker-binding tests) degrade to no-op.
    await ctx.inject(['taskOrchestrator', 'changeControl'], (c) => {
      const orch = c.get('taskOrchestrator');
      const cc = c.get('changeControl');
      if (!orch || !cc) throw new Error('taskOrchestrator/changeControl inactive in the G2 bootstrap fiber');
      if (typeof orch.subscribe !== 'function') return () => {};
      const controller = createLifecycleBootstrapper({
        taskOrchestrator: orch,
        changeControl: cc,
        bootstrapTask: service.bootstrapTask.bind(service),
        publishChangeState: (/** @type {string} */ taskId, /** @type {string} */ changeId, /** @type {string} */ state) => {
          changeStateSnapshot.publish(taskId, changeId, state);
        },
      });
      const dispose = controller.start();
      return () => { if (typeof dispose === 'function') dispose(); };
    });

    // G4 — governed completion guard: register ONE sync lifecycle guard per
    // activation on the TaskStore. The guard denies every transition to
    // 'done' while the task's linked Change is not APPROVED, consulting the
    // activation-owned sync snapshot (no sync-over-async; no Change Control
    // import ever reaches task-orchestrator source). The H11 convergence
    // fiber below publishes APPROVED into the snapshot immediately before its
    // in_review→done CAS, so the convergence write always passes.
    await ctx.inject(['taskOrchestrator', 'changeControl'], async (c) => {
      const orch = c.get('taskOrchestrator');
      const cc = c.get('changeControl');
      if (!orch || !cc || typeof orch.registerLifecycleGuard !== 'function') {
        // Loud, structured failure: when a governance linkage already exists
        // (changeStateSnapshotMap is non-empty) but the Task Orchestrator
        // facade lacks the registerLifecycleGuard seam, the G4 guard cannot
        // be installed. Throw — never silently degrade.
        if (changeStateSnapshotMap.size > 0) {
          /** @type {Error & { code?: string }} */
          const err = new Error(
            'G4 lifecycle guard seam (orch.registerLifecycleGuard) absent while a Change linkage exists; governance cannot be enforced'
          );
          err.code = 'G4_LIFECYCLE_GUARD_UNAVAILABLE';
          throw err;
        }
        return () => {};
      }

      /** @param {{ task: { id: string }, currentStatus: string, nextStatus: string, context: object }} event */
      const guard = (event) => {
        if (event.nextStatus !== 'done' && event.nextStatus !== 'completed') return undefined;
        const entry = changeStateSnapshot.get(event.task.id);
        if (!entry) return undefined; // ungoverned task — no snapshot entry
        if (entry.state === 'APPROVED') return undefined; // terminal-approved → allow
        return {
          allowed: false,
          code: GOVERNED_COMPLETION_PENDING,
          reason: 'task ' + event.task.id + ' is governed; Change ' + entry.changeId + ' is ' + entry.state + ', not APPROVED',
          message: 'governed completion pending: Change ' + entry.changeId + ' must reach APPROVED before task ' + event.task.id + ' can complete',
          evidence: { changeId: entry.changeId, changeState: entry.state },
        };
      };

      const unregisterGuard = orch.registerLifecycleGuard(guard);

      // Populate from durable Change state so a fresh composition is
      // authoritative from the first guard evaluation (covers restart
      // recovery: persisted APPROVED repairs a still-open task).
      const populate = async () => {
        const statuses = ['in_review', 'changes_requested', 'ready', 'claimed', 'running'];
        for (let offset = 0; ; offset += 100) {
          let page = [];
          try { page = (await Promise.resolve(orch.list({ statuses, limit: 100, offset }))) ?? []; } catch { break; }
          for (const task of page) {
            const taskId = task?.id;
            if (typeof taskId !== 'string') continue;
            let change = null;
            try { change = await cc.findByWorkItem(WORK_ITEM_SYSTEM, taskId); } catch { /* best-effort */ }
            if (!change) {
              try {
                const all = await cc.listByWorkItem(WORK_ITEM_SYSTEM, taskId);
                if (Array.isArray(all) && all.length > 0) change = all[all.length - 1];
              } catch { /* best-effort */ }
            }
            if (change) changeStateSnapshot.publish(taskId, change.id, change.state);
            else changeStateSnapshot.remove(taskId);
          }
          if (page.length < 100) break;
        }
      };
      // G4 terminal convergence: after populating the snapshot, repair any
      // in_review task whose Change is already APPROVED so a fresh
      // composition is authoritative without waiting for the H11 IIFE.
      const convergeTerminal = async () => {
        const statuses = ['in_review'];
        for (let offset = 0; ; offset += 100) {
          let page = [];
          try { page = (await Promise.resolve(orch.list({ statuses, limit: 100, offset }))) ?? []; } catch { break; }
          for (const task of page) {
            const taskId = task?.id;
            if (typeof taskId !== 'string') continue;
            let change = null;
            try { change = await cc.findByWorkItem(WORK_ITEM_SYSTEM, taskId); } catch { /* best-effort */ }
            if (!change) {
              try {
                const all = await cc.listByWorkItem(WORK_ITEM_SYSTEM, taskId);
                if (Array.isArray(all) && all.length > 0) change = all[all.length - 1];
              } catch { /* best-effort */ }
            }
            if (change && change.state === 'APPROVED') {
              changeStateSnapshot.publish(taskId, change.id, 'APPROVED');
              const converged = orch.updateIf(taskId, { status: 'in_review' }, { status: 'done' });
              if (converged) {
                try { await cc.appendAudit({ kind: 'reconciliation', changeId: change.id, action: 'g4_terminal_converged_compose' }); } catch { /* best-effort */ }
              }
            }
          }
          if (page.length < 100) break;
        }
      };
      // Await populate + convergence so the composition itself is the
      // repair mechanism (not a fire-and-forget IIFE racing setImmediate).
      await populate();
      await convergeTerminal();

      // Refresh on review settlement so the snapshot tracks durable state
      // after APPROVED / REPAIR transitions (event is emitted only after
      // the durable REVIEW→APPROVED|REPAIR persistence).
      const disposeEvents = ctx.events.on('change-control/review-settled', /** @param {any} payload */ async (payload) => {
        if (!payload?.changeId) return;
        try {
          const change = await cc.get(payload.changeId);
          if (!change?.workItem || change.workItem.system !== WORK_ITEM_SYSTEM) return;
          changeStateSnapshot.publish(change.workItem.id, change.id, change.state);
        } catch { /* snapshot refresh is best-effort */ }
      });

      return () => {
        unregisterGuard();
        if (typeof disposeEvents === 'function') disposeEvents();
      };
    });

    // G3 — optional AgentTeams lifecycle adapter: bridges public AgentTeams
    // session/task events into Change Control role bindings and append-only
    // audit evidence. Parked behind the same injection boundary as G2;
    // service absence never blocks plugin startup, and reactivation creates
    // one fresh adapter per activation.
    await ctx.inject(['agentTeamsLifecycle', 'changeControl'], (c) => {
      const lifecycle = c.get('agentTeamsLifecycle');
      const cc = c.get('changeControl');
      if (!lifecycle || !cc) return () => {};
      const adapter = createAgentTeamsAdapter({ agentTeamsLifecycle: lifecycle, changeControl: cc });
      return () => { adapter.dispose(); };
    });
  },
};
