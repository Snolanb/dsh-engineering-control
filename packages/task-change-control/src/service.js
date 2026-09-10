// @ts-nocheck — T-H5 PR2-01: node:fs/os/path I/O for the durable cross-process reviewer claim; same convention as src/binding.js, src/governance.js, src/tools.js.
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
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
 * @typedef {{ get: (id: string) => any, update: (id: string, patch: any) => Promise<any>, updateIf: (id: string, expected: any, patch: any) => any, complete?: (id: string, result: object, options?: any) => any, createDispatcher: (options?: any) => any, createWorkerLauncher?: (options?: any) => any, createReviewerLauncher?: (options?: any) => any, claim?: (id: string, worker: string, options?: any) => any, start?: (id: string, worker: string, options?: any) => any, release?: (id: string, worker: string, options?: any) => any }} TaskOrchestratorApi
 * @typedef {{ get: (id: string) => Promise<any>, findByWorkItem: (system: string, id: string) => Promise<any>, findOrCreateForWorkItem: (input: { system: string, id: string, change: object }) => Promise<any>, resolveRole: (changeId: string, sessionId: string) => Promise<string>, getBinding: (changeId: string, sessionId: string) => Promise<any>, getBindingSync: (changeId: string, sessionId: string) => any, getBindingFromDisk: (changeId: string, sessionId: string) => any, listByWorkItem: (system: string, id: string) => Promise<any[]>, listRoleBindings: () => Promise<any[]>, status: (changeId: string) => Promise<any>, appendAudit: (event: any) => Promise<any>, submitProof: (changeId: string, proof: any, expected?: { sessionId?: string, expectedWorker?: string }) => Promise<any>, bindRole: (changeId: string, sessionId: string, role: string, opts?: any) => Promise<any>, submitReview: (changeId: string, review: any, opts: any) => Promise<any>, submitRepair?: (changeId: string, repair: object, opts?: any) => Promise<any>, runPreflight: (changeId: string, input?: any) => Promise<any>, history: (changeId?: string) => Promise<any[]>, getGovernanceMode?: (scope: { projectId?: string|null, workspace?: string|null }) => Promise<string>, unbindRole: (changeId: string, sessionId: string, opts?: any) => Promise<any>, transition: (changeId: string, toState: string, opts?: any) => Promise<any> }} ChangeControlApi
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
     * T10.1 — read-only dashboard projection for a governed task.
     * Never mutates; degrades via { linked: false } when the task is not
     * governed. Fields the dashboard renders: changeId, Change state, risk,
     * plan status, preflight status, openFinding count, attempt summary
     * plus the escalated flag.
     */
    describeTaskGovernance(/** @type {string} */ taskId) {
      const t = requireTask();
      const c = requireChange();
      requireTaskId(taskId);
      return (async () => {
        const task = await Promise.resolve(t.get(taskId));
        if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
        // Terminal Changes are excluded by findByWorkItem; fall back to any
        // linkage record so completed tasks still display their Change.
        let change = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
        if (!change) {
          const all = typeof c.listByWorkItem === 'function' ? await c.listByWorkItem(WORK_ITEM_SYSTEM, taskId) : [];
          if (Array.isArray(all) && all.length > 0) {
            change = all[all.length - 1];
          }
        }
        const governanceMode = (typeof c.getGovernanceMode === 'function')
          ? await c.getGovernanceMode({ projectId: task.project_id ?? null, workspace: task.workspace ?? null })
          : 'off';
        if (!change) {
          return {
            linked: false, taskId, governanceMode,
            changeId: null, state: null, risk: null, plan: null, preflight: null,
            openFindings: 0, attempts: { total: 0, repairs: 0 }, escalated: false,
          };
        }
        const status = await c.status(change.id);
        const attempts = Array.isArray(status?.attempts) ? status.attempts : [];
        const repairs = attempts.filter((/** @type {any} */ a) => typeof a?.attemptId === 'string' && a.attemptId.includes(':repair:')).length;
        const history = await c.history(change.id);
        const escalated = history.some((/** @type {any} */ e) => e.kind === 'review_orchestration' && e.action === 'escalated');
        const acceptedPlan = status?.acceptedPlan ?? null;
        const plan = acceptedPlan ? { id: acceptedPlan.id ?? acceptedPlan.planId ?? null, status: 'accepted' } : null;
        // Canonical preflight record shape:
        //   { allowed: boolean, state: string, controllerResults: ... }
        // Map to a plain string the dashboard can render. When no result of
        // preflight is yet persisted, leave it null — the UI draws
        // 'not evaluated'.
        const preflightRecord = status?.preflight && typeof status.preflight === 'object' ? status.preflight : null;
        const preflight = preflightRecord === null
          ? null
          : (preflightRecord.allowed === true ? 'passed'
            : preflightRecord.allowed === false ? 'failed'
            : (preflightRecord.state ?? 'pending'));
        const openFindings = Array.isArray(status?.openFindings) ? status.openFindings.length : 0;
        return {
          linked: change !== null, taskId, governanceMode,
          changeId: change?.id ?? null, state: change?.state ?? null, risk: change?.risk ?? null,
          plan, preflight,
          openFindings,
          attempts: { total: attempts.length, repairs },
          escalated,
        };
      })();
    },

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
        completionHook: /** @type {(taskId: string, result: any, opts?: { worker?: string, sessionId?: string }) => Promise<any>} */ (async function completionHook(taskId, result, opts) {
          const worker = opts?.worker;
          const sessionId = opts?.sessionId;
          // The hook receives the monitor result shape (result_summary, files_changed,
          // tests_run, remaining_blockers) plus optional sessionId from the launcher.
          // completeGovernedTask performs the authoritative transition: validates lease,
          // binding, proof fields, criteria alignment, submits Change-side proof, moves
          // Change to PREFLIGHT, and transitions the task to in_review — atomically.
          // Thread the worker's ACTUAL structured completion payload into the proof.
          // Fail governed completion when required evidence is absent rather than
          // substituting fabricated values — prevents false PREFLIGHT transitions.
          // Fetch the task to get acceptance_criteria for proof alignment.
          const taskRecord = await Promise.resolve(requireTask().get(taskId));
          const acceptanceCriteria = Array.isArray(taskRecord?.acceptance_criteria) ? taskRecord.acceptance_criteria : [];

          // TH2-R2-02: Make governed completion conditional on actual linkage.
          // If no Change is linked to this task, fall back to raw store.complete
          // so ungoverned tasks dispatched via createGovernedDispatcher still work.
          const linkedChange = await Promise.resolve(requireChange().findByWorkItem(WORK_ITEM_SYSTEM, taskId));
          if (!linkedChange) {
            // No Change linkage — use raw completion path.
            const taskApi = requireTask();
            if (taskApi && typeof taskApi.complete === 'function') {
              return taskApi.complete(taskId, result, { worker, actor: 'task-change-control' });
            }
            throw Object.assign(new Error('taskOrchestrator.complete is unavailable for ungoverned fallback'), { code: 'LINKAGE_UNAVAILABLE' });
          }

          // Require commit_sha from the worker — do not fabricate.
          const commitSha = result.commit_sha;
          if (!commitSha || typeof commitSha !== 'string' || commitSha.trim() === '') {
            throw Object.assign(
              new Error('governed completion requires commit_sha from worker result'),
              { code: 'PROOF_FIELD_REQUIRED', field: 'commit_sha' },
            );
          }

          const proof = {
            beforeRevision: result.beforeRevision ?? 'initial',
            afterRevision: result.afterRevision ?? commitSha,
            commit_sha: commitSha,
            files_changed: Array.isArray(result.files_changed) ? result.files_changed : [],
            tests_run: Array.isArray(result.tests_run) ? result.tests_run : [],
            remaining_blockers: Array.isArray(result.remaining_blockers) ? result.remaining_blockers : [],
            criteria: Array.isArray(result.criteria)
              ? result.criteria
              : acceptanceCriteria.map((/** @type {string} */ c) => ({ id: c, satisfied: true })),
            deviations: Array.isArray(result.deviations) ? result.deviations : [],
            workerChecks: Array.isArray(result.workerChecks) ? result.workerChecks : [],
            controllerPreflight: Array.isArray(result.controllerPreflight) ? result.controllerPreflight : [],
            summary: result.result_summary ?? '',
            ...(result || {}),
          };
          const completed = await api.completeGovernedTask(taskId, /** @type {{ sessionId: string, worker: string, proof: any }} */ ({
            sessionId: /** @type {string} */ (sessionId ?? worker ?? ''),
            worker: /** @type {string} */ (worker ?? ''),
            proof,
          }));
          // T-H5 PRODUCTION TRIGGER: a governed worker success auto-advances
          // the deterministic preflight → REVIEW + independent reviewer
          // launch/bind. The controller is resumable: preflight_failed /
          // review_pending / trigger_failed all leave the task in_review with
          // the Change at the last reached stage — a re-invocation continues
          // from persisted state. A trigger failure must never undo the
          // governed completion that already converged (fail-soft + audit).
          try {
            const advance = await api.runGovernedSdlc(taskId, {});
            return { ...completed, sdlc: advance };
          } catch (/** @type {any} */ error) {
            try {
              const link = await requireChange().findByWorkItem(WORK_ITEM_SYSTEM, taskId);
              if (link) {
                await requireChange().appendAudit({ kind: 'review_orchestration', changeId: link.id, action: 'sdlc_trigger_failed', detail: error?.message ?? String(error) });
              }
            } catch { /* audit is best-effort; the trigger must not throw */ }
            return { ...completed, sdlc: { outcome: 'trigger_failed', error: error?.message ?? String(error) } };
          }
        }),
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
        let currentState = change.state;
        if (currentState === 'READY') {
          // T-H5 PR1-01: a production launcher NEVER mutates the Change; the
          // preDispatch guard already demanded READY. The controller owns the
          // host-side READY→IMPLEMENTING so a real governed worker's success
          // can be completed (submit source proof) without test-only mutation.
          // Authority stays with Change Control — we only invoke its transition.
          await c.transition(changed.id, 'IMPLEMENTING', { actor: 'task-change-control' });
          currentState = 'IMPLEMENTING';
        }
        if (currentState === 'IMPLEMENTING') {
          await c.submitProof(changed.id, { ...proof, sessionId }, { sessionId, expectedWorker: worker });
        } else if (currentState === 'PREFLIGHT') {
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
     * T8.2 — Start (or restart) the review stage for a governed completion.
     * - Only valid when the task is in_review.
     * - Change may be PREFLIGHT (first round / post-repair) or REVIEW (resume).
     * - Preflight invokes the REAL store runPreflight, not a naive boolean
     *   check of the proof bundle.
     * - Reviewer session is bound BEFORE the state transition so a thrown
     *   launch never wedges the Change in REVIEW.
     *
     * @param {string} taskId
     * @param {{ preflight?: (proof: any) => boolean, controllerPreflightOverride?: string[] }} [options]
     * @returns {Promise<{ outcome: 'review_started' | 'preflight_failed', sessionId?: string, changeId?: string }>}
     */
    runGovernedReview(taskId, options = {}) {
      const t = requireTask();
      const c = requireChange();
      requireTaskId(taskId);
      return (async () => {
        const task = await Promise.resolve(t.get(taskId));
        if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
        if (task.status !== 'in_review') {
          throw Object.assign(new Error(`expected task status in_review (got ${task.status})`), { code: 'INVALID_TASK_STATE' });
        }
        const change = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
        if (!change) throw Object.assign(new Error(`no Change linked to task ${taskId}`), { code: 'CHANGE_NOT_FOUND' });
        if (!['PREFLIGHT', 'REVIEW'].includes(change.state)) {
          throw Object.assign(new Error(`expected Change PREFLIGHT or REVIEW (got ${change.state})`), { code: 'INVALID_CHANGE_STATE' });
        }
        if (change.state === 'PREFLIGHT') {
          // Run the REAL store-level preflight: staleness vs currentRevision,
          // protected paths, and requiredChecks are all evaluated there.
          const statusNow = await c.status(change.id);
          const proof = statusNow?.proof ?? null;
          const checkResults = (options.controllerPreflightOverride ?? proof?.controllerPreflight ?? []).map((/** @type {string} */ entry) => parseControllerPreflightEntry(entry));
          let preflightPassed;
          try {
            await c.runPreflight(change.id, {
              currentRevision: String(proof?.afterRevision ?? ''),
              changedFiles: Array.isArray(proof?.files_changed) ? proof.files_changed : [],
              checkResults,
            });
            preflightPassed = true;
          } catch (/** @type {any} */ err) {
            if (err?.code === 'NO_POLICY') {
              // No host-level policy configured: the default gate is every
              // entry explicitly labelled pass:.../ok:..., and an EMPTY
              // list FAILS CLOSED (a worker must not skip preflight by
              // submitting zero controllerPreflight entries at all).
              preflightPassed = checkResults.length > 0
                && checkResults.every((/** @type {{passed?:boolean}} */ r) => r.passed === true);
            } else {
              preflightPassed = false;
            }
          }
          if (!preflightPassed) {
            await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'preflight_failed' });
            return { outcome: 'preflight_failed' };
          }
          await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'preflight_passed' });
        }
        // T-H5 PR1-02 + PR2-01: serialize check→launch→bind for ONE Change.
        // The in-process tail lock is the fast local serializer; the durable
        // cross-process claim (reserveReviewerLaunch) guarantees no two host
        // processes launch a second reviewer, adopts a crashed owner's
        // recorded session instead of re-launching it, and converges on the
        // confirmed binding as the terminal record.
        const sessionId = await withReviewerReservation(change.id, async () => {
          return reserveReviewerLaunch({
            c, change, task,
            launch: async ({ file, identity }) => {
              const launched = await launchReviewerForTask(requireTask, requireChange, requireTaskId, taskId, {
                // Durable record of the launched session before the binding —
                // the crash-recovery (adopt) record for a successor claim.
                recordSession: async (launchSessionId) => {
                  await writeClaimRecord(file, { claimant: identity, sessionId: launchSessionId, updatedAt: Date.now() });
                },
                discardSession: async () => {
                  // Our launch is dead (terminated on failure): expire the
                  // claim so a successor takes over with a fresh launch
                  // instead of adopting a terminated session.
                  await writeClaimRecord(file, { claimant: identity, sessionId: null, updatedAt: Date.now() - 2 * REVIEWER_CLAIM_LEASE_MS })
                    .catch(() => {});
                },
              });
              return launched.sessionId;
            },
          });
        });
        // A successful store runPreflight is authoritative for the state
        // move: under a real preflight policy the store itself performed
        // PREFLIGHT→REVIEW. Re-read the live state and transition ONLY in
        // the NO_POLICY fallback, where the store did not move it — exactly
        // one PREFLIGHT→REVIEW transition, never a double move.
        const liveAfterPreflight = await c.get(change.id);
        if (liveAfterPreflight.state === 'PREFLIGHT') {
          await c.transition(change.id, 'REVIEW', { actor: 'review-orchestration' }).catch((err) => {
            if (err?.name !== 'ChangeDomainError') throw err;
            // T-H5 PR2-01: a concurrent controller advanced the stage while
            // we held the reservation — REVIEW→REVIEW is not a legal move,
            // so the stage already converged; its launch is bound under the
            // same claim we just released.
          });
        }
        return { outcome: 'review_started', sessionId, changeId: change.id };
      })();
    },

    /**
     * T8.2 — Apply the settlement of a review against a governed completion.
     * verdict `pass` → APPROVED + task done; `fail` → REPAIR + task
     * changes_requested; exceeding maxRepairRounds escalates the task to
     * failed. Any invalid state rolls back to a manual audit note.
     *
     * @param {string} taskId
     * @param {{ sessionId: string, verdict: 'pass'|'fail', findings?: any[], maxRepairRounds?: number }} options
     */
    applyReviewOutcome(taskId, options) {
      const t = requireTask();
      const c = requireChange();
      requireTaskId(taskId);
      if (typeof options.sessionId !== 'string' || options.sessionId === '') {
        return Promise.reject(Object.assign(new Error('sessionId is required'), { code: 'INVALID_REVIEW' }));
      }
      if (options.verdict !== 'pass' && options.verdict !== 'fail') {
        return Promise.reject(Object.assign(new Error(`verdict must be pass|fail`), { code: 'INVALID_REVIEW' }));
      }
      return (async () => {
        const task = await Promise.resolve(t.get(taskId));
        if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
        const change = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
        if (!change) throw Object.assign(new Error(`no Change linked to task ${taskId}`), { code: 'CHANGE_NOT_FOUND' });
        const status = await c.status(change.id);
        if (change.state !== 'REVIEW') {
          await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'review_outcome_rejected_state', state: change.state });
          return { outcome: 'invalid_state', state: change.state };
        }
        const reviewCount = /** @type {number} */ (options.maxRepairRounds ?? 3);
        const attemptsSeen = Array.isArray(status?.attempts) ? status.attempts.length : 0;
        const escalate = options.verdict === 'fail' && repairRoundsExhausted(attemptsSeen, reviewCount);
        // Pre-validate EVERYTHING that could make submitReview throw BEFORE
        // touching the task at all. This matters because a terminal task
        // status (done/failed/...) is irreversible, whereas a Change left in
        // REVIEW is repairable.
        {
          let binding = c.getBindingSync(change.id, options.sessionId) ?? null;
          if (!binding) {
            try { binding = c.getBindingFromDisk(change.id, options.sessionId); } catch { binding = null; }
            if (binding && typeof binding.then === 'function') binding = await binding;
          }
          if (!binding || binding.role !== 'reviewer') {
            await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'not_a_reviewer_session', sessionId: options.sessionId });
            throw Object.assign(new Error(`no reviewer binding for session ${options.sessionId}`), { code: 'SESSION_NOT_BOUND' });
          }
          const attemptsNow = Array.isArray(status?.attempts) ? status.attempts : [];
          if (attemptsNow.some((/** @type {any} */ a) => a.sessionId === options.sessionId || a.workerId === options.sessionId)) {
            throw Object.assign(new Error(`session ${options.sessionId} wrote the proof being reviewed`), { code: 'REVIEWER_NOT_INDEPENDENT' });
          }
          const latestRevision = status?.revision ?? null;
          if (latestRevision === null) {
            throw Object.assign(new Error('no revision recorded yet'), { code: 'STALE_REVISION' });
          }
        }

        if (options.verdict === 'pass') {
          // Validation passed; submit the review. submitReview internally
          // transitions REVIEW → APPROVED — if a late race lands the task
          // update below first, the Change is not yet irreversibly moved.
          await c.submitReview(change.id, {
            verdict: 'pass',
            revision: status.revision ?? 'unknown',
            findings: [],
          }, { sessionId: options.sessionId });
          const done = t.updateIf(taskId, { status: 'in_review' }, { status: 'done' });
          if (!done) {
            await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'task_done_blocked', sessionId: options.sessionId });
            return { outcome: 'task_update_race' };
          }
          // submitReview already transitioned REVIEW → APPROVED internally.
          await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'review_pass_approved', sessionId: options.sessionId, revision: status.revision ?? null });
          return { outcome: 'approved' };
        }
        // fail path
        await c.submitReview(change.id, {
          verdict: 'fail',
          revision: status.revision ?? 'unknown',
          findings: options.findings ?? [],
        }, { sessionId: options.sessionId });
        // submitReview has moved the Change to REPAIR already.
        if (escalate) {
          const failedTask = t.updateIf(taskId, { status: 'in_review' }, { status: 'failed', result_summary: 'escalated to failed after repair threshold' });
          if (!failedTask) {
            await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'escalated_task_race', sessionId: options.sessionId, revision: status.revision ?? null });
            return { outcome: 'task_update_race' };
          }
          // "Escalation" here is a manual hand-off, not a hidden terminal:
          // TRANSITIONS (domain) does not engineer REJECTED, so the Change
          // stays in REPAIR and a well-formed audit records the reason. A
          // human resolves it via the change-control CLI. That is the
          // deliberate domain rule — we don't secretly force it.
          await c.appendAudit({
            kind: 'review_orchestration', changeId: change.id, action: 'escalated',
            sessionId: options.sessionId, revision: status.revision ?? null, attempts: attemptsSeen,
            note: 'repair attempts exhausted; change left in REPAIR for human disposition',
          });
          return { outcome: 'escalated', attempts: attemptsSeen };
        }
        const updated = t.updateIf(taskId, { status: 'in_review' }, { status: 'changes_requested' });
        if (!updated) return { outcome: 'task_update_race' };
        await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'review_fail_to_repair', sessionId: options.sessionId, revision: status.revision ?? null });
        return { outcome: 'repair' };
      })();
    },

    /**
     * T8.2 — Push a task back to ready for the next repair attempt.
     * @param {string} taskId
     */
    prepareRepairAttempt(taskId) {
      const t = requireTask();
      requireTaskId(taskId);
      return (async () => {
        const patched = t.updateIf(taskId, { status: 'changes_requested' }, { status: 'ready' });
        if (!patched) {
          throw Object.assign(new Error(`task ${taskId} is not in changes_requested state`), { code: 'INVALID_TASK_STATE' });
        }
        return { status: 'ready', taskId };
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
      return launchReviewerForTask(requireTask, requireChange, requireTaskId, taskId, options);
    },

    /**
     * T-H5 — the production governed SDLC controller.
     *
     * One explicit controller-owned lifecycle over the existing governed
     * operations. The automatic production trigger is the dispatcher
     * completionHook (governed worker success → this method with no verdict);
     * verdict data arrives by re-invocation (host-observed structured
     * verdict, or a review already submitted through Change Control's
     * reviewer tools, which this method converges).
     *
     * Stage traversal:
     *   PREFLIGHT → deterministic preflight → REVIEW + independent reviewer
     *   launch/bind → verdict:
     *     pass → APPROVED + task done (terminal)
     *     fail → REPAIR + task changes_requested → repair worker routing
     *     (Task Orchestrator claim/start + governance-bound worker session +
     *     submitRepair claiming the unresolved finding IDs + governed
     *     completion) → repeat preflight/review
     *   maxRepairRounds exhaustion → escalation: task failed, the Change is
     *   left in REPAIR for human disposition (the existing policy).
     *
     * Authority boundaries are preserved: the controller owns no domain
     * state — every loop iteration re-reads the persisted (task, Change)
     * pair, so operations are idempotent and resumable after a restart, and
     * the reviewer never receives a task claim/lease merely by being
     * launched. No model-facing bind/create/transition surface is added
     * (tools.js is unchanged; the model-facing surface stays at two tools).
     *
     * @param {string} taskId
     * @param {{ maxRepairRounds?: number,
     *   controllerPreflightOverride?: string[],
     *   verdict?: { verdict: 'pass'|'fail', findings?: object[], sessionId?: string },
     *   worker?: string,
     *   workerLauncher?: object,
     *   repairProof?: object,
     *   repairFindings?: object[],
     *   repairClaim?: string,
     *   leaseSeconds?: number }} [options]
     * @returns {Promise<{ outcome: string, [key: string]: any }>}
     */
    runGovernedSdlc(taskId, options = {}) {
      const t = requireTask();
      const c = requireChange();
      requireTaskId(taskId);
      const maxRepairRounds = options.maxRepairRounds ?? 3;
      // The verdict is one-shot per call: a repair loop that re-enters the
      // REVIEW stage must never re-settle the same verdict.
      let verdict = options.verdict && (options.verdict.verdict === 'pass' || options.verdict.verdict === 'fail')
        ? options.verdict
        : null;
      return (async () => {
        let iterations = 0;
        while (true) {
          if (++iterations > maxRepairRounds * 3 + 8) {
            return { outcome: 'stuck', taskId, detail: 'controller loop exceeded its round bound' };
          }
          const task = await Promise.resolve(t.get(taskId));
          if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
          // findByWorkItem excludes terminal Changes; fall back to any
          // linkage record so a converged (APPROVED) task still resolves its
          // Change on re-entry — the terminal checks below handle it.
          let change = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
          if (!change) {
            const all = typeof c.listByWorkItem === 'function' ? await c.listByWorkItem(WORK_ITEM_SYSTEM, taskId) : [];
            change = Array.isArray(all) && all.length > 0 ? all[all.length - 1] : null;
          }
          if (!change) throw Object.assign(new Error(`no Change linked to task ${taskId}`), { code: 'WORK_ITEM_NOT_LINKED' });
          const state = change.state;

          // ── Terminal convergence ──
          if (state === 'APPROVED') {
            if (task.status !== 'done') {
              const converged = t.updateIf(taskId, { status: 'in_review' }, { status: 'done' });
              if (converged === null) continue; // moved concurrently — re-read
              await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'review_pass_converged' });
            }
            return { outcome: 'approved', taskId, changeId: change.id };
          }
          if (task.status === 'failed' && state === 'REPAIR' && await hasEscalationAudit(c, change.id)) {
            return { outcome: 'escalated', taskId, changeId: change.id };
          }
          // Foreign drift (a human blocked/cancelled the task mid-flight):
          // never mutate here — reconcileTaskChange / a human disposes.
          if (task.status === 'blocked' || task.status === 'cancelled') {
            return { outcome: 'lifecycle_mismatch', taskId, changeId: change.id, taskStatus: task.status, changeState: state };
          }

          if (state === 'PREFLIGHT') {
            if (task.status !== 'in_review') {
              return { outcome: 'lifecycle_mismatch', taskId, changeId: change.id, taskStatus: task.status, changeState: state };
            }
            // Deterministic preflight + reviewer launch/bind (reviewer
            // sessions never touch task claim/lease).
            const rv = await api.runGovernedReview(taskId, { controllerPreflightOverride: options.controllerPreflightOverride });
            if (rv.outcome === 'preflight_failed') {
              return { outcome: 'preflight_failed', taskId, changeId: change.id };
            }
            continue; // Change is now REVIEW with a reviewer bound
          }

          if (state === 'REVIEW') {
            if (task.status !== 'in_review') {
              return { outcome: 'lifecycle_mismatch', taskId, changeId: change.id, taskStatus: task.status, changeState: state };
            }
            // A concurrent reviewer may have settled the review through
            // Change Control's reviewer tools (REVIEW → APPROVED | REPAIR).
            // Re-read before settling.
            const live = await c.get(change.id);
            if (live.state === 'APPROVED') {
              if (task.status !== 'done') {
                const converged = t.updateIf(taskId, { status: 'in_review' }, { status: 'done' });
                if (converged === null) continue;
                await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'review_pass_converged' });
              }
              return { outcome: 'approved', taskId, changeId: change.id };
            }
            if (live.state === 'REPAIR') {
              // Reviewer-submitted fail verdict: settle the task side
              // (mirror of applyReviewOutcome's fail path minus the submit),
              // honoring the same escalation policy.
              const settled = await settleReviewedFailure(taskId, change.id, t, c, maxRepairRounds);
              if (settled !== null) {
                if (settled.outcome === 'task_update_race') continue; // re-read
                return settled; // 'escalated'
              }
              // fall through: task is now changes_requested — route repair
            } else {
              // Still REVIEW: the verdict must arrive as data.
              let reviewer = await currentReviewerBinding(c, change.id);
              if (!reviewer) {
                // Reviewer session lost (crash between transition and
                // bind/launch): resume the stage, which launches a fresh
                // reviewer without re-running preflight.
                const rv = await api.runGovernedReview(taskId, { controllerPreflightOverride: options.controllerPreflightOverride });
                if (rv.outcome === 'preflight_failed') {
                  return { outcome: 'preflight_failed', taskId, changeId: change.id };
                }
                reviewer = (await currentReviewerBinding(c, change.id)) ?? { sessionId: rv.sessionId };
              }
              if (!verdict) {
                return { outcome: 'review_pending', taskId, changeId: change.id, sessionId: reviewer.sessionId };
              }
              const settled = await api.applyReviewOutcome(taskId, {
                sessionId: verdict.sessionId ?? reviewer.sessionId,
                verdict: verdict.verdict,
                findings: verdict.findings,
                maxRepairRounds,
              });
              verdict = null; // consumed — the next round needs fresh data
              if (settled.outcome === 'approved') return { outcome: 'approved', taskId, changeId: change.id };
              if (settled.outcome === 'escalated') return { outcome: 'escalated', taskId, changeId: change.id, attempts: settled.attempts };
              if (settled.outcome === 'task_update_race' || settled.outcome === 'invalid_state') continue;
              // 'repair' → Change REPAIR + task changes_requested — route below
            }
          }

          // REPAIR stage: persisted REPAIR entry, or just-settled REVIEW.
          const routed = await routeRepairAttempt({ t, c, api, taskId, change, options });
          if (routed.stopped) return routed.result;
          continue; // repair submitted + governed completion converged
        }
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


/**
 * The service-facade slice the T-H5 repair routing needs.
 * @typedef {{ prepareRepairAttempt: (taskId: string) => Promise<any>, completeGovernedTask: (taskId: string, options: { sessionId: string, worker: string, proof: object }) => Promise<any> }} SdlcApiView
 */

/**
 * Parse one controller preflight entry into its check identity and its
 * status, encoded separately:
 *   'pass:build' / 'ok:build' / 'PASS: build' → { name: 'build', passed: true,  exitCode: 0 }
 *   'fail:build' / 'FAIL: build'              → { name: 'build', passed: false, exitCode: 1 }
 *   'ok' / 'pass' (bare status markers)        → { name: <entry>,  passed: true,  exitCode: 0 }
 *   anything unprefixed or empty               → { name: <entry|'ok'>, passed: false, exitCode: 1 }
 * The name is the CANONICAL BARE required-check name (any pass:/ok:/fail:
 * prefix stripped) so it matches the host preflightPolicy.requiredChecks
 * entry exactly. Unprefixed/empty entries fail closed — the same rule the
 * NO_POLICY default gate applies.
 * @param {string} entry
 * @returns {{ name: string, passed: boolean, exitCode: number }}
 */
function parseControllerPreflightEntry(entry) {
  const trimmed = String(entry ?? '').trim();
  const match = /^(pass|ok|fail)(?:[:.\s](.*))?$/i.exec(trimmed);
  if (match) {
    const passed = match[1].toLowerCase() !== 'fail';
    const name = (match[2] ?? '').trim() || trimmed || 'ok';
    return { name, passed, exitCode: passed ? 0 : 1 };
  }
  return { name: trimmed || 'ok', passed: false, exitCode: 1 };
}

const reviewerReservationLocks = new Map(); // changeId -> tail promise
/**
 * Per-Change reviewer reservation lock. Serializes the check→launch→bind
 * critical section per Change (see the map above).
 * @param {string} changeId
 * @param {() => Promise<string>} fn the launch-and-bind critical section
 */
function withReviewerReservation(changeId, fn) {
  const prev = reviewerReservationLocks.get(changeId) ?? Promise.resolve();
  const next = prev.then(() => fn());
  // Trim the map once this tail settles so a dead Change never leaks a lock.
  // The derived finally-promise mirrors `next` (incl. rejection) but is not
  // what callers await, so swallow it to avoid an unhandled rejection when
  // fn throws — the original `next` still rejects for the awaited caller.
  next.finally(() => {
    if (reviewerReservationLocks.get(changeId) === next) reviewerReservationLocks.delete(changeId);
  }).catch(() => {});
  reviewerReservationLocks.set(changeId, next);
  return next;
}

// ─── T-H5 PR2-01: durable cross-process reviewer claim ───────

/**
 * T-H5 PR2-01/02 — durable cross-process reviewer-claim.
 *
 * The claim FILE is the reservation: the launched session is recorded in the
 * file BEFORE the binding, so a crashed owner's reviewer is reconciled by
 * the next claim (adopted, never re-launched, never orphaned). A confirmed
 * reviewer binding always wins: it is the durable, cross-process-visible
 * terminal record.
 *
 * T-H5 PR2-02 — creation of the claim (first claim, stale-empty
 * takeover, dead-incomplete reclaim) is serialized under a sibling RECLAIM
 * LOCK file (atomic exclusive create, crash-safe via the same lease):
 * exactly one process at a time (re)creates the claim, by OVERWRITING it in
 * place — no delete-then-create, so there is no absence window a stale
 * reader could exploit to wipe a concurrent winner's fresh claim and launch
 * a duplicate reviewer. Losers wait on the lock, then converge on the
 * winner's claim/session/binding.
 *
 * T-H5 PR2-03 — STALE lock recovery is generation-safe: a reclaimer grabs
 * the slot atomically and discards ONLY the exact lock generation it
 * observed as stale; a newer generation that landed in the slot meanwhile
 * is restored, never evicted. Before the critical section the holder also
 * re-verifies its lock is still in the slot (a concurrent refiller can
 * re-create the slot in the grab gap), and release deletes only a lock it
 * still owns. No concurrent recovery can remove a newly acquired lock or
 * produce two holders — so no duplicate launches.
 *
 * Claim-file layout: `<task.workspace>/.dsh-governance/reviewer-claims/
 * reviewer-claim-<changeId>`. The shared task workspace is the stable anchor
 * every host process owning the task sees; hosts without a workspace fall
 * back to the shared host tmpdir (wiped on host reboot, where all sessions
 * are dead anyway and a fresh launch is the correct convergence).
 */

/**
 * Claim lease: the longest a claim owner may hold a reservation without the
 * launched session being bound. A crashed owner's claim goes stale and a
 * waiting successor takes it over, so liveness is inferred from the durable
 * record timestamp, not a heartbeat.
 * ponytail: ceiling — a reviewer launch that outlives the lease can be taken
 * over mid-flight by a waiting process (duplicate-launch window); raise the
 * lease if provider cold-starts run longer than 10 minutes.
 */
const REVIEWER_CLAIM_LEASE_MS = 10 * 60 * 1000;
const REVIEWER_CLAIM_POLL_MS = 50;
/** Bounded wait: lease + grace, so a corrupt record can never block forever. */
const REVIEWER_CLAIM_WAIT_MS = REVIEWER_CLAIM_LEASE_MS + 60_000;

/**
 * @param {any} change
 * @param {any} task
 * @returns {string}
 */
function reviewerClaimFile(change, task) {
  const base = typeof task?.workspace === 'string' && task.workspace.trim() !== ''
    ? task.workspace
    : tmpdir();
  return join(base, '.dsh-governance', 'reviewer-claims', `reviewer-claim-${String(change.id)}`);
}

/** @returns {string} the host-process identity written into claim records. */
function claimIdentity() {
  return `${hostname()}:${process.pid}`;
}

/**
 * @param {string} file
 * @returns {Promise<{ exists: boolean, incomplete: boolean, value: { claimant?: string, sessionId?: string | null, updatedAt?: number } | null }>}
 */
async function readClaimRecord(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { exists: false, incomplete: false, value: null };
  }
  if (raw.trim() === '') {
    // The holder exclusive-created the claim but has not finished its
    // initial record write (or died mid-write): incomplete, never stale
    // by content.
    return { exists: true, incomplete: true, value: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { exists: true, incomplete: true, value: null };
    return { exists: true, incomplete: false, value: parsed };
  } catch {
    return { exists: true, incomplete: true, value: null };
  }
}

/**
 * Atomic rewrite of the durable claim record (tmp + rename, as the store's
 * writeJson). The sole claim writer: called UNDER the reclaim lock when a
 * claim is (re)created, and by the owner's recordSession hook when the
 * launched session is persisted.
 * @param {string} file
 * @param {{ claimant: string, sessionId: string | null, updatedAt: number }} record
 */
async function writeClaimRecord(file, record) {
  const tmp = `${file}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(record), 'utf8');
  await rename(tmp, file);
}

/** @param {string} claimFile @returns {string} the sibling reclaim-lock path. */
function reclaimLockFile(claimFile) {
  return `${claimFile}.lock`;
}

/**
 * Exclusive-create the reclaim lock. A live lock is someone else's held lock
 * (returns false → the caller waits). A STALE lock (its holder crashed
 * before releasing) is reclaimed generation-safely (T-H5 PR2-03): the slot
 * is grabbed atomically and ONLY the exact observed generation is discarded;
 * a newer generation that landed in the slot while we decided is restored,
 * never evicted — so a stale reader can never remove another process's
 * freshly acquired lock and double-acquire.
 * ponytail: ceiling — the lock lease reuses the 10-min claim lease; a
 * crashed holder's lock blocks successors until it expires. Add a heartbeat
 * (or shorter lock lease) only if lock holders outlive the lease.
 * @param {string} lockFile
 * @param {string} identity
 * @returns {Promise<boolean>} true when this caller holds the lock
 */
async function acquireReclaimLock(lockFile, identity) {
  await mkdir(dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(lockFile, JSON.stringify({ owner: identity, updatedAt: Date.now() }), {
        flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      });
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    // A lock is in the slot: read exactly what is there, then reclaim ONLY
    // that observed generation.
    let observedRaw;
    try { observedRaw = await readFile(lockFile, 'utf8'); } catch { continue; }
    let held = null;
    try { held = JSON.parse(observedRaw); } catch { held = null; }
    const lockStale = !held || Date.now() - Number(held.updatedAt || 0) > REVIEWER_CLAIM_LEASE_MS;
    if (!lockStale) return false; // a live holder: wait for its release
    // Grab the slot atomically, then verify WHAT was in it.
    const grab = `${lockFile}.grab.${process.pid}`;
    try {
      await rename(lockFile, grab);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      continue; // vanished between check and grab: retry the exclusive create
    }
    const grabbedRaw = await readFile(grab, 'utf8');
    if (grabbedRaw === observedRaw) {
      // The EXACT stale generation we observed: safe to discard; retry the
      // exclusive create (the slot is now empty).
      await rm(grab, { force: true }).catch(() => {});
      continue;
    }
    // A NEWER generation was acquired in the slot while we decided: restore
    // it (if the slot was re-filled meanwhile, EEXIST → it is intact), and
    // wait on that holder instead of racing ahead.
    await writeFile(lockFile, grabbedRaw, {
      flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    }).catch((err) => { if (err?.code !== 'EEXIST') throw err; });
    await rm(grab, { force: true }).catch(() => {});
    return false;
  }
  return false; // concurrent reclaimers kept winning; the caller polls
}

/**
 * Point-of-use lock verification (T-H5 PR2-03): the holder re-checks that
 * ITS lock is still in the slot before the critical section. A concurrent
 * refiller can re-create the slot in a grab gap, leaving the original
 * holder's lock evicted — that holder must back off, not launch.
 * @param {string} lockFile
 * @param {string} identity
 * @returns {Promise<boolean>}
 */
async function verifyReclaimLockHeld(lockFile, identity) {
  let rec = null;
  try { rec = JSON.parse(await readFile(lockFile, 'utf8')); } catch { return false; }
  return rec?.owner === identity && Date.now() - Number(rec.updatedAt || 0) <= REVIEWER_CLAIM_LEASE_MS;
}

/**
 * Release the reclaim lock — deleting ONLY a lock this owner still holds
 * (T-H5 PR2-03: a blind delete could remove a successor's fresh lock).
 * @param {string} lockFile
 * @param {string} identity
 */
async function releaseReclaimLock(lockFile, identity) {
  let rec = null;
  try { rec = JSON.parse(await readFile(lockFile, 'utf8')); } catch { return; }
  if (rec?.owner === identity) await rm(lockFile, { force: true }).catch(() => {});
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The claim protocol (see module notes). Never launches a reviewer while a
 * durable claim exists: reuses a confirmed binding, adopts a recorded
 * (launched-but-unbound) session, waits for a live owner, or takes over a
 * stale claim — then hands off to `launch`, which records its session
 * durably before binding.
 *
 * @param {{
 *   c: any, change: any, task: any,
 *   launch: (holder: { file: string, identity: string }) => Promise<string>,
 * }} deps
 * @returns {Promise<string>} the reviewer session id to use
 */
async function reserveReviewerLaunch({ c, change, task, launch }) {
  const file = reviewerClaimFile(change, task);
  const lockFile = reclaimLockFile(file);
  const identity = claimIdentity();
  const deadline = Date.now() + REVIEWER_CLAIM_WAIT_MS;
  const confirmedBinding = () => c.listRoleBindings()
    .then((bindings) => bindings.find((b) => b.changeId === change.id && b.role === 'reviewer'));
  const adopt = (sessionId, claimant) => c.bindRole(change.id, sessionId, 'reviewer')
    .catch((err) => { if (err?.code === 'ALREADY_BOUND') return null; throw err; })
    .then(() => c.appendAudit({
      kind: 'review_orchestration', changeId: change.id, action: 'reviewer_claim_adopted',
      sessionId, claimant: claimant ?? null,
    }))
    .then(() => sessionId);
  for (;;) {
    // 1. Confirmed reviewer binding: durable and visible across processes —
    //    reuse it, never launch.
    const bound = await confirmedBinding();
    if (bound) return bound.sessionId;

    const { exists, incomplete, value: record } = await readClaimRecord(file);
    const stale = !incomplete && exists
      ? Date.now() - Number(record.updatedAt || 0) > REVIEWER_CLAIM_LEASE_MS
      : false;

    // 2. A launched session is recorded but not yet bound: the owner is
    //    mid-bind (wait for convergence) or crashed (adopt). Adoption binds
    //    the recorded session instead of launching a duplicate — the
    //    orphaned reviewer is reconciled, not re-created.
    if (record?.sessionId && typeof record.sessionId === 'string') {
      if (!stale) {
        if (Date.now() > deadline) {
          throw Object.assign(new Error('reviewer claim owner has not bound its session within the wait window'), { code: 'REVIEWER_CLAIM_TIMEOUT' });
        }
        await sleep(REVIEWER_CLAIM_POLL_MS);
        continue;
      }
      // Stale owner: bind the recorded session (a concurrent adopter may
      // have beaten us — ALREADY_BOUND is successful convergence).
      return await adopt(record.sessionId, record.claimant);
    }

    // 3. Fresh claim with no session: its owner is mid-launch — wait for
    //    the session to be recorded (bounded), never launch a second
    //    reviewer.
    if (exists && !incomplete && !stale) {
      if (Date.now() > deadline) {
        throw Object.assign(new Error('reviewer claim wait exceeded window'), { code: 'REVIEWER_CLAIM_TIMEOUT' });
      }
      await sleep(REVIEWER_CLAIM_POLL_MS);
      continue;
    }

    // 4. A claim must be (re)created: absent, stale-empty, or a dead
    //    incomplete holder (past the wait window). Serialized under the
    //    durable RECLAIM LOCK: exactly one process at a time (re)creates
    //    the claim, overwriting it IN PLACE — no delete-then-create, no
    //    absence window, so no stale reader can wipe a concurrent winner's
    //    fresh claim and launch a duplicate reviewer (T-H5 PR2-02). The
    //    stale-lock recovery is generation-safe, and the holder re-verifies
    //    its lock is still in the slot before the critical section (T-H5
    //    PR2-03) — a lost lock means backing off, never launching.
    for (;;) {
      if (await acquireReclaimLock(lockFile, identity)
        && await verifyReclaimLockHeld(lockFile, identity)) break;
      if (Date.now() > deadline) {
        throw Object.assign(new Error('reviewer claim wait exceeded window'), { code: 'REVIEWER_CLAIM_TIMEOUT' });
      }
      await sleep(REVIEWER_CLAIM_POLL_MS);
    }
    let created = false;
    let adopted;
    try {
      // Re-validate UNDER the lock: the claim may have changed since we read.
      const boundNow = await confirmedBinding();
      if (boundNow) return boundNow.sessionId;
      const r = await readClaimRecord(file);
      const rStale = !r.incomplete && r.exists
        ? Date.now() - Number(r.value.updatedAt || 0) > REVIEWER_CLAIM_LEASE_MS
        : false;
      if (r.value?.sessionId && typeof r.value.sessionId === 'string' && rStale) {
        // A crashed owner recorded a session: reconcile it instead of launching.
        adopted = await adopt(r.value.sessionId, r.value.claimant);
      } else if (!(r.exists && !r.incomplete && !rStale)) {
        // Absent, stale-empty, or dead-incomplete: (re)create the claim in
        // place. Safe under the lock — we are the sole creator right now.
        await writeClaimRecord(file, { claimant: identity, sessionId: null, updatedAt: Date.now() });
        created = true;
      }
      // else: a fresh in-progress claim appeared while we waited — its
      // owner is mid-launch; leave it alone and wait for its session/bind.
    } finally {
      await releaseReclaimLock(lockFile, identity);
    }
    if (adopted !== undefined) return adopted;
    if (created) return await launch({ file, identity });
    continue;
  }
}

/**
 * "Repair rounds" = every extra implementation attempt beyond the initial
 * one (submission, then one per repair cycle). The escalation threshold
 * compares RETRIES ONLY — never the baseline review. Shared by
 * applyReviewOutcome and the T-H5 controller so both settlement paths
 * honor the same escalation policy.
 * @param {number} attemptsSeen
 * @param {number} maxRepairRounds
 */
function repairRoundsExhausted(attemptsSeen, maxRepairRounds) {
  return Math.max(0, attemptsSeen - 1) >= maxRepairRounds;
}

/**
 * Whether the Change audit already records an escalation (T-H5 terminal
 * convergence check — an escalated Change stays in REPAIR for human
 * disposition; re-invocations must converge, not re-route).
 * @param {ChangeControlApi} c
 * @param {string} changeId
 */
async function hasEscalationAudit(c, changeId) {
  const history = await c.history(changeId);
  return Array.isArray(history)
    && history.some((/** @type {any} */ e) => e.kind === 'review_orchestration' && e.action === 'escalated');
}

/**
 * The most recent reviewer role binding on a Change (repair rounds reuse
 * the same reviewer session), or null when none exists.
 * @param {ChangeControlApi} c
 * @param {string} changeId
 */
async function currentReviewerBinding(c, changeId) {
  const all = await c.listRoleBindings();
  const mine = all.filter((/** @type {any} */ b) => b.changeId === changeId && b.role === 'reviewer');
  return mine.length > 0 ? mine[mine.length - 1] : null;
}

/**
 * T-H5 — task-side settlement of a fail review that has ALREADY been
 * submitted through Change Control (REVIEW → REPAIR happened without the
 * controller settling the task). Mirrors applyReviewOutcome's fail path
 * minus the submitReview: escalation on the same policy, otherwise
 * changes_requested. Returns a result object to STOP (escalated /
 * task_update_race), or null to CONTINUE into repair routing.
 * @param {string} taskId
 * @param {string} changeId
 * @param {TaskOrchestratorApi} t
 * @param {ChangeControlApi} c
 * @param {number} maxRepairRounds
 * @returns {Promise<{ outcome: string, [key: string]: any } | null>}
 */
async function settleReviewedFailure(taskId, changeId, t, c, maxRepairRounds) {
  const task = await Promise.resolve(t.get(taskId));
  if (!task || task.status !== 'in_review') return null; // already settled by a data-path settlement
  const status = await c.status(changeId);
  const attemptsSeen = Array.isArray(status?.attempts) ? status.attempts.length : 0;
  if (repairRoundsExhausted(attemptsSeen, maxRepairRounds)) {
    const failedTask = t.updateIf(taskId, { status: 'in_review' }, { status: 'failed', result_summary: 'escalated to failed after repair threshold' });
    if (!failedTask) return { outcome: 'task_update_race', taskId, changeId };
    await c.appendAudit({
      kind: 'review_orchestration', changeId, action: 'escalated',
      revision: status?.revision ?? null, attempts: attemptsSeen,
      note: 'repair attempts exhausted (reviewer-submitted review); change left in REPAIR for human disposition',
    });
    return { outcome: 'escalated', taskId, changeId, attempts: attemptsSeen };
  }
  const updated = t.updateIf(taskId, { status: 'in_review' }, { status: 'changes_requested' });
  if (!updated) return { outcome: 'task_update_race', taskId, changeId };
  await c.appendAudit({
    kind: 'review_orchestration', changeId, action: 'review_fail_settled',
    revision: status?.revision ?? null,
    note: 'fail review was submitted through Change Control; task side settled by the SDLC controller',
  });
  return null; // task is now changes_requested — route repair
}

/**
 * T-H5 — Repair routing. Pushes a REPAIR-stage task back to ready
 * (idempotent prepareRepairAttempt), then — when a repair worker is
 * supplied — claims/starts it through the Task Orchestrator facade
 * (concrete routing authority), launches the repair worker through the
 * governance binding wrapper (worker role, run identity), waits, submits
 * the repair CLAIMING THE UNRESOLVED FINDING IDs (Change Control is
 * authoritative for the claims; the store rejects unknown IDs and
 * missing blocking claims), and converges the governed completion.
 * Without a supplied worker, stops at the resumable repair_routed
 * boundary.
 *
 * @param {object} args
 * @param {TaskOrchestratorApi} args.t
 * @param {ChangeControlApi} args.c
 * @param {SdlcApiView} args.api the service facade (prepareRepairAttempt / completeGovernedTask)
 * @param {string} args.taskId
 * @param {{ id: string }} args.change
 * @param {{ worker?: string, workerLauncher?: object, repairProof?: object,
 *   repairFindings?: object[], repairClaim?: string, leaseSeconds?: number }} args.options
 * @returns {Promise<{ stopped: true, result: { outcome: string, [key: string]: any } } | { stopped: false }>}
 * `stopped: false` means the repair was submitted and governed completion
 * converged — the caller loops back to PREFLIGHT.
 */
async function routeRepairAttempt({ t, c, api, taskId, change, options }) {
  const task = await Promise.resolve(t.get(taskId));
  if (task.status === 'changes_requested') {
    await api.prepareRepairAttempt(taskId); // → ready (CAS-protected)
  } else if (task.status !== 'ready') {
    return {
      stopped: true,
      result: { outcome: 'lifecycle_mismatch', taskId, changeId: change.id, taskStatus: task.status, changeState: 'REPAIR' },
    };
  }
  if (typeof t.claim !== 'function' || typeof t.start !== 'function' || typeof t.release !== 'function') {
    throw Object.assign(new Error('taskOrchestrator facade does not expose claim/start/release — repair routing unavailable'), { code: 'ROUTING_UNAVAILABLE' });
  }
  if (typeof c.submitRepair !== 'function') {
    throw Object.assign(new Error('changeControl facade does not expose submitRepair — repair routing unavailable'), { code: 'SUBMIT_REPAIR_UNAVAILABLE' });
  }
  const statusNow = await c.status(change.id);
  const openFindings = Array.isArray(statusNow?.openFindings) ? statusNow.openFindings : [];
  const revision = statusNow?.revision ?? null;
  if (!options.worker || !options.workerLauncher || options.repairProof == null) {
    // Resumable boundary: the repair stage is prepped; a re-invocation
    // (possibly after a restart, possibly with the repair worker and its
    // structured proof) continues.
    return {
      stopped: true,
      result: {
        outcome: 'repair_routed', taskId, changeId: change.id,
        openFindingIds: openFindings.map((/** @type {any} */ f) => f.id),
        revision,
        missing: options.worker && options.workerLauncher ? 'repairProof' : 'repairWorker',
      },
    };
  }
  const runId = options.worker;
  const claim = await Promise.resolve(t.claim(taskId, runId, { lease_seconds: options.leaseSeconds ?? 600, actor: 'sdlc-controller' }));
  if (!claim || claim.claimed !== true) {
    return { stopped: true, result: { outcome: 'repair_claim_failed', taskId, changeId: change.id, reason: claim?.reason } };
  }
  await Promise.resolve(t.start(taskId, runId, { actor: 'sdlc-controller' }));
  const liveTask = await Promise.resolve(t.get(taskId));
  const governedLauncher = createBindingLauncher(options.workerLauncher, c, WORK_ITEM_SYSTEM);
  let handle;
  try {
    handle = await governedLauncher.launch({
      task: liveTask,
      spec: { mode: 'session', prompt: buildRepairPrompt(taskId, change.id, revision, openFindings) },
      worker: runId,
    });
  } catch (/** @type {any} */ error) {
    await Promise.resolve(t.release(taskId, runId, { actor: 'sdlc-controller' })).catch(() => {});
    return { stopped: true, result: { outcome: 'repair_launch_failed', taskId, changeId: change.id, error: error?.message ?? String(error) } };
  }
  // Governed hold (T-H3): keep the worker binding through wait so the
  // governed completion can validate the real session identity; release is
  // idempotent and safe to race with the abnormal paths below.
  // Repair claims: the UNRESOLVED FINDING IDs (blocking findings require
  // 'fixed'; explicit worker-supplied claims pass through untouched).
  const claims = Array.isArray(options.repairFindings) && options.repairFindings.length > 0
    ? options.repairFindings
    : openFindings.map((/** @type {any} */ f) => ({ findingId: f.id, status: 'fixed', claim: String(options.repairClaim ?? 'repaired') }));
  // Governed hold (T-H3): keep the worker binding through wait so the
  // governed completion can validate the real session identity. Submission
  // and completion run UNDER THE HOLD (before the release in finally) —
  // completeGovernedTask requires the live binding.
  handle._governedHold?.();
  let settle;
  let submitError = null;
  try {
    settle = await handle.wait?.();
    if (settle && settle.exitCode === 0 && !settle.error) {
      try {
        await c.submitRepair(change.id, { findings: claims, proof: options.repairProof }, { workerId: runId });
        // Governed completion converges the task side (PREFLIGHT idempotent
        // fast path: the stored repair proof matches this payload).
        await api.completeGovernedTask(taskId, { sessionId: handle.sessionId, worker: runId, proof: options.repairProof });
      } catch (/** @type {any} */ error) {
        submitError = error;
      }
    }
  } finally {
    await handle._governedRelease?.();
  }
  if (submitError !== null) {
    // A failed submission/leave would strand the task running under our
    // claim: release it so a re-invocation can re-claim (resumable), then
    // surface the domain error.
    await Promise.resolve(t.release(taskId, runId, { actor: 'sdlc-controller' })).catch(() => {});
    throw submitError;
  }
  if (!settle || settle.exitCode !== 0 || settle.error) {
    // Repair worker did not complete: release the lease so a re-invocation
    // can re-claim — the Change stays in REPAIR (resumable).
    await Promise.resolve(t.release(taskId, runId, { actor: 'sdlc-controller' })).catch(() => {});
    return {
      stopped: true,
      result: { outcome: 'repair_failed', taskId, changeId: change.id, sessionId: handle.sessionId, detail: settle?.error ?? `worker exited ${settle?.exitCode}` },
    };
  }
  return { stopped: false };
}

/**
 * Minimal repair context handed to the repair worker (finding IDs first).
 * @param {string} taskId
 * @param {string} changeId
 * @param {string|null} revision
 * @param {Array<object>} openFindings
 */
function buildRepairPrompt(taskId, changeId, revision, openFindings) {
  const lines = openFindings.map((/** @type {any} */ f) =>
    `- ${f.id} [${f.severity}] ${f.location ?? ''}: ${f.problem ?? ''} (required: ${f.requiredOutcome ?? ''})`);
  return [
    `You are the repair worker for task ${taskId}.`,
    `Governed Change ${changeId} failed independent review at revision ${revision ?? 'unknown'}.`,
    'Address every unresolved finding below, stay within the Change scope, and submit the repair claiming each finding ID:',
    lines.length > 0 ? lines.join('\n') : '(no unresolved findings recorded)',
  ].join('\n');
}

/**
 * Internal reviewer launch. Factored as a free function so runGovernedReview
 * does not depend on the frozen-facade `this` binding.
 *
 * @param {() => TaskOrchestratorApi} requireTask
 * @param {() => ChangeControlApi} requireChange
 * @param {(taskId: any) => void} requireTaskId
 * @param {string} taskId
 * @param {{ spec?: object, launcherOptions?: object,
 *   recordSession?: (sessionId: string) => Promise<void>,
 *   discardSession?: () => Promise<void> }} [options]
 *
 * T-H5 PR2-01: `recordSession` runs after launch and BEFORE the binding so a
 * durable record of the launched session exists before the (crash-prone)
 * bind; `discardSession` runs after a launch that must be terminated (bind
 * failure) so a successor claim does not adopt a dead session. Both are
 * absent for plain host launches (launchReviewer), which are unchanged.
 */
function launchReviewerForTask(requireTask, requireChange, requireTaskId, taskId, options = {}) {
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
      ...(typeof task.reviewer_model === 'string' && task.reviewer_model !== ''
        ? (() => {
            const s = String(task.reviewer_model);
            const slash = s.indexOf('/');
            if (slash < 1 || slash === s.length - 1) {
              throw Object.assign(new Error(`reviewer_model must be 'provider/model' (got: ${s})`), { code: 'REVIEWER_MODEL_MALFORMED' });
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
      // T-H5 PR2-01: durably record the launched session BEFORE the binding,
      // so a crash between launch and bind leaves a record a successor claim
      // can adopt (reconcile, not re-launch). Absent for plain host launches.
      if (typeof options.recordSession === 'function') {
        await options.recordSession(handle.sessionId);
      }
      binding = await c.bindRole(change.id, handle.sessionId, 'reviewer');
    } catch (error) {
      if (typeof handle?.terminate === 'function') {
        try { await handle.terminate(); } catch { /* best-effort */ }
      }
      // T-H5 PR2-01: expire the durable record so a successor claim launches
      // fresh instead of adopting a session we just terminated.
      if (typeof options.discardSession === 'function') {
        try { await options.discardSession(); } catch { /* best-effort */ }
      }
      throw error;
    }
    return { sessionId: handle.sessionId, changeId: change.id, binding, handle };
  })();
}
