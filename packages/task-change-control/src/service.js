/**
 * taskChangeControl integration service.
 *
 * Sole operations this phase: project the authoritative Change-side linkage
 * into task metadata, and resolve task → Change with the Change side canonical.
 * No TaskStore/ChangeStore imports here — only the two Cordis services.
 */
import { createGovernanceGuard } from './governance.js';
import { createBindingLauncher } from './binding.js';
import { validatePairing } from './lifecycle.js';

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
 * @typedef {{ get: (id: string) => any, update: (id: string, patch: any) => Promise<any>, updateIf: (id: string, expected: any, patch: any) => any, complete?: (id: string, result: object, options?: any) => any, createDispatcher: (options?: any) => any, createWorkerLauncher?: (options?: any) => any, createReviewerLauncher?: (options?: any) => any }} TaskOrchestratorApi
 * @typedef {{ get: (id: string) => Promise<any>, findByWorkItem: (system: string, id: string) => Promise<any>, findOrCreateForWorkItem: (input: { system: string, id: string, change: object }) => Promise<any>, resolveRole: (changeId: string, sessionId: string) => Promise<string>, getBinding: (changeId: string, sessionId: string) => Promise<any>, getBindingSync: (changeId: string, sessionId: string) => any, getBindingFromDisk: (changeId: string, sessionId: string) => any, listByWorkItem: (system: string, id: string) => Promise<any[]>, listRoleBindings: () => Promise<any[]>, status: (changeId: string) => Promise<any>, appendAudit: (event: any) => Promise<any>, submitProof: (changeId: string, proof: any, expected?: { sessionId?: string, expectedWorker?: string }) => Promise<any>, bindRole: (changeId: string, sessionId: string, role: string, opts?: any) => Promise<any>, unbindRole: (changeId: string, sessionId: string, opts?: any) => Promise<any>, transition: (changeId: string, toState: string, opts?: any) => Promise<any> }} ChangeControlApi
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

    /**
     * Build a WorkerDispatcher wired with the governance guard. The dispatcher
     * is constructed through taskOrchestrator.createDispatcher — no store
     * access here, only service composition.
     * @param {Record<string, any> & { preDispatch?: (input: any) => Promise<any> }} [options] dispatcher constructor overrides
     */
    createGovernedDispatcher(options = {}) {
      const t = requireTask();
      const c = requireChange();
      if (typeof t.createDispatcher !== 'function') {
        throw unavailable('taskOrchestrator.createDispatcher not provided');
      }
      const integrationGuard = createGovernanceGuard(c, WORK_ITEM_SYSTEM);
      // Governance is not replaceable: a caller-supplied preDispatch COMPOSES
      // after the integration guard — the governed-check can never be bypassed.
      const userGuard = options.preDispatch;
      // T6.1: ALWAYS wrap the launcher with the binding hook. The wrapper
      // binds the returned sessionId ('worker' role) on successful launch and
      // unbinds on finally-after-wait AND terminate — even if the caller
      // passes their own launcher (they get a wrapped one, behavior visible
      // in audit, not in spec).
      // T6.1: ALWAYS bind — caller-supplied launcher, or the service's own
      // default launcher factory (createWorkerLauncher on the taskOrchestrator
      // service — service boundary preserved).
      const baseLauncher = options.launcher
        ?? (typeof t.createWorkerLauncher === 'function'
          ? t.createWorkerLauncher(options.launcherOptions ?? {})
          : null);
      if (!baseLauncher) throw unavailable('taskOrchestrator exposes neither a launcher hook nor a fallback');
      return t.createDispatcher({
        ...options,
        launcher: createBindingLauncher(baseLauncher, c, WORK_ITEM_SYSTEM),
        preDispatch: userGuard
          ? async (/** @type {any} */ input) => {
              const mandatory = await integrationGuard(input);
              if (mandatory.ok === false) return mandatory;
              return userGuard(input);
            }
          : integrationGuard,
      });
    },

    /**
     * T7.1 — Governed completion pipeline.
     * Validates: active lease (owner matches), worker Change binding for the
     * given sessionId, then submits Change-side proof, then moves the task to
     * in_review with the matching commit/files/tests/blockers. Idempotent —
     * repeat calls converge without duplicate proof events.
     *
     * @param {string} taskId
     * @param {{ sessionId: string, worker: string, proof: object }} input
     */
    completeGovernedTask(taskId, /** @type {{ sessionId: string, worker: string, proof: any }} */ input) {
      const taskOrchestrator = requireTask();
      const c = requireChange();
      return (async () => {
        if (typeof taskId !== 'string' || taskId.trim() === '') {
          throw Object.assign(new Error('taskId is required'), { code: 'INVALID_TASK_ID' });
        }
        if (!input || typeof input !== 'object') {
          throw Object.assign(new Error(`completeGovernedTask input is required for ${taskId}`), { code: 'INVALID_INPUT' });
        }
        const sessionId = input.sessionId;
        const worker = input.worker;
        const proof = input.proof ?? {};
        if (typeof sessionId !== 'string' || sessionId.trim() === '') {
          throw Object.assign(new Error('sessionId is required'), { code: 'INVALID_SESSION' });
        }
        if (typeof worker !== 'string' || worker.trim() === '') {
          throw Object.assign(new Error('worker is required'), { code: 'INVALID_WORKER' });
        }
        const task = await Promise.resolve(taskOrchestrator.get(taskId));
        if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });

        // Idempotency fast-path: already converged → return ok without mutation.
        if (task.status === 'in_review') {
          const existingLink = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
          if (existingLink) {
            const existing = await c.get(existingLink.id);
            if (existing.state === 'PREFLIGHT') {
              // The completion already converged. Verify the stored proof
              // matches THIS caller's payload on the integration fields —
              // identical ok, different → PROOF_MISMATCH (retry after a
              // legit repair retry should agree with the stored proof).
              const s = await c.status(existingLink.id).catch(() => null);
              const stored = s && s.proof ? s.proof : null;
              const equal = stored
                && stored.commit_sha === proof.commit_sha
                && JSON.stringify(stored.files_changed) === JSON.stringify(proof.files_changed)
                && JSON.stringify(stored.tests_run) === JSON.stringify(proof.tests_run)
                && JSON.stringify(stored.remaining_blockers) === JSON.stringify(proof.remaining_blockers);
              if (!equal) {
                throw Object.assign(
                  new Error(`stored Change proof does not match the completion payload`),
                  { code: 'PROOF_MISMATCH', changeId: existingLink.id },
                );
              }
              return { ok: true, taskId, changeId: existingLink.id };
            }
          }
        }

        // LEASE CHECK FIRST — never consult Change state on an unprepared task.
        if (task.status !== 'claimed' && task.status !== 'running') {
          throw Object.assign(new Error(`task not claim-held: status=${task.status}`), { code: 'TASK_LEASE_INVALID' });
        }
        if (task.claimed_by !== worker) {
          throw Object.assign(new Error(`task is claimed by ${task.claimed_by}, not ${worker}`), { code: 'TASK_LEASE_INVALID' });
        }
        if (Number(task.lease_expires_at ?? 0) <= Date.now()) {
          throw Object.assign(new Error('task claim lease has expired'), { code: 'TASK_LEASE_INVALID' });
        }

        const changed = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
        if (!changed) throw Object.assign(new Error(`no Change linked for ${taskId}`), { code: 'WORK_ITEM_NOT_LINKED' });

        // 2. Session must be bound as worker on this Change.
        let binding = null;
        try {
          binding = await c.getBinding(changed.id, sessionId);
        } catch (error) {
          throw Object.assign(
            new Error(`session ${sessionId} is not bound as worker`),
            { code: 'SESSION_NOT_BOUND', cause: error },
          );
        }
        if (!binding || binding.role !== 'worker') {
          throw Object.assign(new Error(`session ${sessionId} is not bound as worker`), { code: 'SESSION_NOT_BOUND' });
        }
        // T7.1 fix for F2: the binding's remembered worker identity must be
        // the dispatcher's claimed worker — otherwise the session-swap attack
        // (worker:A completes with sessionId bound to worker:B) passes.
        if (binding.worker !== worker) {
          throw Object.assign(
            new Error(`session ${sessionId} belongs to ${binding.worker}, not ${worker}`),
            { code: 'SESSION_WORKER_MISMATCH', changeId: changed.id },
          );
        }

        // 3a. Alignment fields are mandatory BEFORE any Change mutation:
        // the Change-side proof and the final task row MUST carry identical
        // values. Omitting them yields task rows of null/[] next to a proof
        // without the keys (or, on the idempotent path, a stale proof).
        for (const key of ['commit_sha', 'files_changed', 'tests_run', 'remaining_blockers']) {
          const value = proof[key];
          if (!(key in proof)) {
            throw Object.assign(
              new Error(`proof.${key} required`),
              { code: 'PROOF_FIELD_REQUIRED', field: key },
            );
          }
          if (key === 'commit_sha') continue; // further typed check below
          if (!Array.isArray(value)) {
            throw Object.assign(
              new Error(`proof.${key} must be an array`),
              { code: 'PROOF_FIELD_INVALID', field: key, got: value === null ? 'null' : typeof value },
            );
          }
          for (const entry of value) {
            if (typeof entry !== 'string') {
              throw Object.assign(
                new Error(`proof.${key}[*] must be strings`),
                { code: 'PROOF_FIELD_INVALID', field: key, got: typeof entry },
              );
            }
          }
        }
        const commitSha = proof.commit_sha;
        if (typeof commitSha !== 'string' || commitSha.trim() === '') {
          throw Object.assign(
            new Error('proof.commit_sha must be a string'),
            { code: 'PROOF_FIELD_INVALID', field: 'commit_sha', got: typeof proof.commit_sha },
          );
        }

        // 3b. Criteria alignment — re-read the task FIRST so a concurrent
        // acceptance_criteria mutation (F5 race) cannot pass a stale
        // baseline through the proof.
        {
          const liveTask = await Promise.resolve(taskOrchestrator.get(taskId));
          if (!liveTask) throw Object.assign(new Error('task missing at proof time'), { code: 'TASK_NOT_FOUND' });
          const taskCriteria = Array.isArray(liveTask.acceptance_criteria) ? liveTask.acceptance_criteria : [];
          const taskIds = new Set(taskCriteria.map(String));
          const proofIds = new Set((proof.criteria ?? []).map(/** @param {any} c */ (c) => (c && typeof c === 'object' ? c.id : c)));
          if (taskIds.size !== proofIds.size || [...taskIds].some((id) => !proofIds.has(id))) {
            throw Object.assign(
              new Error(`proof criteria do not match task acceptance_criteria`),
              { code: 'CRITERIA_MISMATCH', task: [...taskIds], proof: [...proofIds] },
            );
          }
        }

        // 3c. Idempotent Change transition. For PREFLIGHT the stored proof
        // MUST equal the caller's proof on the four integration fields —
        // any mismatch means the prior submission persisted a stale proof.
        const change = await c.get(changed.id);
        if (change.state === 'IMPLEMENTING') {
          await c.submitProof(changed.id, { ...proof, sessionId }, { sessionId, expectedWorker: worker });
        } else if (change.state === 'PREFLIGHT') {
          const statusSnapshot = await c.status(changed.id).catch(() => null);
          const existing = statusSnapshot && statusSnapshot.proof ? statusSnapshot.proof : null;
          const same = existing
            && existing.commit_sha === proof.commit_sha
            && JSON.stringify(existing.files_changed) === JSON.stringify(proof.files_changed)
            && JSON.stringify(existing.tests_run) === JSON.stringify(proof.tests_run)
            && JSON.stringify(existing.remaining_blockers) === JSON.stringify(proof.remaining_blockers);
          if (!same) {
            throw Object.assign(
              new Error(`stored Change proof differs from the current completion payload`),
              { code: 'PROOF_MISMATCH', changeId: changed.id },
            );
          }
        } else {
          throw Object.assign(new Error(`cannot complete from Change state ${change.state}`), { code: 'INVALID_STATE' });
        }

        // 4b. FINAL CONSISTENCY CHECK. Order matters: the Change-side
        // `getBinding` await is the LAST cross-store await — after this,
        // the TaskStore get + complete are synchronous, so an interleaving
        // mutation of task criteria MUST happen before re-reads, and
        // the final binding snapshot arrives post-lock.
        // SYNC fresh-disk read: ChangeStore.getBindingFromDisk reads the
        // store file synchronously (readFileSync), so even a cross-instance
        // mutation by a different ChangeStore on the same JSON file is
        // observed AT THE READ, before TaskStore.complete (also sync).
        const finalBinding = c.getBindingFromDisk(changed.id, sessionId);
        if (!finalBinding || finalBinding.role !== 'worker' || finalBinding.worker !== worker) {
          throw Object.assign(
            new Error(`session binding changed during Change-side work`),
            { code: 'SESSION_WORKER_MISMATCH', changeId: changed.id },
          );
        }

        // Synchronous from here on — the TaskStore facade is sync, so
        // get() followed by criteria/lease verification followed by
        // complete() serializes atomically in this event-loop tick.
        const finalTask = taskOrchestrator.get(taskId);
        if (!finalTask
          || finalTask.claimed_by !== worker
          || (finalTask.status !== 'claimed' && finalTask.status !== 'running')
          || Number(finalTask.lease_expires_at ?? 0) <= Date.now()) {
          throw Object.assign(
            new Error('lease invalidated during Change-side work'),
            { code: 'TASK_LEASE_INVALID', stage: 'post-proof' },
          );
        }
        {
          const taskIds = new Set((Array.isArray(finalTask.acceptance_criteria) ? finalTask.acceptance_criteria : []).map(String));
          const proofIds = new Set((proof.criteria ?? []).map(/** @param {any} c */ (c) => (c && typeof c === 'object' ? c.id : c)));
          if (taskIds.size !== proofIds.size || [...taskIds].some((id) => !proofIds.has(id))) {
            throw Object.assign(
              new Error(`task acceptance criteria changed during completion`),
              { code: 'CRITERIA_MISMATCH', task: [...taskIds] },
            );
          }
        }

        // 4c. Perform task completion via complete() — owner-checked by the
        // TaskStore. If this throws the Change is PREFLIGHT and the task is
        // still running; report as RECOVERABLE_PARTIAL for reconciliation.
        try {
          await Promise.resolve(taskOrchestrator.complete?.(taskId, {
            result_summary: proof.summary ?? proof.title ?? 'governed completion',
            commit_sha: proof.commit_sha,
            files_changed: proof.files_changed,
            tests_run: proof.tests_run,
            remaining_blockers: proof.remaining_blockers,
          }, { worker }));
          if (typeof taskOrchestrator.complete !== 'function') {
            throw Object.assign(new Error('taskOrchestrator.complete missing'), { code: 'INCOMPLETE_FACADE' });
          }
        } catch (error) {
          throw Object.assign(
            new Error(`task completion failed after proof: ${error instanceof Error ? error.message : String(error)}`),
            { code: 'GOVERNED_COMPLETION_PARTIAL', changeId: changed.id, cause: error },
          );
        }
        return { ok: true, taskId, changeId: changed.id };
      })();
    },

    /**
     * T8.1 — Launch an independent REVIEWER session for a governed task.
     * The session is bound to the authoritative Change as role 'reviewer'
     * using the sessionId returned by the launcher (the REAL identity).
     * This path never claims the task and never touches worker leases.
     *
     * @param {string} taskId
     * @param {{ spec?: object, launcherOptions?: object }} [options]
     */
    launchReviewer(taskId, options = {}) {
      const t = requireTask();
      const c = requireChange();
      requireTaskId(taskId);
      if (typeof t.createReviewerLauncher !== 'function') {
        return Promise.reject(Object.assign(
          new Error('taskOrchestrator facade does not expose createReviewerLauncher'),
          { code: 'REVIEWER_LAUNCHER_UNAVAILABLE' },
        ));
      }
      return (async () => {
        const task = await Promise.resolve(t.get(taskId));
        if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
        const change = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
        if (!change) throw Object.assign(new Error(`no Change linked to task ${taskId}`), { code: 'CHANGE_NOT_FOUND' });
        const launcher = /** @type {any} */ (t).createReviewerLauncher(options.launcherOptions ?? {});
        const defaultPrompt = `You are the independent reviewer for task ${task.id}.
Review the governed Change ${change.id} against its Plan and project task acceptance criteria. Read-only: do NOT modify any files. Inspect the worker's submitted proof and test log and decide PASS / FAIL / ESCALATE with a brief rationale.`;
        const spec = options.spec ?? {
          mode: 'session',
          prompt: defaultPrompt,
          agentPreset: task.reviewer_profile ?? 'reviewer',
          // Parse 'provider/model' convention, same as worker_model elsewhere;
          // bare 'model' leaves provider undefined and DSH host resolution fills
          // it at session.selectModel time.
          ...(typeof task.reviewer_model === 'string' && task.reviewer_model !== ''
            ? (() => {
                const s = task.reviewer_model;
                const slash = s.indexOf('/');
                if (slash < 1 || slash === s.length - 1) {
                  throw Object.assign(
                    new Error(`reviewer_model must be 'provider/model' (got: ${s})`),
                    { code: 'REVIEWER_MODEL_MALFORMED' },
                  );
                }
                return { model: { provider: s.slice(0, slash), model: s.slice(slash + 1) } };
              })()
            : {}),
        };
        const handle = await launcher.launch({ task, spec });
        if (typeof handle?.sessionId !== 'string' || handle.sessionId === '') {
          if (typeof handle?.terminate === 'function') {
            try { await handle.terminate(); } catch { /* best-effort */ }
          }
          throw Object.assign(new Error('reviewer launcher returned no sessionId'), { code: 'SESSION_ID_MISSING' });
        }
        let binding;
        try {
          binding = await c.bindRole(change.id, handle.sessionId, 'reviewer');
        } catch (error) {
          // If binding fails the session would be orphaned: terminate it so
          // there is no live reviewer session with no track record on the
          // Change side.
          if (typeof handle?.terminate === 'function') {
            try { await handle.terminate(); } catch { /* best-effort */ }
          }
          throw error;
        }
        return { sessionId: handle.sessionId, changeId: change.id, binding, handle };
      })();
    },

    /**
     * T7.2 — Reconciliation between the task orchestrator and the Change Control
     * side. Provably SAFE drift is repaired (with audit); anything else is
     * reported as manualIntervention and the stores stay untouched.
     */
    reconcileTaskChange(/** @type {string} */ taskId) {
      const t = requireTask();
      const c = requireChange();
      requireTaskId(taskId);
      return (async () => {
        const repairs = /** @type {any[]} */ ([]);
        const manualIntervention = /** @type {any[]} */ ([]);
        const task = await Promise.resolve(t.get(taskId));
        if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });

        const allChanges = await c.listByWorkItem(WORK_ITEM_SYSTEM, taskId);
        const nonTerminal = allChanges.filter((/** @type {any} */ chg) => !['APPROVED', 'REJECTED', 'CANCELLED'].includes(chg.state));
        if (nonTerminal.length > 1) {
          manualIntervention.push({ issue: 'MULTIPLE_CHANGES', changeIds: nonTerminal.map((c2) => c2.id) });
          return { repairs, manualIntervention };
        }
        const change = nonTerminal[0] ?? allChanges[0] ?? null;
        if (!change) return { repairs, manualIntervention };

        const status = await c.status(change.id);
        const proof = status?.proof ?? null;
        const bindings = (await c.listRoleBindings()).filter((/** @type {any} */ b) => b.changeId === change.id);
        const linkage = task?.metadata?.changeControl?.changeId ?? null;

        // ── Phase 1: compile manual findings from the snapshot. No writes
        // happen above this point.
        const leaseExpired = Number(task.lease_expires_at ?? 0) <= Date.now();
        const isHalfCompletionShape = (task.status === 'claimed' || task.status === 'running') && change.state === 'PREFLIGHT' && leaseExpired;
        // The HALF-COMPLETION shape is the specific lifecycle pairing that
        // T7.2 repairs — refuse to also bark LIFECYCLE_MISMATCH for it.
        const pairing = isHalfCompletionShape ? { ok: true } : validatePairing(task.status, change.state);
        if (!pairing.ok) {
          manualIntervention.push({ issue: 'LIFECYCLE_MISMATCH', taskId, taskStatus: task.status, changeState: change.state });
        }
        const hasResult = Boolean(
          task.result_summary || task.commit_sha
          || (Array.isArray(task.files_changed) && task.files_changed.length)
          || (Array.isArray(task.tests_run) && task.tests_run.length)
          || (Array.isArray(task.remaining_blockers) && task.remaining_blockers.length),
        );
        const proofComplete = proof
          && typeof proof.commit_sha === 'string' && proof.commit_sha.trim() !== ''
          && Array.isArray(proof.files_changed)
          && Array.isArray(proof.tests_run)
          && Array.isArray(proof.remaining_blockers);
        if (task.status === 'in_review' && !proof && hasResult) {
          manualIntervention.push({ issue: 'TASK_RESULT_WITHOUT_PROOF', taskId });
        }
        if (proof && !proofComplete) {
          manualIntervention.push({ issue: 'PROOF_ALIGNMENT_INCOMPLETE', taskId, detail: 'proof missing or mis-typed commit/files/tests/blockers' });
        }

        // R1 orphaned worker bindings on terminal tasks.
        if (['in_review', 'done', 'cancelled', 'failed'].includes(task.status)) {
          for (const b of bindings) {
            if (b.role !== 'worker') continue;
            try {
              await c.unbindRole(change.id, b.sessionId, { actor: 'reconciliation' });
            } catch (/** @type {any} */ error) {
              // Race-tolerant concurrency: if someone else beat us to the
              // unbind, the postcondition check proves the change actually
              // landed. A FAILURE in the postcondition read itself means the
              // observable state is unknown — surface manual attention instead
              // of claiming a repair.
              let still = null;
              try {
                still = await c.getBinding(change.id, b.sessionId);
              } catch (/** @type {any} */ postReadError) {
                manualIntervention.push({
                  issue: 'UNBIND_FAILED', taskId,
                  detail: `post-condition read failed after unbind error: ${postReadError?.message ?? String(postReadError)}`,
                });
                return { repairs, manualIntervention };
              }
              if (still !== null) {
                manualIntervention.push({
                  issue: 'UNBIND_FAILED', taskId,
                  detail: error?.message ?? String(error),
                });
                return { repairs, manualIntervention };
              }
            }
            await c.appendAudit({ kind: 'reconciliation', changeId: change.id, sessionId: b.sessionId, action: 'orphan_binding_unbound' });
            repairs.push({ kind: 'orphan_binding_unbound', sessionId: b.sessionId });
          }
        }


        // ── Phase 2: repairs (only when no manual findings).
        if (manualIntervention.length > 0) return { repairs, manualIntervention };

        // R0 linkage / projection repair — runs for ANY task whose stored
        // metadata.details.changeControl.changeId does not match the
        // Change-side workItem (including missing/null metadata); the
        // integration task owns this pointer.
        if (linkage !== change.id) {
          const patched = t.updateIf(
            taskId,
            { metadata_change_id: linkage },
            { metadata: (/** @type {any} */ liveMeta) => ({
                ...(liveMeta && typeof liveMeta === 'object' ? liveMeta : {}),
                changeControl: { ...(liveMeta?.changeControl ?? {}), changeId: change.id },
              }) },
          );
          if (patched) {
            await c.appendAudit({ kind: 'reconciliation', changeId: change.id, action: 'projection_linkage', previousChangeId: linkage });
            repairs.push({ kind: 'projection_linkage', previousChangeId: linkage, correctedTo: change.id });
          }
        }

        // R2 half-completed governed completion (expired lease, Change PREFLIGHT).
        const now = Date.now();
        if ((task.status === 'claimed' || task.status === 'running')
          && Number(task.lease_expires_at ?? 0) <= now
          && change.state === 'PREFLIGHT' && proofComplete) {
          const converged = t.updateIf(
            taskId,
            { claimed_by: task.claimed_by, lease_expires_at: task.lease_expires_at, status: task.status },
            {
              status: 'in_review',
              commit_sha: proof.commit_sha,
              files_changed: proof.files_changed,
              tests_run: proof.tests_run,
              remaining_blockers: proof.remaining_blockers,
              result_summary: proof.summary ?? 'reconciled completion',
            },
          );
          if (!converged) {
            manualIntervention.push({ issue: 'RECONCILE_RACE', taskId, detail: 'claim changed concurrently; skipped' });
            return { repairs, manualIntervention };
          }
          await c.appendAudit({ kind: 'reconciliation', changeId: change.id, action: 'half_completion_converged' });
          repairs.push({ kind: 'half_completion_converged' });
        }

        // R3 projection mismatch on completed task.
        if (task.status === 'in_review' && proofComplete) {
          const mismatch =
            task.commit_sha !== proof.commit_sha
            || JSON.stringify(task.files_changed) !== JSON.stringify(proof.files_changed)
            || JSON.stringify(task.tests_run) !== JSON.stringify(proof.tests_run)
            || JSON.stringify(task.remaining_blockers) !== JSON.stringify(proof.remaining_blockers);
          if (mismatch) {
            const patched = t.updateIf(taskId, { status: 'in_review', metadata_change_id: task?.metadata?.changeControl?.changeId ?? null }, {
              commit_sha: proof.commit_sha,
              files_changed: proof.files_changed,
              tests_run: proof.tests_run,
              remaining_blockers: proof.remaining_blockers,
              result_summary: proof.summary ?? task.result_summary,
            });
            if (patched) {
              await c.appendAudit({ kind: 'reconciliation', changeId: change.id, action: 'projection_realigned' });
              repairs.push({ kind: 'projection_mismatch' });
            }
          }
        }

        return { repairs, manualIntervention };
      })();
    },

    /** True when both domain services are resolvable right now. */
    isAvailable() {
      return Boolean(taskOrchestrator() && changeControl());
    },
  };
  return Object.freeze(api);
}
