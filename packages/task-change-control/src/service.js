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
import { randomUUID } from 'node:crypto';
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
 * Validate worker criterion evidence against the canonical acceptance criteria
 * with the SAME authoritative checks ChangeStore.submitProof applies: exact
 * array shape ({id: non-empty string, satisfied: boolean}), exact coverage, and
 * no duplicates, unknown, missing, or unsatisfied criteria. Throws on the first
 * violation with the authoritative Change-side code. Mirrors submitProof so the
 * governed completion and replay paths cannot accept evidence the proof boundary
 * would reject.
 * @param {string[]} acceptedCriteria canonical criterion IDs
 * @param {Array<{id: string, satisfied: boolean}>} criteria worker criterion evidence
 */
function validateProofCriteria(acceptedCriteria, criteria) {
  const acceptedIds = new Set((acceptedCriteria ?? []).map(String));
  if (!Array.isArray(criteria)) {
    throw Object.assign(
      new Error('proof.criteria is required and must be an array'),
      { code: 'INVALID_PROOF', field: 'criteria' },
    );
  }
  const seen = new Set();
  for (const crit of criteria) {
    if (!crit || typeof crit !== 'object' || Array.isArray(crit)) {
      throw Object.assign(new Error('Each criterion must be an object'), { code: 'INVALID_PROOF' });
    }
    // H9 {id, satisfied} allows no other keys — an extra field (e.g. a freeform
    // `evidence` key) is rejected so a criterion's satisfaction can never be
    // laundered through an undocumented side channel.
    for (const key of Object.keys(crit)) {
      if (key !== 'id' && key !== 'satisfied') {
        throw Object.assign(new Error(`Criterion has unexpected field: ${key}`), { code: 'INVALID_PROOF' });
      }
    }
    if (typeof crit.id !== 'string' || crit.id.trim() === '') {
      throw Object.assign(new Error('Criterion id must be a non-empty string'), { code: 'INVALID_PROOF' });
    }
    if (typeof crit.satisfied !== 'boolean') {
      throw Object.assign(new Error(`Criterion satisfied must be a boolean for id: ${crit.id}`), { code: 'INVALID_PROOF' });
    }
    if (!acceptedIds.has(crit.id)) {
      throw Object.assign(new Error(`Unknown criterion ID: ${crit.id}`), { code: 'UNKNOWN_CRITERION' });
    }
    if (seen.has(crit.id)) {
      throw Object.assign(new Error(`Duplicate criterion ID: ${crit.id}`), { code: 'DUPLICATE_CRITERION' });
    }
    seen.add(crit.id);
  }
  for (const id of acceptedIds) {
    if (!seen.has(id)) {
      throw Object.assign(new Error(`Missing criterion: ${id}`), { code: 'MISSING_CRITERION' });
    }
  }
  for (const crit of criteria) {
    if (crit.satisfied === false) {
      throw Object.assign(
        new Error(`Criterion not satisfied: ${crit.id}`),
        { code: 'UNSATISFIED_CRITERION', criterionId: crit.id },
      );
    }
  }
}

/**
 * The worker-owned proof fields the governed-completion contract defines.
 * Exact stored-proof replay equality is judged over ONLY these fields (the
 * stored proof may additionally carry an injected sessionId, which is not part
 * of the worker's payload and must not force a spurious replay mismatch).
 */
const PROOF_CONTRACT_FIELDS = [
  'beforeRevision', 'afterRevision', 'commit_sha',
  'files_changed', 'tests_run', 'remaining_blockers',
  'criteria', 'deviations', 'workerChecks', 'controllerPreflight',
  'summary',
];

/**
 * Deep-compare one proof field for exact replay equality. Arrays/objects are
 * compared by canonical JSON; scalars by ===. Criteria order, values, and keys
 * are therefore compared exactly (array order is preserved by JSON.stringify).
 * @param {any} a
 * @param {any} b
 */
function proofFieldEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/**
 * True when the replay payload exactly matches the stored proof on every
 * worker-owned contract field. Any difference (summary, revisions, deviations,
 * worker checks, criteria order/id/satisfied/keys, …) is a PROOF_MISMATCH.
 * @param {object|null} stored
 * @param {object} proof
 */
function proofsEqualExactly(stored, proof) {
  if (stored == null) return false;
  for (const field of PROOF_CONTRACT_FIELDS) {
    if (!proofFieldEqual(stored[field], proof[field])) return false;
  }
  return true;
}

/**
 * Minimal typed views of the two domain services this package depends on.
 * @typedef {{ get: (id: string) => any, update: (id: string, patch: any) => Promise<any>, updateIf: (id: string, expected: any, patch: any) => any, complete?: (id: string, result: object, options?: any) => any, createDispatcher: (options?: any) => any, createWorkerLauncher?: (options?: any) => any, createReviewerLauncher?: (options?: any) => any, claim?: (id: string, worker: string, options?: any) => any, start?: (id: string, worker: string, options?: any) => any, release?: (id: string, worker: string, options?: any) => any }} TaskOrchestratorApi
 * @typedef {{ get: (id: string) => Promise<any>, findByWorkItem: (system: string, id: string) => Promise<any>, findOrCreateForWorkItem: (input: { system: string, id: string, change: object }) => Promise<any>, resolveRole: (changeId: string, sessionId: string) => Promise<string>, getBinding: (changeId: string, sessionId: string) => Promise<any>, getBindingSync: (changeId: string, sessionId: string) => any, getBindingFromDisk: (changeId: string, sessionId: string) => any, listByWorkItem: (system: string, id: string) => Promise<any[]>, listRoleBindings: () => Promise<any[]>, status: (changeId: string) => Promise<any>, appendAudit: (event: any) => Promise<any>, submitProof: (changeId: string, proof: any, expected?: { sessionId?: string, expectedWorker?: string }) => Promise<any>, bindRole: (changeId: string, sessionId: string, role: string, opts?: any) => Promise<any>, submitReview: (changeId: string, review: any, opts: any) => Promise<any>, submitRepair?: (changeId: string, repair: object, opts?: any) => Promise<any>, runPreflight: (changeId: string, input?: any) => Promise<any>, history: (changeId?: string) => Promise<any[]>, getGovernanceMode?: (scope: { projectId?: string|null, workspace?: string|null }) => Promise<string>, unbindRole: (changeId: string, sessionId: string, opts?: any) => Promise<any>, transition: (changeId: string, toState: string, opts?: any) => Promise<any> }} ChangeControlApi
 * @param {object} deps
 * @param {() => TaskOrchestratorApi | undefined} deps.taskOrchestrator accessor (may be absent)
 * @param {() => ChangeControlApi | undefined} deps.changeControl accessor (may be absent)
 * @param {{ publish?: (taskId: string, changeId: string, state: string) => void }} [deps.changeStateSnapshot] optional G4 sync snapshot
 * @param {(taskId: string, changeId: string, state: string) => void} [deps.emitLinkageCreated]
 *        C2 (repair-round-3): optional linkage-created signal. Emitted after
 *        the durable write in bootstrapTask / linkTaskChange so the G4 fiber
 *        can refresh the sync snapshot on Change-side linkage mutations.
 */
export function createTaskChangeControlService({ taskOrchestrator, changeControl, changeStateSnapshot, emitLinkageCreated } = /** @type {object} */ (undefined)) {
  const requireTask = () => { const s = taskOrchestrator(); if (!s) throw unavailable('taskOrchestrator service not provided'); return s; };
  const requireChange = () => { const s = changeControl(); if (!s) throw unavailable('changeControl service not provided'); return s; };

  // G4 — optional sync Change-state snapshot (owned by the plugin's G4 fiber),
  // passed in so the APPROVED convergence path can publish its authoritative
  // state BEFORE the in_review→done CAS write reaches the TaskStore's sync
  // lifecycle guard. Absent in partial compositions → convergence degrades
  // to the plain CAS (no guard registered either), so behavior is unchanged.
  /** @param {string} taskId @param {string} changeId @param {string} state */
  const publishChangeState = (taskId, changeId, state) => {
    if (typeof changeStateSnapshot?.publish !== 'function') return;
    try { changeStateSnapshot.publish(taskId, changeId, state); } catch { /* best-effort */ }
  };
  /** @param {string} taskId */
  const requireTaskId = (taskId) => {
    if (typeof taskId !== 'string' || taskId.trim() === '' || taskId !== taskId.trim()) {
      throw Object.assign(new Error('taskId is required and must be a non-blank string'), { code: 'INVALID_TASK_ID' });
    }
    return taskId;
  };

  // T-H12 round-5 (F1): live reviewer-turn observations owned by THIS service
  // instance (fresh-launch and reattached). Disposing the controller must
  // neutralize every one so a disposed host never recovers a turn the fresh
  // (restarted) host now owns — exactly-once across a real restart.
  const activeObservationStops = new Set();

  // Handoff replay protection belongs to this activation. In-flight requests
  // share one promise; completed dispatches are returned as no-ops on replay.
  const handoffInFlight = new Map();
  const handoffCompleted = new Map();

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
        // G4: keep the authoritative link in the sync snapshot so the
        // lifecycle guard sees a repaired linkage immediately.
        publishChangeState(taskId, change.id, change.state);
        // C2 (repair-round-3): emit the linkage signal so the G4 fiber can
        // refresh the snapshot on a Change-side linkage mutation.
        try { emitLinkageCreated?.(taskId, change.id, change.state); } catch { /* best-effort */ }
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
            bootstrapSnapshot: snapshot,
          },
        });
        // API snapshot is the PERSISTED canonical one: when the resolved
        // Change carries a bootstrapSnapshot, return a detached copy of it so a
        // repeat bootstrap after task mutation never re-exposes the mutated
        // task record; the task-derived snapshot is retained only for Changes
        // that predate snapshots (legacy).
        const apiSnapshot = change.bootstrapSnapshot
          ? structuredClone(change.bootstrapSnapshot)
          : snapshot;
        // Denormalized projection (repairs drift; Change side stays canon).
        await api.linkTaskChange(taskId);
        // G4: publish the linkage into the sync snapshot so the lifecycle
        // guard immediately sees this task as governed from DRAFT onward.
        publishChangeState(taskId, change.id, change.state);
        // C2 (repair-round-3): emit the linkage signal so the G4 fiber can
        // refresh the snapshot on a Change-side linkage mutation.
        try { emitLinkageCreated?.(taskId, change.id, change.state); } catch { /* best-effort */ }
        return { change, snapshot: apiSnapshot };
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
          // (No acceptance-criteria snapshot here: the canonical criteria are
          // re-read at proof time in completeGovernedTask, never synthesized here.)

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

          // Require the worker's structured criterion evidence exactly as-is.
          // The H9 {id, satisfied} envelope is authoritative: absent criterion
          // evidence fails closed rather than synthesizing satisfied:true for
          // every canonical criterion (which would fabricate worker success).
          const criteria = result.criteria;
          if (!Array.isArray(criteria)) {
            throw Object.assign(
              new Error('governed completion requires structured worker criteria [{id, satisfied}]'),
              { code: 'PROOF_FIELD_REQUIRED', field: 'criteria' },
            );
          }

          const proof = {
            beforeRevision: result.beforeRevision ?? 'initial',
            afterRevision: result.afterRevision ?? commitSha,
            commit_sha: commitSha,
            files_changed: Array.isArray(result.files_changed) ? result.files_changed : [],
            tests_run: Array.isArray(result.tests_run) ? result.tests_run : [],
            remaining_blockers: Array.isArray(result.remaining_blockers) ? result.remaining_blockers : [],
            criteria,
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
              // The completion already converged. Before returning ok, re-read the
              // CANONICAL task acceptance criteria AFTER the Change awaits
              // (findByWorkItem/get/status) — never the stale task snapshot read
              // at method entry — so a criteria mutation landing during any await
              // is observed and fails closed.
              const s = await c.status(existingLink.id).catch(() => null);
              const stored = s && s.proof ? s.proof : null;
              const freshTask = await Promise.resolve(taskOrchestrator.get(taskId));
              if (!freshTask) {
                throw Object.assign(new Error(`task missing at proof time`), { code: 'TASK_NOT_FOUND' });
              }
              const canonical = Array.isArray(freshTask.acceptance_criteria) ? freshTask.acceptance_criteria : [];
              // 1. Authoritative criteria validation of the replay payload against
              // the fresh canonical set: shape/coverage/duplicate/unknown/missing/
              // satisfied:true/allowed-keys (the same checks ChangeStore.submitProof
              // applies). Malformed/false/duplicate payloads fail closed here with
              // their authoritative codes.
              validateProofCriteria(canonical, proof.criteria);
              // 2. Exact stored-proof equality: the caller's replay payload must
              // match the immutable stored proof on every worker-owned contract
              // field (revisions, integration fields, summary, deviations, worker
              // checks, and criteria — including order). Any difference → PROOF_MISMATCH.
              if (!proofsEqualExactly(stored, proof)) {
                throw Object.assign(
                  new Error(`stored Change proof does not exactly match the completion payload`),
                  { code: 'PROOF_MISMATCH', changeId: existingLink.id },
                );
              }
              // 3. REPLAY-003: the freshly-read canonical criteria must also equal
              // the criteria the stored proof was accepted against (exact canonical
              // ORDER and IDs) — a criteria reorder/change during the replay race
              // must not masquerade as a converged completion.
              const storedCriterionIds = (Array.isArray(stored.criteria) ? stored.criteria : []).map((/** @type {any} */ entry) => entry?.id);
              if (!proofFieldEqual(canonical.map(String), storedCriterionIds)) {
                throw Object.assign(
                  new Error(`task acceptance criteria changed during completion`),
                  { code: 'CRITERIA_MISMATCH', task: canonical.map(String) },
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
           try {
             validateProofCriteria(taskCriteria, proof.criteria);
           } catch (error) {
             // Preserve the integration boundary's historical mismatch code for
             // coverage drift while retaining strict validator codes for shape,
             // duplicate, false, and unexpected-key failures.
             if (error?.code === 'MISSING_CRITERION' || error?.code === 'UNKNOWN_CRITERION') {
               throw Object.assign(new Error('proof criteria do not match task acceptance_criteria'), {
                 code: 'CRITERIA_MISMATCH', task: taskCriteria, proof: proof.criteria,
               });
             }
             throw error;
           }
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
     * @param {{ preflight?: (proof: any) => boolean, controllerPreflightOverride?: string[], isStopped?: () => boolean }} [options]
     * @returns {Promise<{ outcome: 'review_started' | 'preflight_failed', sessionId?: string, changeId?: string }>}
     */
    runGovernedReview(taskId, options = {}) {
      const isStopped = typeof options.isStopped === 'function' ? options.isStopped : null;
      const ensureActive = () => {
        if (isStopped?.()) {
          throw Object.assign(new Error('review observer stopped'), { code: 'REVIEW_OBSERVER_STOPPED' });
        }
      };
      // T-H13 test seam: production keeps the 11-minute claim deadline, while
      // focused recovery tests may inject a short deterministic window/backoff.
      const reviewerRecovery = options.reviewerRecovery ?? {};
      const t = requireTask();
      const c = requireChange();
      requireTaskId(taskId);
      return (async () => {
        ensureActive();
        const task = await Promise.resolve(t.get(taskId));
        ensureActive();
        if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
        if (task.status !== 'in_review') {
          throw Object.assign(new Error(`expected task status in_review (got ${task.status})`), { code: 'INVALID_TASK_STATE' });
        }
        const change = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
        ensureActive();
        if (!change) throw Object.assign(new Error(`no Change linked to task ${taskId}`), { code: 'CHANGE_NOT_FOUND' });
        if (!['PREFLIGHT', 'REVIEW'].includes(change.state)) {
          throw Object.assign(new Error(`expected Change PREFLIGHT or REVIEW (got ${change.state})`), { code: 'INVALID_CHANGE_STATE' });
        }
        // T-H12: this review round is keyed by the Change's CURRENT
        // implementation revision. A reviewer round without a revision could
        // never accept a verdict (stale-revision rejection), so fail closed
        // here instead.
        const statusNow = await c.status(change.id);
        ensureActive();
        const revision = statusNow?.revision ?? null;
        if (typeof revision !== 'string' || revision.trim() === '') {
          throw Object.assign(
            new Error(`cannot start a review round for Change ${change.id} without an implementation revision`),
            { code: 'REVIEW_ROUND_REVISION_UNAVAILABLE', changeId: change.id },
          );
        }
        // The round's durable attribution: originating proof/attempt plus the
        // prior round's still-open finding IDs where available.
        const round = {
          revision,
          attemptId: Array.isArray(statusNow?.attempts) ? (statusNow.attempts.at(-1)?.attemptId ?? null) : null,
          proofCommit: statusNow?.proof?.commit_sha ?? null,
          findingIds: (Array.isArray(statusNow?.openFindings) ? statusNow.openFindings : [])
            .map((/** @type {any} */ f) => f?.id)
            .filter((/** @type {any} */ id) => typeof id === 'string'),
        };
        if (change.state === 'PREFLIGHT') {
          // Run the REAL store-level preflight: staleness vs currentRevision,
          // protected paths, and requiredChecks are all evaluated there.
          const proof = statusNow?.proof ?? null;
          const checkResults = (options.controllerPreflightOverride ?? proof?.controllerPreflight ?? []).map((/** @type {string} */ entry) => parseControllerPreflightEntry(entry));
          let preflightPassed;
          try {
            await c.runPreflight(change.id, {
              currentRevision: String(proof?.afterRevision ?? ''),
              changedFiles: Array.isArray(proof?.files_changed) ? proof.files_changed : [],
              checkResults,
            });
            ensureActive();
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
            ensureActive();
             await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'preflight_failed' });
             ensureActive();
            return { outcome: 'preflight_failed' };
          }
          ensureActive();
           await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'preflight_passed' });
           ensureActive();
        }
        // T-H5 PR1-02 + PR2-01: serialize check→launch→bind for ONE round.
        // The in-process tail lock is the fast local serializer (keyed by
        // Change+revision, T-H12: duplicate/concurrent wakes of the SAME
        // revision converge; a NEW revision never serializes against a stale
        // lock from a prior round); the durable cross-process claim
        // (reserveReviewerLaunch) guarantees no two host processes launch a
        // second reviewer for the round, adopts a crashed owner's recorded
        // session instead of re-launching it, and converges on the confirmed
        // round binding as the terminal record.
        // T-H12 round-5 (F1): only a FRESH launch attaches its observer
        // inline below; a reservation that converged on an EXISTING round
        // session (restart wake, confirmed binding, cross-process adoption)
        // reattaches observation right after the reservation resolves.
        let launchedHere = false;
        let launchedHandle = null;
        const sessionId = await withReviewerReservation(`${change.id}:${revision}`, async () => {
          return reserveReviewerLaunch({
             reviewerRecovery,
            isStopped,
            c, change, task, revision, round,
            // T-H12 round-4: authoritative request-liveness reconciliation for
            // an ambiguous durable record (session pre-send record present,
            // send marker absent): the REAL launcher's probe proves from host
            // session history whether THIS requestId was ever delivered. A
            // launcher without a probe reports 'unknown' — never duplicated,
            // just bounded-waited.
            probeRequest: (() => {
              let probeLauncher = null;
              try {
                probeLauncher = /** @type {any} */ (requireTask()).createReviewerLauncher?.(options.launcherOptions ?? {});
              } catch { probeLauncher = null; }
              return typeof probeLauncher?.probeRequest === 'function'
                ? (probeSessionId, probeRequestId) => probeLauncher.probeRequest(probeSessionId, probeRequestId)
                : undefined; // no probe surface: ambiguous records adopt as before
            })(),
            launch: async ({ file, identity, requestId }) => {
              let launched;
              try {
                launched = await launchReviewerForTask(requireTask, requireChange, requireTaskId, taskId, {
                  isStopped,
                  revision,
                  requestId,
                  // T-H12 round-4 pre-send marker: session.create accepted →
                  // persist sessionId + requestId with NO sent marker yet.
                  // (The REAL launcher invokes this at the true boundary, so
                  // the window between acceptance and this write is closed.)
                  recordCreated: async (createdSessionId) => {
                    await writeClaimRecord(file, {
                      claimant: identity, sessionId: createdSessionId,
                      requestId: requestId ?? null, sentAt: null,
                      ...round, updatedAt: Date.now(),
                    });
                  },
                  // Durable record of the launched session before the binding —
                  // the crash-recovery (adopt) record for a successor claim.
                  // Carries the full T-H12 round attribution; sentAt +
                  // requestId atomically mark THIS request as sent (T-H12
                  // round-3): a restart seeing this record adopts the session
                  // and never re-sends the request.
                  recordSession: async (launchSessionId) => {
                    await writeClaimRecord(file, {
                      claimant: identity, sessionId: launchSessionId,
                      requestId: requestId ?? null, sentAt: Date.now(),
                      ...round, updatedAt: Date.now(),
                    });
                  },
                  discardSession: async () => {
                    // Our launch is dead (terminated on failure): expire the
                    // claim so a successor takes over with a fresh launch
                    // instead of adopting a terminated session.
                    await writeClaimRecord(file, { claimant: identity, sessionId: null, ...round, updatedAt: Date.now() - 2 * REVIEWER_CLAIM_LEASE_MS })
                      .catch(() => {});
                  },
                });
              } catch (error) {
                if (isStopped?.()) throw error;
                // A launcher/session.prompt failure occurs before a reviewer
                // request exists. Expire this round's empty claim so the next
                // governed wake can recover immediately without a 10-minute
                // stale-claim wait or duplicate live session.
                await writeClaimRecord(file, {
                  claimant: identity, sessionId: null, ...round,
                  updatedAt: Date.now() - 2 * REVIEWER_CLAIM_LEASE_MS,
                }).catch(() => {});
                throw error;
              }
              ensureActive();
              // T-H12: durable audit of this round's ONE explicit reviewer
              // request (launch = the single production prompt), carrying
              // the same durable request identity the claim record persisted
              // before the send (T-H12 round-3).
              await c.appendAudit({
                kind: 'review_orchestration', changeId: change.id,
                action: 'review_round_requested',
                sessionId: launched.sessionId, revision,
                ...(requestId ? { requestId } : {}),
                ...(round.attemptId !== null ? { attemptId: round.attemptId } : {}),
                ...(round.proofCommit !== null ? { proofCommit: round.proofCommit } : {}),
                findingIds: round.findingIds,
              });
              // Keep the real launch handle until PREFLIGHT→REVIEW below.
              // In the NO_POLICY fallback a terminal history observed before
              // that transition would otherwise see PREFLIGHT and be lost.
              launchedHandle = launched.handle;
              launchedHere = true;
              return launched.sessionId;
            },
          });
        });
        ensureActive();
        // A successful store runPreflight is authoritative for the state
        // move: under a real preflight policy the store itself performed
        // PREFLIGHT→REVIEW. Re-read the live state and transition ONLY in
        // the NO_POLICY fallback, where the store did not move it. Crucially,
        // attach turn observation only AFTER this transition: an immediately
        // terminal real session must recover its REVIEW round, never observe
        // PREFLIGHT and disappear before the state move.
        const liveAfterPreflight = await c.get(change.id);
        ensureActive();
        if (liveAfterPreflight.state === 'PREFLIGHT') {
          await c.transition(change.id, 'REVIEW', { actor: 'review-orchestration' }).catch((err) => {
            if (err?.name !== 'ChangeDomainError') throw err;
            // T-H5 PR2-01: a concurrent controller advanced the stage while
            // we held the reservation — REVIEW→REVIEW is not a legal move,
            // so the stage already converged; its launch is bound under the
            // same claim we just released.
          });
          ensureActive();
        }
        let stopObserve = null;
        if (launchedHere) {
          stopObserve = observeReviewerTurn({
            handle: launchedHandle, c, change, task, revision, sessionId,
            rebuildReview: (stopped) => api.runGovernedReview(taskId, { isStopped: stopped }),
          });
        } else {
          stopObserve = await reattachReviewerTurnObservation({
            api, requireTask, requireChange, taskId, change, task, revision, sessionId, isStopped,
          }).catch(() => false);
        }
        // A stop may race either real `observeSession` or observer creation.
        // Neutralize the returned observation instead of leaving it untracked.
        if (isStopped?.()) {
          try { stopObserve?.(); } catch { /* best-effort */ }
          return { outcome: 'review_started', sessionId, changeId: change.id };
        }
        if (typeof stopObserve === 'function') activeObservationStops.add(stopObserve);
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
          // T-H12 round-3: settlement is bound to the CURRENT round — the
          // verdict must come from the reviewer session named by the durable
          // round record for the Change's current revision. Any other session
          // (e.g. a prior round's still-bound reviewer) can never settle this
          // round. When no round record exists (a reviewer bound outside the
          // governed round flow) the legacy binding checks above stand alone.
          const roundReviewer = await roundReviewerSession(c, change, task);
          if (roundReviewer && options.sessionId !== roundReviewer.sessionId) {
            await c.appendAudit({
              kind: 'review_orchestration', changeId: change.id,
              action: 'review_outcome_wrong_round_session',
              sessionId: options.sessionId,
              expectedSessionId: roundReviewer.sessionId,
              revision: latestRevision,
            });
            throw Object.assign(
              new Error(`session ${options.sessionId} is not the current review round's reviewer`),
              { code: 'STALE_ROUND_SESSION' },
            );
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
          // G4: publish APPROVED into the sync snapshot so the lifecycle
          // guard permits the in_review→done CAS immediately below.
          publishChangeState(taskId, change.id, 'APPROVED');
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
     * T-H12 round-4 — review-settlement guard installed on the ChangeStore by
     * the change-control tool wiring. The canonical change_submit_review seam
     * (and every other submitReview surface) consults this BEFORE any state
     * mutation: a reviewer session may settle a Change's CURRENT revision only
     * when it is the session named by that revision's durable round record.
     * A prior round's still-bound reviewer is rejected fail-closed
     * (STALE_ROUND_SESSION + audit); Changes not linked to a governed task
     * (standalone Change Control) and rounds without a durable round record
     * keep the legacy behavior untouched.
     *
     * @param {{ changeId: string, sessionId: string }} args
     * @returns {Promise<void>} resolves when the settlement is authorized
     */
    async reviewSettlementGuard({ changeId, sessionId, lockedChange = null, currentRevision = null, lockedBindings = null, locked = false } = {}) {
      const c = requireChange();
      const change = lockedChange ?? await c.get(changeId).catch(() => null);
      if (!change?.workItem || change.workItem.system !== WORK_ITEM_SYSTEM) return;
      if (change.state !== 'REVIEW') return;
      let task = null;
      try {
        const t = requireTask();
        task = await Promise.resolve(t.get(change.workItem.id)).catch(() => null);
      } catch { task = null; }
      if (!task) {
        throw Object.assign(new Error(`governed review round unavailable for Change ${changeId}`), { code: 'STALE_ROUND_SESSION' });
      }
      const revision = currentRevision ?? (await c.status(changeId).catch(() => null))?.revision ?? null;
      const round = await roundReviewerSessionForRevision(c, change, task, revision, lockedBindings).catch(() => null);
      const audit = {
        kind: 'review_orchestration', changeId,
        action: round ? 'review_submit_wrong_round_session' : 'review_submit_missing_round',
        sessionId,
        ...(round?.sessionId ? { expectedSessionId: round.sessionId } : {}),
        revision,
      };
      if (!round || round.sessionId !== sessionId) {
        if (locked) {
          throw Object.assign(
            new Error(round ? `session ${sessionId} is not the current review round's reviewer` : `no durable review round for Change ${changeId}`),
            { code: 'STALE_ROUND_SESSION', reviewSettlementAudit: audit },
          );
        }
        await c.appendAudit(audit).catch(() => {});
        throw Object.assign(
          new Error(round ? `session ${sessionId} is not the current review round's reviewer` : `no durable review round for Change ${changeId}`),
          { code: 'STALE_ROUND_SESSION' },
        );
      }
      if (!locked) return;
      // A lock-context guard has already validated the durable round and binding.
      return;


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
     *   leaseSeconds?: number,
     *   isStopped?: () => boolean }} [options]
     * @returns {Promise<{ outcome: string, [key: string]: any }>}
     */
    runGovernedSdlc(taskId, options = {}) {
      const t = requireTask();
      const c = requireChange();
      requireTaskId(taskId);
      const maxRepairRounds = options.maxRepairRounds ?? 3;
      const isStopped = typeof options.isStopped === 'function' ? options.isStopped : undefined;
      // The verdict is one-shot per call: a repair loop that re-enters the
      // REVIEW stage must never re-settle the same verdict.
      let verdict = options.verdict && (options.verdict.verdict === 'pass' || options.verdict.verdict === 'fail')
        ? options.verdict
        : null;
      return (async () => {
        let iterations = 0;
        // T-H12 round-5 (F1): sessions whose launch path already attached turn
        // observation in THIS SDLC invocation. A fresh launch observes its own
        // handle inline, so the immediately-following REVIEW iteration must not
        // reattach a second observer (live-turn churn / duplicate recovery) —
        // only a later independent wake (restart / cross-process) reattaches.
        const observedLaunchSessionIds = new Set();
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
              // APPROVED is the only state that permits a task's transition
              // to done; publish the authoritative state so the guard lets
              // this convergence write through.
              publishChangeState(taskId, change.id, 'APPROVED');
              const converged = t.updateIf(taskId, { status: 'in_review' }, { status: 'done' });
              if (converged === null) continue; // moved concurrently — re-read
              await c.appendAudit({ kind: 'review_orchestration', changeId: change.id, action: 'review_pass_converged' });
            }
            return { outcome: 'approved', taskId, changeId: change.id };
          }
          // T-H11: a reviewer-submitted FAIL persisted REVIEW→REPAIR before the
          // controller was woken (the review-settled event fires AFTER durable
          // persistence). Settle the still-in_review task side here, symmetric
          // with the APPROVED block above, so the change never bypasses the
          // task-side changes_requested transition and its settlement audit.
          if (state === 'REPAIR' && task.status === 'in_review') {
            const settled = await settleReviewedFailure(taskId, change.id, t, c, maxRepairRounds);
            if (settled !== null) {
              if (settled.outcome === 'task_update_race') continue; // re-read
              return settled; // 'escalated'
            }
            // task is now changes_requested — fall through to repair routing
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
            const rv = await api.runGovernedReview(taskId, { controllerPreflightOverride: options.controllerPreflightOverride, isStopped, reviewerRecovery: options.reviewerRecovery });
            if (rv.outcome === 'preflight_failed') {
              return { outcome: 'preflight_failed', taskId, changeId: change.id };
            }
            // The launch path just attached turn observation to this session's
            // own handle; the next REVIEW iteration must not reattach.
            if (rv.outcome === 'review_started' && typeof rv.sessionId === 'string') {
              observedLaunchSessionIds.add(rv.sessionId);
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
                // Re-read confirmed APPROVED (the concurrent reviewer settled
                // through Change Control tools): publish so the guard allows
                // the convergence CAS.
                publishChangeState(taskId, change.id, 'APPROVED');
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
              // Still REVIEW: the verdict must arrive as data. T-H12: only
              // a reviewer session attributed to the CURRENT revision's
              // durable round record satisfies this round — a prior round's
              // still-bound session never does.
              let reviewer = await roundReviewerSession(c, change, task);
              // T-H12 round-4: a reviewer turn PROVEN ended without settling
              // its round is handled by the production turn observer
              // (observeReviewerTurn, wired to the real launcher handle at
              // request time) — it expires only that round and issues one
              // fresh request. This wake path just re-reads durable state.
              if (!reviewer) {
                // This round's request is missing (crash between transition
                // and launch/bind, or the Change advanced to a new revision
                // while only a prior round's reviewer was bound): issue
                // exactly one new explicit review round without re-running
                // preflight.
                const rv = await api.runGovernedReview(taskId, { controllerPreflightOverride: options.controllerPreflightOverride, isStopped, reviewerRecovery: options.reviewerRecovery });
                if (rv.outcome === 'preflight_failed') {
                  return { outcome: 'preflight_failed', taskId, changeId: change.id };
                }
                reviewer = (await roundReviewerSession(c, change, task)) ?? { sessionId: rv.sessionId };
              } else {
                // T-H12 round-5 (F1): this wake found the round's confirmed
                // session through durable state alone (controller restart or
                // cross-process wake) — reattach production observation to
                // the REAL session lifecycle so a dead/unreachable turn is
                // recovered instead of the round hanging in review_pending.
                // Skip when the launch path already attached observation to
                // this session in the SAME invocation (no second observer).
                if (!observedLaunchSessionIds.has(reviewer.sessionId)) {
                  const stopObserve = await reattachReviewerTurnObservation({
                    api, requireTask, requireChange, taskId, change, task,
                    sessionId: reviewer.sessionId, isStopped,
                  }).catch(() => false);
                  if (typeof stopObserve === 'function') activeObservationStops.add(stopObserve);
                }
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
        // G4: in_review + APPROVED is a durable mismatch that Phase 2
        // converges to done — not a manual-intervention finding.
        const isG4TerminalConvergence = task.status === 'in_review' && change.state === 'APPROVED';
        const pairing = (isHalfCompletionShape || isG4TerminalConvergence) ? { ok: true } : validatePairing(task.status, change.state);
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

        // G4 terminal convergence: task still in_review but its Change is
        // terminal-APPROVED (e.g. the reviewer approved the Change but the
        // convergence CAS raced or the process restarted before running).
        // Publish APPROVED into the sync snapshot so the lifecycle guard
        // permits the in_review→done CAS, then converge the task.
        if (task.status === 'in_review' && change.state === 'APPROVED') {
          publishChangeState(taskId, change.id, 'APPROVED');
          const converged = t.updateIf(taskId, { status: 'in_review' }, { status: 'done' });
          if (converged) {
            await c.appendAudit({ kind: 'reconciliation', changeId: change.id, action: 'g4_terminal_converged' });
            repairs.push({ kind: 'g4_terminal_converged' });
          }
          // C4 (repair-round-3) — captain-set boundary decision: terminal
          // G4 convergence is a distinct reconciliation path. Keep the
          // legacy in_review projection-realignment pass separate rather than
          // mixing it into this terminal status transition; this return is
          // deliberate and records that boundary.
          return { repairs, manualIntervention };
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

    /**
     * Controller-owned governed planning startup.
     *
     * Host-side only: binds the AUTHENTICATED session as 'planner' on the
     * task's linked Change through the public Change Control facade, appends
     * the authoritative audit, and stops. It never plans, approves, or
     * dispatches, and it never reads the model-supplied `sessionId` field:
     * authority comes exclusively from `runtimeContext.authenticatedSessionId`.
     *
     * Idempotent: an existing compatible planner binding (including a
     * manually-created one) is reused without a duplicate bind. An
     * incompatible binding for the same session, or a bind/authorization
     * failure, fails closed with a typed machine-readable error.
     *
     * @param {string} taskId
     * @param {{ authenticatedSessionId?: string, actor?: string }} [runtimeContext]
     * @returns {Promise<{ ok: boolean, taskId: string, changeId: string, sessionId: string, reused: boolean }>}
     */
    startGovernedPlanning(taskId, runtimeContext) {
      return (async () => {
        const t = requireTask();
        const c = requireChange();
        requireTaskId(taskId);
        // A null/undefined runtime context must fail closed with a typed
        // identity error BEFORE any store lookup. Coerce null to {} so the
        // `authenticatedSessionId` read below is a plain property access that
        // yields '', tripping the typed guard, instead of a raw TypeError.
        const context = runtimeContext || {};
        // Identity is checked BEFORE any store lookup so a missing
        // authenticated session fails without touching task/change state.
        const sessionId = typeof context.authenticatedSessionId === 'string'
          ? context.authenticatedSessionId.trim()
          : '';
        if (sessionId === '') {
          throw Object.assign(
            new Error('authenticatedSessionId is required from the host runtime context'),
            { code: 'AUTHENTICATED_SESSION_REQUIRED' },
          );
        }
        const actor = typeof context.actor === 'string' && context.actor.trim() !== ''
          ? context.actor
          : 'controller';
        const task = await Promise.resolve(t.get(taskId));
        if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
        const change = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
        if (!change) {
          throw Object.assign(
            new Error(`no Change linked to task ${taskId}`),
            { code: 'TASK_NOT_LINKED', taskId },
          );
        }
        // An audit append after a durable planner binding is the ONLY remaining
        // action that can fail on a successful bind. Wrap it: the binding is
        // persisted (retry is safe/idempotent) but startup did not fully
        // record, so report a typed, recoverable partial — never a raw audit
        // error and never a false success.
        const recordPlanningAudit = async (action) => {
          try {
            await c.appendAudit({
              kind: 'governed_planning',
              changeId: change.id,
              sessionId,
              actor,
              action,
            });
          } catch (error) {
            throw Object.assign(
              new Error(`governed planning startup: ${action} audit failed after planner binding persisted`),
              {
                code: 'PLANNING_STARTUP_PARTIAL',
                recoverable: true,
                bindingPersisted: true,
                taskId,
                changeId: change.id,
                sessionId,
                cause: error,
              },
            );
          }
        };
        const readBinding = async () => {
          // A NULL binding is the only no-binding path: the session has no
          // existing role on this Change. A getBinding EXCEPTION (storage or
          // authorization failure) must fail closed — treating it as "no
          // binding" would silently fall through to a fresh bindRole, letting
          // an unauthorized or unreadable state masquerade as a clean bind.
          try {
            return await c.getBinding(change.id, sessionId);
          } catch (error) {
            const code = error && typeof error === 'object' && typeof error.code === 'string'
              ? error.code
              : 'BINDING_LOOKUP_FAILED';
            throw Object.assign(
              new Error(error instanceof Error ? error.message : String(error)),
              { code, taskId, changeId: change.id, cause: error },
            );
          }
        };
        let binding = await readBinding();
        if (binding) {
          if (binding.role !== 'planner') {
            throw Object.assign(
              new Error(`session ${sessionId} is bound as ${binding.role}, not planner, for Change ${change.id}`),
              { code: 'PLANNER_BINDING_CONFLICT', taskId, changeId: change.id },
            );
          }
          await recordPlanningAudit('planner_binding_reused');
          return { ok: true, taskId, changeId: change.id, sessionId, reused: true };
        }
        try {
          await c.bindRole(change.id, sessionId, 'planner', { actor });
        } catch (error) {
          // Concurrent duplicate startup: a second host already bound this
          // exact session as planner while we were in flight. ALREADY_BOUND
          // is NOT a failure — re-read the authoritative binding; if the
          // winner is a planner, converge to a successful idempotent
          // (reused) startup. Any other role or a missing winner still
          // fails closed. A single re-read is sufficient; a non-planner
          // result below re-throws, so this never loops.
          const isAlreadyBound = error && typeof error === 'object'
            && typeof error.code === 'string' && error.code === 'ALREADY_BOUND';
          if (isAlreadyBound) {
            binding = await readBinding();
            if (binding && binding.role === 'planner') {
              await recordPlanningAudit('planner_binding_reused');
              return { ok: true, taskId, changeId: change.id, sessionId, reused: true };
            }
            if (binding && binding.role !== 'planner') {
              throw Object.assign(
                new Error(`session ${sessionId} is bound as ${binding.role}, not planner, for Change ${change.id}`),
                { code: 'PLANNER_BINDING_CONFLICT', taskId, changeId: change.id, cause: error },
              );
            }
            // Winner not yet visible: keep the authoritative ALREADY_BOUND
            // machine-readable code and fail closed (no overwrite, no
            // downstream planning/approval/dispatch).
            throw Object.assign(
              new Error(error instanceof Error ? error.message : String(error)),
              { code: 'ALREADY_BOUND', taskId, changeId: change.id, cause: error },
            );
          }
          const code = error && typeof error === 'object' && typeof error.code === 'string'
            ? error.code
            : 'BIND_FAILED';
          throw Object.assign(
            new Error(error instanceof Error ? error.message : String(error)),
            { code, taskId, changeId: change.id, cause: error },
          );
        }
        await recordPlanningAudit('planner_bound');
        return { ok: true, taskId, changeId: change.id, sessionId, reused: false };
      })();
    },

    /**
     * M1-S3-R1 — session-backed controller claim boundary.
     *
     * At the owned trusted DSH execution/controller boundary, derive the
     * authenticated session S EXCLUSIVELY from exec.agent.id (the host
     * identity). Model-supplied payload fields — worker, sessionId,
     * claimed_by, captain — are ordinary spoofable values and are ignored
     * for ownership: they never become the owner, never release or
     * overwrite a claim, and are never passed to the planning startup.
     *
     * Ownership flows through the public Task Orchestrator API:
     * taskOrchestrator.claim(taskId, S) makes S the claim owner;
     * startGovernedPlanning(taskId, { authenticatedSessionId: S }) then
     * binds the SAME S as 'planner' on the task's linked Change
     * (same-principal governed planning).
     *
     * Fail closed BEFORE mutation when the identity is missing: no task
     * lookup, no claim, no binding. A task already claimed by S is an
     * idempotent no-op (matching ownership). A claim held by anyone else
     * fails closed with CONTROLLER_CLAIM_CONFLICT — no release, no
     * overwrite, no planning startup. The generic task_claim surface is
     * untouched (M1-S1/R2 unchanged).
     *
     * @param {string} taskId
     * @param {{ agent?: { id?: string } }} exec trusted host execution context
     * @param {object} [payload] model-supplied payload (worker/sessionId/claimed_by/captain) — ignored for ownership
     * @returns {Promise<{ ok: boolean, taskId: string, changeId: string, sessionId: string, reused: boolean }>}
     */
    startControllerOwnedPlanning(taskId, exec, payload) {
      return (async () => {
        const t = requireTask();
        const c = requireChange();
        requireTaskId(taskId);
        // S is derived EXCLUSIVELY from the trusted host execution identity
        // (exec.agent.id). payload (worker/sessionId/claimed_by/captain) is
        // never consulted for ownership — it is spoofable model data.
        const S = exec
          && typeof exec === 'object'
          && exec.agent && typeof exec.agent === 'object'
          && typeof exec.agent.id === 'string'
          ? exec.agent.id.trim()
          : '';
        // Fail closed BEFORE mutation: no task lookup, no claim, no binding
        // when the trusted identity is missing.
        if (S === '') {
          throw Object.assign(
            new Error('exec.agent.id is required from the trusted host execution context'),
            { code: 'AUTHENTICATED_SESSION_REQUIRED', taskId },
          );
        }
        // Ownership check BEFORE any mutation. Read the current claim holder.
        const task = await Promise.resolve(t.get(taskId));
        if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND', taskId });
        const currentOwner = task.claimed_by ?? null;
        if (currentOwner !== null && currentOwner !== S) {
          // Conflicting ownership: fail closed WITHOUT release/overwrite and
          // WITHOUT planning startup.
          throw Object.assign(
            new Error(`task ${taskId} is claimed by ${currentOwner}, not ${S}`),
            { code: 'CONTROLLER_CLAIM_CONFLICT', taskId, claimedBy: currentOwner, authenticatedSessionId: S },
          );
        }
        // Matching ownership (currentOwner === S) is an idempotent no-op claim.
        // No claim, no mutation, no planning startup — just converge.
        // (The claim boundary is already satisfied; the planner binding is
        // authoritative and idempotent on its own side.)
        void payload; // payload is explicitly ignored for ownership (spoofable).
        // Claim the task under S through the public Task Orchestrator API.
        // When currentOwner is null this performs the claim; when it equals S
        // the claim is a matching-ownership no-op (idempotent).
        if (currentOwner === null) {
          const claimOptions = typeof t.claim === 'function' ? {} : undefined;
          await Promise.resolve(t.claim(taskId, S, claimOptions));
        }
        // Same-principal governed planning: pass EXACTLY S (never the
        // model-supplied sessionId/worker/captain) to the planner startup.
        const result = await api.startGovernedPlanning(taskId, {
          authenticatedSessionId: S,
          actor: 'controller',
        });
        return { ...result, ok: true, taskId, sessionId: S, changeId: result.changeId ?? (await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId))?.id ?? result.changeId };
      })();
    },

    /**
     * M1-S3 — release a controller-owned planning claim into the canonical
     * governed dispatcher. Host-only: the authenticated session and worker
     * profile must come from runtimeContext, never from a task/model payload.
     * The dispatcher owns the worker claim/start; this method only releases
     * the matching controller claim through the public Task Orchestrator API.
     *
     * @param {string} taskId
     * @param {{ authenticatedSessionId?: string, workerProfile?: string, actor?: string }} runtimeContext
     * @returns {Promise<any>}
     */
    handoffGovernedDispatch(taskId, runtimeContext) {
      requireTaskId(taskId);
      // Validate host-provided identity and dispatch selection before any
      // authoritative task lookup, replay shortcut, or in-flight reuse.
      const context = runtimeContext || {};
      const authenticatedSessionId = context
        && typeof context === 'object'
        && !Array.isArray(context)
        && typeof context.authenticatedSessionId === 'string'
        ? context.authenticatedSessionId.trim()
        : '';
      if (authenticatedSessionId === '') {
        return Promise.reject(Object.assign(
          new Error('authenticatedSessionId is required from the host runtime context'),
          { code: 'AUTHENTICATED_SESSION_REQUIRED', taskId },
        ));
      }
      const profile = typeof context.workerProfile === 'string' ? context.workerProfile.trim() : '';
      if (profile === '') {
        return Promise.reject(Object.assign(
          new Error('workerProfile is required from the host runtime context'),
          { code: 'WORKER_PROFILE_REQUIRED', taskId },
        ));
      }
      const actor = typeof context.actor === 'string' && context.actor.trim() !== ''
        ? context.actor
        : 'controller';
      const previous = handoffCompleted.get(taskId);
      if (previous) {
        if (previous.authenticatedSessionId !== authenticatedSessionId || previous.workerProfile !== profile) {
          return Promise.reject(Object.assign(
            new Error(`handoff for task ${taskId} is already owned by another runtime request`),
            { code: 'CONTROLLER_CLAIM_CONFLICT', taskId, authenticatedSessionId },
          ));
        }
        return Promise.resolve({ ...previous, replay: true, dispatched: false });
      }
      const active = handoffInFlight.get(taskId);
      if (active) {
        if (active.authenticatedSessionId !== authenticatedSessionId || active.profile !== profile) {
          return Promise.reject(Object.assign(
            new Error(`handoff for task ${taskId} is already owned by another runtime request`),
            { code: 'CONTROLLER_CLAIM_CONFLICT', taskId, authenticatedSessionId },
          ));
        }
        return active.promise;
      }
      const operation = (async () => {
        // Missing capabilities never fall back to a raw dispatcher or direct
        // state mutation.
        const t = requireTask();
        const c = requireChange();
        if (typeof t.get !== 'function') {
          throw unavailable('taskOrchestrator.get not provided');
        }
        if (typeof t.release !== 'function') {
          throw unavailable('taskOrchestrator.release not provided');
        }
        if (typeof c.findByWorkItem !== 'function' || typeof c.status !== 'function') {
          throw unavailable('changeControl linkage/status projections not provided');
        }
        const task = await Promise.resolve(t.get(taskId));
        if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND', taskId });
        if (task.status !== 'claimed' && task.status !== 'running' && task.status !== 'ready') {
          return { ok: true, dispatched: false, reason: 'not_handoffable', taskId, status: task.status };
        }

        // Construct and validate the governed dispatcher before releasing any
        // controller claim. This preserves the claim when the live governed
        // seam is unavailable or malformed.
        const dispatcher = api.createGovernedDispatcher();
        if (!dispatcher || typeof dispatcher.dispatchOnce !== 'function') {
          throw unavailable('governed dispatcher.dispatchOnce not provided');
        }
        const change = await Promise.resolve(c.findByWorkItem(WORK_ITEM_SYSTEM, taskId));
        if (change) {
          const changeStatus = await Promise.resolve(c.status(change.id));
          if (!changeStatus || !changeStatus.acceptedPlan || changeStatus.state !== 'READY') {
            throw Object.assign(
              new Error(`linked Change for task ${taskId} is not READY with an accepted plan`),
              { code: 'DISPATCH_NOT_GOVERNED', taskId, changeId: change.id },
            );
          }
        }

        if (task.status === 'claimed' || task.status === 'running') {
          // A restarted host may observe the worker claim created by an earlier
          // successful handoff. Recognize only the dispatcher run-id shape for
          // this exact profile; every other owner remains a hard conflict.
          if (task.claimed_by !== authenticatedSessionId
            && typeof task.claimed_by === 'string'
            && task.claimed_by.startsWith(`${profile}:`)) {
            return { ok: true, dispatched: false, reason: 'already_worker_owned', taskId, status: task.status };
          }
          // Only the exact authenticated controller owner may hand its claim
          // back. A stale or conflicting owner fails closed before dispatch.
          if (task.claimed_by !== authenticatedSessionId) {
            throw Object.assign(
              new Error(`task ${taskId} is not owned by authenticated controller ${authenticatedSessionId}`),
              { code: 'CONTROLLER_CLAIM_CONFLICT', taskId, claimedBy: task.claimed_by ?? null, authenticatedSessionId },
            );
          }
          const released = await Promise.resolve(t.release(taskId, task.claimed_by, { actor }));
          if (!released || released.released !== true) {
            throw Object.assign(
              new Error(`controller claim for task ${taskId} was not released`),
              { code: 'CONTROLLER_RELEASE_FAILED', taskId, release: released ?? null },
            );
          }
        } else if (task.status === 'ready') {
          // Ready is dispatcher's handoff state. Any owner on a ready row is
          // inconsistent and must not be overwritten by this controller.
          if (task.claimed_by !== null && task.claimed_by !== undefined && task.claimed_by !== '') {
            throw Object.assign(
              new Error(`ready task ${taskId} has conflicting owner ${task.claimed_by}`),
              { code: 'CONTROLLER_CLAIM_CONFLICT', taskId, claimedBy: task.claimed_by, authenticatedSessionId },
            );
          }
        } else {
          return { ok: true, dispatched: false, reason: 'not_handoffable', taskId, status: task.status };
        }

        const result = await dispatcher.dispatchOnce({ workerProfile: profile, limit: 1 });
        const completed = {
          ok: true,
          taskId,
          workerProfile: profile,
          authenticatedSessionId,
          result,
        };
        if (result?.dispatched === true) handoffCompleted.set(taskId, completed);
        return completed;
      })();
      const entry = { promise: operation, authenticatedSessionId, profile };
      handoffInFlight.set(taskId, entry);
      return operation.finally(() => {
        if (handoffInFlight.get(taskId) === entry) handoffInFlight.delete(taskId);
      });
    },

    /** True when both domain services are resolvable right now. */
    isAvailable() {
      return Boolean(taskOrchestrator() && changeControl());
    },

    /**
     * T-H12 round-5 (F1) — neutralize every live reviewer-turn observation
     * owned by this service instance. Called on controller disposal so a
     * disposing host stops recovering turns the fresh (restarted/adopting)
     * host now owns. Idempotent; observation already stopped is a no-op.
     */
    stopReviewerObservation() {
      for (const stop of activeObservationStops) { try { stop(); } catch { /* best-effort */ } }
      activeObservationStops.clear();
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
 * reviewer-claim-<changeId>-<encoded revision>` (T-H12: one round record per
 * Change+revision, carrying the round's session, revision, originating
 * proof attempt, and prior open finding IDs). The shared task workspace is
 * the stable anchor every host process owning the task sees; hosts without
 * a workspace fall back to the shared host tmpdir (wiped on host reboot,
 * where all sessions are dead anyway and a fresh launch is the correct
 * convergence).
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
const REVIEWER_RECOVERY_BACKOFF_MAX_MS = 1000;
/** Bounded wait: lease + grace, so a corrupt record can never block forever. */
const REVIEWER_CLAIM_WAIT_MS = REVIEWER_CLAIM_LEASE_MS + 60_000;

function milliseconds(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function recoveryBackoff(attempt, baseMs, maxMs) {
  if (baseMs <= 0 || maxMs <= 0) return 0;
  return Math.min(maxMs, baseMs * (2 ** Math.min(Math.max(attempt - 1, 0), 30)));
}

/**
 * T-H12: one durable review-round record per (Change, revision). The
 * revision is path-encoded so a replaced implementation can never reuse the
 * prior round's claim/session/binding — every new REVIEW revision requires
 * its own explicit reviewer request.
 * @param {any} change
 * @param {any} task
 * @param {string} [revision]
 * @returns {string}
 */
function reviewerClaimFile(change, task, revision) {
  const base = typeof task?.workspace === 'string' && task.workspace.trim() !== ''
    ? task.workspace
    : tmpdir();
  const round = revision === undefined || revision === null
    ? ''
    : `-${encodeURIComponent(String(revision))}`;
  return join(base, '.dsh-governance', 'reviewer-claims', `reviewer-claim-${String(change.id)}${round}`);
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

/**
 * Sleep without leaving a recovery fiber asleep after its controller is
 * disposed. The short polling slices also keep cancellation responsive while
 * preserving a deterministic backoff (no jitter).
 * @param {number} ms
 * @param {(() => boolean) | undefined} isStopped
 * @returns {Promise<boolean>} false when cancellation was observed
 */
function sleep(ms, isStopped) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration === 0) return Promise.resolve(!isStopped?.());
  return new Promise((resolve) => {
    const deadline = Date.now() + duration;
    let timer;
    const tick = () => {
      if (isStopped?.()) {
        if (timer) clearTimeout(timer);
        resolve(false);
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        resolve(true);
        return;
      }
      timer = setTimeout(tick, Math.min(REVIEWER_CLAIM_POLL_MS, remaining));
    };
    tick();
  });
}

/**
 * Keep a stuck host probe inside the same recovery deadline. A stop callback
 * is polled while the RPC is pending because the RPC seam has no AbortSignal.
 */
function probeWithinDeadline(probeRequest, sessionId, requestId, deadline, isStopped) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve('unknown');
  return new Promise((resolve) => {
    let settled = false;
    let timeout;
    let stopTimer;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(stopTimer);
      resolve(verdict);
    };
    timeout = setTimeout(() => finish('unknown'), remaining);
    const checkStopped = () => {
      if (isStopped?.() || Date.now() >= deadline) {
        finish('unknown');
        return;
      }
      stopTimer = setTimeout(checkStopped, Math.min(REVIEWER_CLAIM_POLL_MS, deadline - Date.now()));
    };
    if (isStopped) checkStopped();
    Promise.resolve()
      .then(() => probeRequest(sessionId, requestId))
      .then(finish, () => finish('unknown'));
  });
}

/**
 * The claim protocol (see module notes), T-H12 revision-keyed. Never launches
 * a reviewer while THIS round's durable record is live: reuses the round's
 * confirmed binding, adopts the round's recorded (launched-but-unbound)
 * session, waits for a live owner, or takes over a stale claim — then hands
 * off to `launch`, which records its session durably before binding.
 *
 * T-H12 attribution rule: a reviewer binding satisfies the round ONLY when
 * the round's own durable record (keyed Change+revision) names its session.
 * A prior round's binding — still live or not — never substitutes for the
 * new revision's explicit request.
 *
 * @param {{
 *   c: any, change: any, task: any,
 *   revision: string,
 *   round?: { revision: string, attemptId?: string|null, proofCommit?: string|null, findingIds?: string[] },
 *   launch: (holder: { file: string, identity: string, requestId: string }) => Promise<string>,
 *   probeRequest?: (sessionId: string, requestId: string | null) => Promise<'sent'|'unsent'|'unknown'>,
 *   isStopped?: () => boolean,
 *   reviewerRecovery?: { deadlineMs?: number, pollMs?: number, backoffMs?: number, backoffMaxMs?: number },
 * }} deps
 * @returns {Promise<string>} the reviewer session id to use
 */
async function reserveReviewerLaunch({
  c, change, task, revision, round, launch, probeRequest, isStopped,
  reviewerRecovery = {},
}) {
  const ensureActive = () => {
    if (isStopped?.()) {
      throw Object.assign(new Error('review observer stopped'), { code: 'REVIEW_OBSERVER_STOPPED' });
    }
  };
  ensureActive();
  const file = reviewerClaimFile(change, task, revision);
  const lockFile = reclaimLockFile(file);
  const identity = claimIdentity();
  const waitMs = milliseconds(reviewerRecovery.deadlineMs, REVIEWER_CLAIM_WAIT_MS);
  const pollMs = milliseconds(reviewerRecovery.pollMs, REVIEWER_CLAIM_POLL_MS);
  const backoffMs = milliseconds(reviewerRecovery.backoffMs, pollMs);
  const backoffMaxMs = milliseconds(reviewerRecovery.backoffMaxMs, REVIEWER_RECOVERY_BACKOFF_MAX_MS);
  const deadline = Date.now() + waitMs;
  let unknownAttempts = 0;
  const uncertain = (record) => {
    const error = Object.assign(
      new Error(`reviewer request delivery remains uncertain for session ${record?.sessionId ?? '(unknown)'}`),
      {
        code: 'REVIEWER_REQUEST_UNCERTAIN',
        recoverable: true,
        details: {
          changeId: change.id,
          revision,
          sessionId: record?.sessionId ?? null,
          requestId: record?.requestId ?? null,
          attempts: unknownAttempts,
        },
      },
    );
    return error;
  };
  // The round's request is satisfied iff the durable round record names the
  // session AND its reviewer binding is persisted (both durable).
  const confirmedRoundBinding = async (record) => {
    const sessionId = record && typeof record.sessionId === 'string' ? record.sessionId : null;
    if (!sessionId) return null;
    const binding = await c.getBinding(change.id, sessionId).catch(() => null);
    return binding && binding.role === 'reviewer' ? sessionId : null;
  };
  const adopt = async (sessionId, claimant) => {
    ensureActive();
    await c.bindRole(change.id, sessionId, 'reviewer')
      .catch((err) => { if (err?.code === 'ALREADY_BOUND') return null; throw err; });
    ensureActive();
    await c.appendAudit({
      kind: 'review_orchestration', changeId: change.id, action: 'reviewer_claim_adopted',
      sessionId, claimant: claimant ?? null,
    });
    ensureActive();
    return sessionId;
  };
  for (;;) {
    ensureActive();
    const { exists, incomplete, value: record } = await readClaimRecord(file);
    ensureActive();
    // 1. This round's confirmed binding: durable and visible across
    //    processes — reuse it, never re-request.
    const bound = await confirmedRoundBinding(record);
    ensureActive();
    if (bound) return bound;

    const stale = !incomplete && exists
      ? Date.now() - Number(record.updatedAt || 0) > REVIEWER_CLAIM_LEASE_MS
      : false;

    // 2. A launched session is recorded but not yet bound: the owner is
    //    mid-bind (wait for convergence) or crashed (adopt). Adoption binds
    //    the recorded session instead of launching a duplicate — the
    //    orphaned reviewer is reconciled, not re-created.
    if (record?.sessionId && typeof record.sessionId === 'string') {
      if (!stale) {
        if (Date.now() >= deadline) {
          throw Object.assign(new Error('reviewer claim owner has not bound its session within the wait window'), { code: 'REVIEWER_CLAIM_TIMEOUT' });
        }
        await sleep(pollMs, isStopped);
        ensureActive();
        continue;
      }
      // T-H12 round-4: a stale record with a session but NO send marker is
      // ambiguous (crash after session.create / after prompt acceptance /
      // response lost). Re-requesting here could duplicate a LIVE request;
      // re-binding could adopt a session that never received it. Resolve
      // authoritatively through the launcher probe UNDER the reclaim lock;
      // without a probe surface the outcome remains unknown and is handled
      // with the same bounded fail-closed recovery.
      const hasRequestId = typeof record.requestId === 'string' && record.requestId !== '';
      if (record.sentAt == null && hasRequestId) {
        // fall through to the serialized section below; without a probe
        // surface the outcome is unknown and must still fail closed.
      } else {
        // Stale owner: bind the recorded session (a concurrent adopter may
        // have beaten us — ALREADY_BOUND is successful convergence).
        ensureActive();
        return await adopt(record.sessionId, record.claimant);
      }
    }

    // 3. Fresh claim with no session: its owner is mid-launch — wait for
    //    the session to be recorded (bounded), never launch a second
    //    reviewer.
    if (exists && !incomplete && !stale) {
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('reviewer claim wait exceeded window'), { code: 'REVIEWER_CLAIM_TIMEOUT' });
      }
      await sleep(pollMs, isStopped);
      ensureActive();
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
      ensureActive();
      if (await acquireReclaimLock(lockFile, identity)
        && await verifyReclaimLockHeld(lockFile, identity)) {
        try {
          ensureActive();
        } catch (error) {
          await releaseReclaimLock(lockFile, identity);
          throw error;
        }
        break;
      }
      ensureActive();
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('reviewer claim wait exceeded window'), { code: 'REVIEWER_CLAIM_TIMEOUT' });
      }
      await sleep(pollMs, isStopped);
    }
    let created = false;
    let createdRequestId = null;
    let adopted;
    let adoptedRequestId = null;
    let unknownRecord = null;
    let unknownDelay = 0;
    try {
      // Re-validate UNDER the lock: the claim may have changed since we read.
      const r = await readClaimRecord(file);
      ensureActive();
      const boundNow = await confirmedRoundBinding(r.value);
      ensureActive();
      if (boundNow) return boundNow;
      const rStale = !r.incomplete && r.exists
        ? Date.now() - Number(r.value.updatedAt || 0) > REVIEWER_CLAIM_LEASE_MS
        : false;
      if (r.value?.sessionId && typeof r.value.sessionId === 'string' && rStale
        && r.value.sentAt == null
        && typeof r.value.requestId === 'string' && r.value.requestId !== '') {
        // AMBIGUOUS stale record (round-4): the session exists but the send
        // marker is missing — the owner crashed somewhere between session
        // acceptance and marking the send. Prove liveness through the real
        // launcher probe (host session history) before deciding:
        const verdict = typeof probeRequest === 'function'
          ? await probeWithinDeadline(probeRequest, r.value.sessionId, r.value.requestId, deadline, isStopped)
          : 'unknown';
        ensureActive();
        if (verdict === 'sent') {
          // The request WAS delivered (proof positive): adopt the SAME
          // session, mark the send durably, and never re-prompt/re-launch
          // this request identity.
          adopted = await adopt(r.value.sessionId, r.value.claimant);
          adoptedRequestId = r.value.requestId ?? null;
          ensureActive();
          await writeClaimRecord(file, { ...r.value, sentAt: Date.now(), updatedAt: Date.now() }).catch(() => {});
          ensureActive();
        } else if (verdict === 'unsent') {
          // The request provably never landed (session dead or prompt
          // absent from history): expire the ambiguous record atomically and
          // fall into the (re)create branch — exactly one fresh request.
          ensureActive();
          await writeClaimRecord(file, {
            ...r.value, sessionId: null, sentAt: null,
            updatedAt: Date.now() - 2 * REVIEWER_CLAIM_LEASE_MS,
          });
          ensureActive();
          createdRequestId = randomUUID();
          ensureActive();
          await writeClaimRecord(file, {
            claimant: identity, sessionId: null, sentAt: null,
            requestId: createdRequestId,
            revision: round?.revision ?? revision,
            attemptId: round?.attemptId ?? null,
            proofCommit: round?.proofCommit ?? null,
            findingIds: Array.isArray(round?.findingIds) ? round.findingIds : [],
            updatedAt: Date.now(),
          });
          created = true;
        } else {
          // UNKNOWN is not evidence of non-delivery. Keep the durable record
          // untouched and retry with deterministic bounded backoff; only the
          // recovery deadline can end this uncertainty.
          unknownAttempts += 1;
          ensureActive();
          if (Date.now() >= deadline) throw uncertain(r.value);
          unknownRecord = r.value;
          unknownDelay = Math.min(
            recoveryBackoff(unknownAttempts, backoffMs, backoffMaxMs),
            Math.max(0, deadline - Date.now()),
          );
        }
      } else if (r.value?.sessionId && typeof r.value.sessionId === 'string' && rStale) {
        // A crashed owner recorded a session (a SENT request): reconcile it
        // instead of launching — sent requests are never duplicated (T-H12
        // round-3). The send marker survives the owner: `{...record}` keeps
        // requestId/sentAt so adopters see the same request identity.
        adopted = await adopt(r.value.sessionId, r.value.claimant);
        adoptedRequestId = r.value.requestId ?? null;
      } else if (!(r.exists && !r.incomplete && !rStale)) {
        // Absent, stale-empty, or dead-incomplete: (re)create the claim in
        // place with the round attribution (T-H12) AND a fresh durable
        // request identity persisted BEFORE the request is sent (T-H12
        // round-3). A stale UNSENT record (requestId set, sentAt null) is
        // recovered exactly once — this creation — never re-sent under the
        // crashed owner's identity.
        createdRequestId = randomUUID();
        ensureActive();
        await writeClaimRecord(file, {
          claimant: identity, sessionId: null, sentAt: null,
          requestId: createdRequestId,
          revision: round?.revision ?? revision,
          attemptId: round?.attemptId ?? null,
          proofCommit: round?.proofCommit ?? null,
          findingIds: Array.isArray(round?.findingIds) ? round.findingIds : [],
          updatedAt: Date.now(),
        });
        created = true;
      }
      // else: a fresh in-progress claim appeared while we waited — its
      // owner is mid-launch; leave it alone and wait for its session/bind.
    } finally {
      await releaseReclaimLock(lockFile, identity);
    }
    if (unknownRecord) {
      // Release the reclaim lock before sleeping so another owner can observe
      // the unchanged ambiguous record and converge without duplicate launch.
      ensureActive();
      if (Date.now() >= deadline) throw uncertain(unknownRecord);
      await sleep(unknownDelay, isStopped);
      ensureActive();
      if (Date.now() >= deadline) throw uncertain(unknownRecord);
      continue;
    }
    ensureActive();
    if (adopted !== undefined) {
      // The original owner may have crashed between launch and the durable
      // request audit. Adoption is the reconciliation of THAT same request,
      // so the round's single request audit is ensured exactly once here.
      await ensureRoundRequestAudit(c, change, revision, adopted, adoptedRequestId, round, isStopped);
      return adopted;
    }
    if (created) {
      ensureActive();
      return await launch({ file, identity, requestId: createdRequestId });
    }
    continue;
  }
}

/**
 * Exactly-once durable request audit for a review round. A live owner audits
 * its own `review_round_requested` after a successful launch; when a crashed
 * owner is adopted before it could, the adopting pass appends it here.
 * Idempotent: an existing audit for this revision+request is never repeated.
 * @param {ChangeControlApi} c
 * @param {any} change
 * @param {string} revision
 * @param {string} sessionId
 * @param {string | null} requestId
 * @param {any} round
 * @param {(() => boolean) | undefined} [isStopped]
 */
async function ensureRoundRequestAudit(c, change, revision, sessionId, requestId, round, isStopped) {
  if (isStopped?.()) return;
  const history = await c.history(change.id).catch(() => []);
  if (isStopped?.()) return;
  const already = Array.isArray(history) && history.some((/** @type {any} */ e) =>
    e?.kind === 'review_orchestration' && e.action === 'review_round_requested'
    && e.revision === revision
    && (requestId == null || e.requestId === requestId));
  if (already || isStopped?.()) return;
  await c.appendAudit({
    kind: 'review_orchestration', changeId: change.id,
    action: 'review_round_requested',
    sessionId, revision,
    ...(requestId ? { requestId } : {}),
    ...(round?.attemptId ? { attemptId: round.attemptId } : {}),
    ...(round?.proofCommit ? { proofCommit: round.proofCommit } : {}),
    findingIds: Array.isArray(round?.findingIds) ? round.findingIds : [],
  }).catch(() => {});
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
 * Resolve a revision-keyed reviewer record without re-reading ChangeStore.
 * The locked ChangeStore settlement path supplies its fresh revision and
 * bindings while holding the write lock, avoiding a non-reentrant store read.
 * @param {ChangeControlApi} c
 * @param {any} change
 * @param {any} task
 * @param {string|null} revision
 * @param {Array<any>|null} lockedBindings
 */
async function roundReviewerSessionForRevision(c, change, task, revision, lockedBindings = null) {
  if (typeof revision !== 'string' || revision === '') return null;
  const { value: record } = await readClaimRecord(reviewerClaimFile(change, task, revision));
  const sessionId = record && typeof record.sessionId === 'string' ? record.sessionId : null;
  if (!sessionId) return null;
  const binding = Array.isArray(lockedBindings)
    ? lockedBindings.find((entry) => entry?.changeId === change.id && entry.sessionId === sessionId) ?? null
    : await c.getBinding(change.id, sessionId).catch(() => null);
  return binding && binding.role === 'reviewer' ? { sessionId } : null;
}

/**
 * T-H12 — the reviewer session attributed to the Change's CURRENT
 * implementation revision: the round's durable record (keyed Change+
 * revision) must name the session AND its reviewer binding must be
 * persisted. Any other binding — a prior round's still-live session, or a
 * record-less one — never satisfies the current round's explicit request.
 * Returns { sessionId } or null.
 * @param {ChangeControlApi} c
 * @param {any} change
 * @param {any} task
 */
async function roundReviewerSession(c, change, task) {
  const status = await c.status(change.id).catch(() => null);
  const revision = status?.revision ?? null;
  if (typeof revision !== 'string' || revision === '') return null;
  const { value: record } = await readClaimRecord(reviewerClaimFile(change, task, revision));
  const sessionId = record && typeof record.sessionId === 'string' ? record.sessionId : null;
  if (!sessionId) return null;
  const binding = await c.getBinding(change.id, sessionId).catch(() => null);
  return binding && binding.role === 'reviewer' ? { sessionId } : null;
}

/**
 * T-H12 round-3 — atomically invalidate ONLY the current round's durable
 * claim when its reviewer turn is proven ended without a verdict: the claim
 * record (keyed Change+current revision) is rewritten in place with the
 * session cleared and an already-expired timestamp, then that session's
 * reviewer binding is removed. Other rounds' records/sessions are untouched,
 * and nothing settles — the round stays fail-closed awaiting a fresh,
 * recoverable explicit request.
 * Returns true when this round's record was expired.
 * @param {ChangeControlApi} c
 * @param {any} change
 * @param {any} task
 * @param {string} sessionId
 * @param {(() => boolean) | undefined} [isStopped] cancellation gate — re-checked
 *   after every await and immediately before the claim-expiry write and the
 *   unbind mutation, so a disposal racing this round's dead-turn recovery can
 *   never expire or unbind after stop.
 */
async function expireReviewerRound(c, change, task, sessionId, isStopped) {
  if (isStopped?.()) return false;
  const status = await c.status(change.id).catch(() => null);
  if (isStopped?.()) return false;
  const revision = status?.revision ?? null;
  if (typeof revision !== 'string' || revision === '') return false;
  const file = reviewerClaimFile(change, task, revision);
  const { value: record } = await readClaimRecord(file);
  if (isStopped?.()) return false;
  if (!record || record.sessionId !== sessionId) return false;
  // Atomic rewrite (tmp+rename): claim and its send marker cleared together,
  // so a concurrent reader never sees a half-invalidated round.
  if (isStopped?.()) return false;
  await writeClaimRecord(file, {
    ...record,
    sessionId: null,
    sentAt: null,
    updatedAt: Date.now() - 2 * REVIEWER_CLAIM_LEASE_MS,
  });
  if (isStopped?.()) return false;
  await c.unbindRole(change.id, sessionId, { actor: 'review-orchestration' }).catch(() => {});
  return true;
}

/**
 * T-H12 round-4 (F2) — production observation of the launched reviewer's
 * turn lifecycle, wired to the REAL launcher handle the launch path already
 * holds: no caller-supplied reviewerTurn callback, no polling loop of our
 * own (the handle's wait() is the launcher's event feed), no timers.
 *
 * Invariant (production): a reviewer submits its verdict THROUGH its turn
 * (change_submit_review persists REVIEW→APPROVED|REPAIR before the turn
 * ends). Therefore a RESOLVED wait() (turn ended, any exit status) while
 * this round is still in REVIEW means the round can never settle: expire
 * exactly this round's durable claim/binding (fail-closed — a PASS is never
 * inferred), audit the dead turn, and issue exactly one fresh explicit
 * request. Guards against churn:
 *   - the Change already settled (any state but REVIEW) → the verdict won;
 *   - the Change moved to a NEW revision → that revision's own round owns it;
 *   - this session no longer owns the round record → someone else recovered.
 * Live (unfinished) turns never resolve wait(), so live reviewers are
 * untouched. Recovery failure leaves durable state for the next wake/restart.
 *
 * @param {{ handle: any, c: ChangeControlApi, change: any, task: any,
 *   revision: string, sessionId: string,
 *   rebuildReview: (isStopped?: () => boolean) => Promise<any> }} args
 * @returns {(() => void) | null} a stop for this observation (null when it
 *   could not be attached) — calling it neutralizes the recovery so a
 *   disposed controller never recovers a turn it no longer owns.
 */
export function observeReviewerTurn({ handle, c, change, task, revision, sessionId, rebuildReview }) {
  if (!handle || typeof handle.wait !== 'function') return null;
  // A stopped observer must never recover: the launching controller has been
  // disposed, and the fresh (restarted/adopting) controller owns the round.
  // Declared before recover so every awaited boundary below can re-check it —
  // stopReviewerObservation can fire while handle.wait() is already settling,
  // and recovery must then perform NO expire/unbind/audit/relaunch mutation.
  let stopped = false;

  // T-H12 round-5 (F1): BOTH wait() outcomes are addressed — resolved means
  // the turn ENDED (any exit status); REJECTED means the existing-session
  // waiter itself died (host-side session gone/unreachable). Rejection must
  // never be swallowed into a permanent review_pending: it runs the same
  // guarded, exactly-once dead-turn recovery.
  // T-H12 round-6 (R5-F1): `stopped` is re-checked after EVERY await and
  // immediately before EVERY mutation (claim expiry, unbind, audit, relaunch).
  // A disposal racing a settling wait() therefore invalidates the in-flight
  // recovery at the next boundary: no disposed controller can write or launch.
  const recover = async (outcome, error) => {
    if (stopped) return;
    const live = await c.get(change.id).catch(() => null);
    if (stopped) return;
    if (!live || live.state !== 'REVIEW') return; // settled/converged
    const status = await c.status(change.id).catch(() => null);
    if (stopped) return;
    if ((status?.revision ?? null) !== revision) return; // a new round owns it
    // expireReviewerRound is the claim-expiry + unbind mutation boundary; it
    // carries the same stop gate so those mutations are gated internally too.
    if (stopped) return;
    const expired = await expireReviewerRound(c, change, task, sessionId, () => stopped);
    if (stopped) return;
    if (!expired) return; // round already recovered/superseded
    if (stopped) return;
    await c.appendAudit({
      kind: 'review_orchestration', changeId: change.id,
      action: 'reviewer_turn_ended_no_verdict',
      sessionId, revision,
      exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : null,
      ...(error ? { error: String(error?.message ?? error) } : {}),
    }).catch(() => {});
    // Exactly one fresh explicit request for the same revision. Never
    // settles anything itself — the new request is the only path forward.
    if (stopped) return;
    await rebuildReview(() => stopped).catch(() => {});
  };
  Promise.resolve()
    .then(() => handle.wait())
    .then(
      (outcome) => { if (!stopped) return recover(outcome, null); },
      // Rejected existing-session waiter = dead turn (fail-closed recovery).
      (error) => { if (!stopped) return recover(null, error); },
    )
    .catch(() => { /* observation must never fault the caller's flow */ });
  return () => { stopped = true; };
}

/**
 * T-H12 round-5 (F1) — reattach production turn observation to the round's
 * EXISTING session: after a controller restart, a duplicate wake, or a
 * cross-process adoption, the only observer from request time lived in the
 * (possibly dead) launching process. The durable claim record names the
 * round's session and request identity; the launcher's existing-session
 * observer (host session history, not binding/liveness alone) reattaches
 * observation so a dead/rejected turn still recovers exactly once. A
 * launcher without the observation surface simply skips — legacy/standalone
 * behavior is unchanged. Never settles; observation is not completion.
 * Returns the observation stop function (see observeReviewerTurn) when
 * observation was (re)attached, or false when it was skipped.
 * @param {{ api: any, requireTask: () => TaskOrchestratorApi,
 *   requireChange: () => ChangeControlApi, taskId: string,
 *   change: any, task: any, revision?: string, sessionId: string,
 *   isStopped?: () => boolean }} args
 */
async function reattachReviewerTurnObservation({ api, requireTask, requireChange, taskId, change, task, revision, sessionId, isStopped }) {
  if (isStopped?.()) return false;
  const c = requireChange();
  let liveRevision = typeof revision === 'string' && revision !== '' ? revision : null;
  if (liveRevision === null) {
    const status = await c.status(change.id).catch(() => null);
    if (isStopped?.()) return false;
    liveRevision = status?.revision ?? null;
    if (typeof liveRevision !== 'string' || liveRevision === '') return false;
  }
  // Only ever attach observation to the session the round's DURABLE record
  // names for the current revision — never to a stray binding.
  const { value: record } = await readClaimRecord(reviewerClaimFile(change, task, liveRevision));
  if (isStopped?.() || !record || record.sessionId !== sessionId) return false;
  let observerLauncher = null;
  try { observerLauncher = /** @type {any} */ (requireTask()).createReviewerLauncher?.({}); } catch { observerLauncher = null; }
  if (isStopped?.() || typeof observerLauncher?.observeSession !== 'function') return false;
  const handle = observerLauncher.observeSession(sessionId, record.requestId ?? null);
  if (isStopped?.()) {
    try { await handle?.terminate?.(); } catch { /* stop observation only */ }
    return false;
  }
  const stop = observeReviewerTurn({
    handle, c, change, task, revision: liveRevision, sessionId,
    rebuildReview: (stopped) => api.runGovernedReview(taskId, { isStopped: stopped }),
  });
  if (isStopped?.()) {
    try { stop?.(); } catch { /* observer is already neutralized */ }
    try { await handle?.terminate?.(); } catch { /* stop observation only */ }
    return false;
  }
  return stop;
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
  let task = await Promise.resolve(t.get(taskId));
  if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });

  // H11-REPAIR-STATE-GUARD-ORDER: Change Control is authoritative and must be
  // checked before prepareRepairAttempt can mutate changes_requested → ready.
  // The second read below closes the normal cross-store check→claim race.
  const statusBeforePrepare = await c.status(change.id);
  if (!statusBeforePrepare || statusBeforePrepare.state !== 'REPAIR') {
    return {
      stopped: true,
      result: { outcome: 'lifecycle_mismatch', taskId, changeId: change.id, taskStatus: task.status, changeState: statusBeforePrepare?.state ?? null },
    };
  }
  if (task.status === 'changes_requested') {
    await api.prepareRepairAttempt(taskId); // → ready (CAS-protected)
    task = await Promise.resolve(t.get(taskId));
  } else if (task.status !== 'ready') {
    return {
      stopped: true,
      result: { outcome: 'lifecycle_mismatch', taskId, changeId: change.id, taskStatus: task.status, changeState: statusBeforePrepare.state },
    };
  }
  if (!task || task.status !== 'ready') {
    return {
      stopped: true,
      result: { outcome: 'lifecycle_mismatch', taskId, changeId: change.id, taskStatus: task?.status ?? null, changeState: statusBeforePrepare.state },
    };
  }
  if (typeof t.claim !== 'function' || typeof t.start !== 'function' || typeof t.release !== 'function') {
    throw Object.assign(new Error('taskOrchestrator facade does not expose claim/start/release — repair routing unavailable'), { code: 'ROUTING_UNAVAILABLE' });
  }
  if (typeof c.submitRepair !== 'function') {
    throw Object.assign(new Error('changeControl facade does not expose submitRepair — repair routing unavailable'), { code: 'SUBMIT_REPAIR_UNAVAILABLE' });
  }
  const statusNow = await c.status(change.id);
  // H11-REPAIR-STATE-GUARD-ORDER: re-check the authoritative Change after
  // preparation and immediately before claim/launch. A normal READY Change
  // swept into recovery must never consume an attempt or create a session.
  if (!statusNow || statusNow.state !== 'REPAIR') {
    return {
      stopped: true,
      result: { outcome: 'lifecycle_mismatch', taskId, changeId: change.id, taskStatus: task.status, changeState: statusNow?.state ?? null },
    };
  }
  const openFindings = Array.isArray(statusNow?.openFindings) ? statusNow.openFindings : [];
  const revision = statusNow?.revision ?? null;
  // T-H11: autonomous repair routing. When the woken controller resumes with
  // no caller-supplied repair worker/proof, resolve the AUTHORITATIVE worker
  // profile + model from the task through the Task Orchestrator registry /
  // preflight, so the repair session inherits mode, agentPreset/profile, model,
  // timeout and lease exactly as a governed dispatch would. The repair
  // worker's structured completion envelope is surfaced from handle.wait()
  // (the deterministic DSH tool/result.meta carrier), never fabricated. The
  // explicit-worker options remain for the host-driven repair path.
  let workerLauncher = options.workerLauncher;
  // Resolve the spec only on the autonomous path (a caller-supplied launcher
  // already carries its own spec/lease intent). A headless-profile/session
  // profile must survive into the launch spec — never a hardcoded session.
  let resolvedSpec = null;
  if (!workerLauncher) {
    if (typeof t.createWorkerLauncher !== 'function') {
      // Stop at the resumable repair_routed boundary: no launcher means a
      // repair worker cannot be dispatched (consistent with the old contract).
      return {
        stopped: true,
        result: {
          outcome: 'repair_routed', taskId, changeId: change.id,
          openFindingIds: openFindings.map((/** @type {any} */ f) => f.id),
          revision,
          missing: 'repairWorker',
        },
      };
    }
    // Authoritative registry resolution. Fail closed BEFORE any claim when
    // the profile is unknown, malformed, or disabled — an invalid profile
    // must never strand or half-dispatch a repair worker.
    const profile = task.worker_profile;
    try {
      resolvedSpec = typeof t.resolveWorkerSpec === 'function'
        ? await Promise.resolve(t.resolveWorkerSpec(profile, task.worker_model))
        : null;
    } catch {
      resolvedSpec = null;
    }
    if (!resolvedSpec || resolvedSpec.enabled === false) {
      return {
        stopped: true,
        result: {
          outcome: 'repair_profile_unavailable', taskId, changeId: change.id,
          workerProfile: profile,
          reason: 'worker profile unavailable or unsupported',
        },
      };
    }
    // H11-REPAIR-HEADLESS-IDENTITY: a headless-profile repair has no bound
    // session (createBindingLauncher only binds session-mode), so governed
    // repair completion cannot carry a durable worker session identity. Fail
    // closed BEFORE claiming rather than persisting a Change-side transition
    // the task side can never converge.
    if (resolvedSpec.mode === 'headless-profile') {
      return {
        stopped: true,
        result: {
          outcome: 'repair_profile_unavailable', taskId, changeId: change.id,
          workerProfile: profile,
          reason: 'headless-profile repair lacks a durable bound-session identity',
        },
      };
    }
    // H11-REPAIR-PREFLIGHT-FAILOPEN: the authoritative worker preflight is a
    // mandatory trust-boundary check. Missing, throwing, malformed, or false
    // preflight results all fail closed before claim/launch; checker-unavailable
    // is not silently converted into permission to dispatch.
    if (typeof t.preflightWorker !== 'function') {
      return {
        stopped: true,
        result: {
          outcome: 'repair_preflight_unavailable', taskId, changeId: change.id,
          workerProfile: profile, reason: 'worker preflight is unavailable',
        },
      };
    }
    let preflight;
    try {
      preflight = await Promise.resolve(t.preflightWorker({
        worker_profile: profile,
        worker_model: task.worker_model,
        workspace: task.workspace,
      }));
    } catch (error) {
      return {
        stopped: true,
        result: {
          outcome: 'repair_preflight_failed', taskId, changeId: change.id,
          workerProfile: profile,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (!preflight || preflight.ok !== true) {
      const blockers = Array.isArray(preflight?.blockers) ? preflight.blockers : [];
      return {
        stopped: true,
        result: {
          outcome: 'repair_preflight_failed', taskId, changeId: change.id,
          workerProfile: profile,
          reason: blockers.map((/** @type {any} */ b) => b?.code ?? b?.message ?? String(b)).join(', ') || 'worker preflight did not pass',
        },
      };
    }
    if (preflight.spec !== undefined && (!preflight.spec || typeof preflight.spec !== 'object' || Array.isArray(preflight.spec))) {
      return {
        stopped: true,
        result: {
          outcome: 'repair_preflight_failed', taskId, changeId: change.id,
          workerProfile: profile, reason: 'worker preflight returned an invalid spec',
        },
      };
    }
    if (preflight.spec) resolvedSpec = preflight.spec;
    if (!resolvedSpec || resolvedSpec.enabled === false || resolvedSpec.name !== profile) {
      return {
        stopped: true,
        result: {
          outcome: 'repair_preflight_failed', taskId, changeId: change.id,
          workerProfile: profile, reason: 'worker preflight spec does not match the task profile',
        },
      };
    }
    // A headless worker has no session identity for the governed completion
    // contract. Reject it before the claim even when a preflight override tries
    // to select one.
    if (resolvedSpec.mode === 'headless-profile') {
      return {
        stopped: true,
        result: {
          outcome: 'repair_profile_unavailable', taskId, changeId: change.id,
          workerProfile: profile,
          reason: 'headless-profile repair lacks a durable bound-session identity',
        },
      };
    }
    workerLauncher = t.createWorkerLauncher({});
  }
  const runId = options.worker ?? `repair-${change.id}-${Date.now()}`;
  const leaseSeconds = options.leaseSeconds ?? resolvedSpec?.leaseSeconds ?? 600;
  const claim = await Promise.resolve(t.claim(taskId, runId, { lease_seconds: leaseSeconds, actor: 'sdlc-controller' }));
  if (!claim || claim.claimed !== true) {
    return { stopped: true, result: { outcome: 'repair_claim_failed', taskId, changeId: change.id, reason: claim?.reason } };
  }
  await Promise.resolve(t.start(taskId, runId, { actor: 'sdlc-controller' }));
  const liveTask = await Promise.resolve(t.get(taskId));
  const governedLauncher = createBindingLauncher(workerLauncher, c, WORK_ITEM_SYSTEM);
  // The launch spec carries the resolved profile's mode/agentPreset/profile/
  // model/timeout so a session vs headless-profile task is honored; the repair
  // prompt is woven in only for the prompt-bearing session mode (headless
  // profiles run their own command/profile).
  const launchSpec = resolvedSpec
    ? {
        mode: resolvedSpec.mode,
        prompt: buildRepairPrompt(taskId, change.id, revision, openFindings),
        ...(resolvedSpec.mode === 'headless-profile'
          ? { profile: resolvedSpec.profile, command: resolvedSpec.command, model: resolvedSpec.model, timeoutMs: resolvedSpec.timeoutMs }
          : { agentPreset: resolvedSpec.agentPreset, model: resolvedSpec.model, timeoutMs: resolvedSpec.timeoutMs }),
      }
    : { mode: 'session', prompt: buildRepairPrompt(taskId, change.id, revision, openFindings) };
  let handle;
  try {
    handle = await governedLauncher.launch({
      task: liveTask,
      spec: launchSpec,
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
  let repairProofForRecovery = null;
  try {
    // H11-REPAIR-CLAIM-LIVENESS: enforce the resolved profile's timeout (not
    // an unbounded wait) and renew the claim lease while the worker runs, so
    // a hung repair cannot hold a running task past its lease on our watch.
    const timeoutMs = resolvedSpec?.timeoutMs ?? options.timeoutMs ?? null;
    let renewTimer = null;
    if (typeof t.renewLease === 'function') {
      const intervalMs = Math.max(250, Math.floor(leaseSeconds * 1000 / 3));
      renewTimer = setInterval(() => {
        Promise.resolve(t.renewLease(taskId, runId, { lease_seconds: leaseSeconds, actor: 'sdlc-controller' })).catch(() => {});
      }, intervalMs);
      renewTimer.unref?.();
    }
    let timeoutTimer = null;
    try {
      const waitPromise = Promise.resolve(handle.wait?.());
      if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        const timeoutPromise = new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => {
            reject(Object.assign(new Error(`repair worker timed out after ${timeoutMs}ms`), { code: 'REPAIR_TIMEOUT' }));
          }, timeoutMs);
          timeoutTimer.unref?.();
        });
        settle = await Promise.race([waitPromise, timeoutPromise]);
      } else {
        settle = await waitPromise;
      }
    } catch (/** @type {any} */ error) {
      // A timeout or launcher wait failure is an ordinary failed repair, not an
      // uncaught controller rejection. Terminate first so the binding wrapper
      // unbinds the session, then the common failure path releases the claim.
      if (error?.code === 'REPAIR_TIMEOUT') {
        try { await handle.terminate?.('SIGTERM'); } catch { /* release below */ }
      }
      settle = {
        exitCode: null,
        signal: error?.code === 'REPAIR_TIMEOUT' ? 'SIGTERM' : null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (renewTimer) clearInterval(renewTimer);
    }
    if (settle && settle.exitCode === 0 && !settle.error) {
      try {
        // The repair proof is caller-supplied on the host-driven path, or the
        // worker's surfaced structured completion envelope on the autonomous
        // path (handle.wait() returns the canonical tool/result.meta fields).
        repairProofForRecovery = options.repairProof ?? {
          beforeRevision: settle.beforeRevision ?? revision,
          afterRevision: settle.afterRevision ?? settle.commit_sha,
          commit_sha: settle.commit_sha,
          files_changed: Array.isArray(settle.files_changed) ? settle.files_changed : [],
          tests_run: Array.isArray(settle.tests_run) ? settle.tests_run : [],
          remaining_blockers: Array.isArray(settle.remaining_blockers) ? settle.remaining_blockers : [],
          criteria: Array.isArray(settle.criteria) ? settle.criteria : [],
          deviations: Array.isArray(settle.deviations) ? settle.deviations : [],
          workerChecks: Array.isArray(settle.workerChecks) ? settle.workerChecks : [],
          controllerPreflight: Array.isArray(settle.controllerPreflight) ? settle.controllerPreflight : [],
          summary: settle.summary ?? '',
        };
        // H11-REPAIR-HEADLESS-IDENTITY: never persist a repair completion
        // without a durable worker session identity (the binding launcher only
        // binds session-mode). Missing sessionId → fail, not a half-committed
        // Change-side REPAIR→PREFLIGHT with an unconverged task.
        if (typeof handle.sessionId !== 'string' || handle.sessionId === '') {
          throw Object.assign(new Error('repair worker completed without a bound session identity'), { code: 'SESSION_ID_MISSING' });
        }
        await c.submitRepair(change.id, { findings: claims, proof: repairProofForRecovery }, { workerId: runId });
        // Governed completion converges the task side (PREFLIGHT idempotent
        // fast path: the stored repair proof matches this payload).
        await api.completeGovernedTask(taskId, { sessionId: handle.sessionId, worker: runId, proof: repairProofForRecovery });
      } catch (/** @type {any} */ error) {
        submitError = error;
      }
    }
  } finally {
    await handle._governedRelease?.();
  }
  if (submitError !== null) {
    // Change Control and Task Orchestrator are separate durable stores. If the
    // repair proof reached PREFLIGHT before governed task completion failed,
    // do not release the task to ready (which would strand PREFLIGHT outside
    // the normal recovery path). Reconcile the task into in_review so the
    // controller can continue from the persisted proof. Acceptance-criteria
    // drift is not safely replayable, so fail that task closed instead.
    let afterSubmit = null;
    try { afterSubmit = repairProofForRecovery ? await c.status(change.id) : null; } catch { afterSubmit = null; }
    if (afterSubmit?.state === 'PREFLIGHT' && repairProofForRecovery) {
      const currentTask = await Promise.resolve(t.get(taskId));
      if (currentTask?.status === 'in_review') return { stopped: false };
      if (currentTask && (currentTask.status === 'claimed' || currentTask.status === 'running') && currentTask.claimed_by === runId) {
        const expected = {
          status: currentTask.status,
          claimed_by: runId,
          lease_expires_at: currentTask.lease_expires_at,
        };
        if (submitError?.code === 'CRITERIA_MISMATCH') {
          const failed = t.updateIf(taskId, expected, {
            status: 'failed',
            result_summary: 'repair completion rejected after acceptance criteria changed',
          });
          if (failed) {
            await Promise.resolve(c.appendAudit({
              kind: 'review_orchestration', changeId: change.id,
              action: 'repair_partial_failed_closed', detail: submitError.message,
            })).catch(() => {});
            return {
              stopped: true,
              result: { outcome: 'repair_failed', taskId, changeId: change.id, code: submitError.code, detail: submitError.message },
            };
          }
        } else {
          const recovered = t.updateIf(taskId, expected, {
            status: 'in_review',
            commit_sha: repairProofForRecovery.commit_sha,
            files_changed: repairProofForRecovery.files_changed,
            tests_run: repairProofForRecovery.tests_run,
            remaining_blockers: repairProofForRecovery.remaining_blockers,
            result_summary: repairProofForRecovery.summary ?? 'repair proof recovered for review',
          });
          if (recovered) {
            await Promise.resolve(c.appendAudit({
              kind: 'review_orchestration', changeId: change.id,
              action: 'repair_partial_recovered', detail: submitError.message,
            })).catch(() => {});
            return { stopped: false };
          }
        }
      }
    }
    // A failed submission/leave before Change-side persistence: release the
    // claim so a later event or restart can re-claim the REPAIR stage.
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
 * @param {{ spec?: object, launcherOptions?: object, revision?: string,
 *   requestId?: string,
 *   isStopped?: () => boolean,
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
    const ensureActive = () => {
      if (options.isStopped?.()) {
        throw Object.assign(new Error('review observer stopped'), { code: 'REVIEW_OBSERVER_STOPPED' });
      }
    };
    ensureActive();
    const task = await Promise.resolve(t.get(taskId));
    ensureActive();
    if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
    const change = await c.findByWorkItem(WORK_ITEM_SYSTEM, taskId);
    ensureActive();
    if (!change) throw Object.assign(new Error(`no Change linked to task ${taskId}`), { code: 'CHANGE_NOT_FOUND' });
    ensureActive();
    const launcher = /** @type {any} */ (t).createReviewerLauncher(options.launcherOptions ?? {});
    const revisionLine = typeof options.revision === 'string' && options.revision !== ''
      ? ` The implementation revision under review is ${options.revision}; your verdict must name exactly this revision (stale-revision verdicts are rejected).`
      : '';
    const defaultPrompt = `You are the independent reviewer for task ${task.id}.
Review the governed Change ${change.id} against its Plan and project task acceptance criteria.${revisionLine} Read-only: do NOT modify any files. Inspect the worker's submitted proof and test log and decide PASS / FAIL / ESCALATE with a brief rationale.`;
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
    // T-H12 round-3: the durable request identity persisted before the send
    // is handed to the launcher verbatim, so the sent request and its
    // durable record share one identity across crash windows.
    const launchInput = /** @type {any} */ ({ task, spec });
    if (typeof options.requestId === 'string' && options.requestId !== '') {
      launchInput.requestId = options.requestId;
    }
    // T-H12 round-4: the REAL launcher (task-orchestrator/dispatcher) fires
    // these hooks at the durable boundaries — recordCreated immediately after
    // session.create (pre-send), recordSent immediately after session.prompt
    // is accepted — closing the crash window between acceptance and the
    // caller's own record write. Fake launchers simply never call them; the
    // legacy post-return recordSession write below then remains the marker.
    if (typeof options.recordCreated === 'function') {
      launchInput.recordCreated = async ({ sessionId }) => {
        ensureActive();
        await options.recordCreated(sessionId);
        ensureActive();
      };
    }
    if (typeof options.recordSession === 'function') {
      launchInput.recordSent = async ({ sessionId }) => {
        ensureActive();
        await options.recordSession(sessionId);
        ensureActive();
      };
    }
    const handle = await launcher.launch(launchInput);
    if (options.isStopped?.()) {
      try { await handle?.terminate?.(); } catch { /* best-effort */ }
      throw Object.assign(new Error('review observer stopped'), { code: 'REVIEW_OBSERVER_STOPPED' });
    }
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
      // With the real launcher the accepted-send hook (above) already wrote
      // this record at the true boundary; the rewrite is idempotent.
      if (typeof options.recordSession === 'function') {
        await options.recordSession(handle.sessionId);
      }
      ensureActive();
      binding = await c.bindRole(change.id, handle.sessionId, 'reviewer');
      ensureActive();
    } catch (error) {
      if (typeof handle?.terminate === 'function') {
        try { await handle.terminate(); } catch { /* best-effort */ }
      }
      // T-H5 PR2-01: expire the durable record so a successor claim launches
      // fresh instead of adopting a session we just terminated.
      if (typeof options.discardSession === 'function' && !options.isStopped?.()) {
        try { await options.discardSession(); } catch { /* best-effort */ }
      }
      throw error;
    }
    return { sessionId: handle.sessionId, changeId: change.id, binding, handle };
  })();
}
