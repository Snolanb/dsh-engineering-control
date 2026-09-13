/**
 * T-H5 — production governed SDLC controller (RED→GREEN).
 *
 * RED intent: the current production composition exposes the stage
 * operations (completeGovernedTask, runGovernedReview, applyReviewOutcome,
 * prepareRepairAttempt) but NOTHING wires them into an automatic
 * controller-owned lifecycle. A governed worker success leaves the Change
 * parked in PREFLIGHT; no preflight runs, no reviewer launches, no repair
 * routes, no escalation — every stage requires a manual host call.
 *
 * These tests fail against that composition and pass only when one
 * explicit controller (runGovernedSdlc) owns the stage transitions from
 * the production trigger onward, with the Task Orchestrator remaining
 * authoritative for claim/lease/routing and Change Control remaining
 * authoritative for governance decisions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import { WorkerDispatcher } from 'dsh-task-orchestrator/dispatcher';
import { WorkerSpecRegistry } from 'dsh-task-orchestrator/worker-specs';
import changeControlPlugin from 'dsh-change-control';
import plugin from '../src/index.js';
import { createTaskChangeControlService } from '../src/service.js';

/** Package root — the multi-process child script CWD so its bare imports resolve. */
const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const REVIEWER_SESSION = 'sess-review-th5';
const WORKER_SPEC = {
  mode: 'session', profile: 'wp', agentPreset: 'worker',
  provider: 'ollama', model: 'm', workspacePolicy: 'any',
  timeoutMs: 5000, leaseSeconds: 300, name: 'worker',
};

/**
 * T-H5 repair-r2 — composition with a REAL host preflight policy. The
 * store's runPreflight then evaluates `policy.requiredChecks` (name-
 * matched against the controller check results) and, on success,
 * performs the PREFLIGHT→REVIEW transition itself.
 */
async function composeWithPolicy(t, { storePrefix = 'tcc-th5-policy-' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), storePrefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  let reviewerLaunches = 0;
  const taskOrchestrator = Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    updateIf: (id, e, p) => taskStore.updateIf(id, e, p),
    complete: taskStore.complete.bind(taskStore),
    claim: taskStore.claim.bind(taskStore),
    start: taskStore.start.bind(taskStore),
    release: taskStore.release.bind(taskStore),
    createDispatcher: (options = {}) => new WorkerDispatcher({
      store: taskStore,
      registry: new WorkerSpecRegistry({ worker: WORKER_SPEC }),
      launcher: options.launcher,
      preflight: options.preflight ?? (async () => ({ ok: true, spec: WORKER_SPEC })),
      preDispatch: options.preDispatch ?? null,
      completionHook: options.completionHook ?? null,
    }),
    createReviewerLauncher: () => ({
      async launch() {
        reviewerLaunches += 1;
        return {
          sessionId: REVIEWER_SESSION,
          // T-H12 round-4: a healthy reviewer turn stays pending — the
          // production observer treats ONLY a resolved wait() as a dead turn.
          wait: () => new Promise(() => {}),
          terminate: async () => true,
        };
      },
    }),
  });
  ctx.provide('taskOrchestrator', taskOrchestrator);
  const storePath = join(dir, 'changes.json');
  await ctx.plugin(changeControlPlugin, {
    storePath,
    policy: { preflightPolicy: { requiredChecks: ['build'], protectedPaths: [] } },
  });
  await ctx.plugin(plugin);
  return { ctx, taskStore, dir, storePath, taskOrchestrator, reviewerLaunches: () => reviewerLaunches };
}

async function compose(t, {
  withReviewerLauncher = true,
  storePrefix = 'tcc-th5-',
  reviewerLaunchDelay = 0,
  // T-H12: each review round (new revision) launches its OWN reviewer
  // session — default ids stay launch-unique, with the canonical first one.
  reviewerSessionId = (n) => (n === 1 ? REVIEWER_SESSION : `${REVIEWER_SESSION}-${n}`),
  // T-H12 round-5: the fake launcher's existing-session observation surface
  // (restart/adoption reattach), controllable per test.
  observableReviewerSessions = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), storePrefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  const taskOrchestrator = {
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    updateIf: (id, e, p) => taskStore.updateIf(id, e, p),
    complete: taskStore.complete.bind(taskStore),
    claim: taskStore.claim.bind(taskStore),
    start: taskStore.start.bind(taskStore),
    release: taskStore.release.bind(taskStore),
    createDispatcher: (options = {}) => new WorkerDispatcher({
      store: taskStore,
      registry: new WorkerSpecRegistry({ worker: WORKER_SPEC }),
      launcher: options.launcher,
      preflight: options.preflight ?? (async () => ({ ok: true, spec: WORKER_SPEC })),
      preDispatch: options.preDispatch ?? null,
      completionHook: options.completionHook ?? null,
    }),
  };
  let reviewerLaunches = 0;
  // T-H12 round-4: reviewer turns stay LIVE (wait never resolves) until the
  // test explicitly ends one — the production observer treats a resolved
  // wait() as a dead turn and recovers exactly once.
  const reviewerTurnEnds = new Map(); // sessionId -> 'exited' | 'failed'
  const reviewerTurnRejects = new Map(); // sessionId -> Error (waiter rejection)
  const reviewerTurnWaiters = new Map(); // sessionId -> { resolve, reject }
  const observedSessions = []; // sessions observation was (re)attached to
  const endReviewerTurn = (sessionId, mode = 'exited') => {
    reviewerTurnEnds.set(sessionId, mode);
    const waiter = reviewerTurnWaiters.get(sessionId);
    if (waiter) {
      reviewerTurnWaiters.delete(sessionId);
      waiter.resolve(mode === 'failed' ? { exitCode: 1 } : { exitCode: 0 });
    }
  };
  // T-H12 round-5: make an EXISTING session's waiter reject (host reports
  // the session unreachable) — the production observer must treat the
  // rejection as a dead turn, never swallow it into permanent review_pending.
  const rejectObservedTurn = (sessionId, error = new Error('existing session unreachable')) => {
    reviewerTurnRejects.set(sessionId, error);
    const waiter = reviewerTurnWaiters.get(sessionId);
    if (waiter) {
      reviewerTurnWaiters.delete(sessionId);
      waiter.reject(error);
    }
  };
  if (withReviewerLauncher) {
    taskOrchestrator.createReviewerLauncher = () => ({
      async launch() {
        reviewerLaunches += 1;
        const n = reviewerLaunches;
        if (reviewerLaunchDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, reviewerLaunchDelay));
        }
        const sessionId = reviewerSessionId(n);
        return {
          sessionId,
          wait: () => {
            const ended = reviewerTurnEnds.get(sessionId);
            if (ended) {
              return Promise.resolve(ended === 'failed' ? { exitCode: 1 } : { exitCode: 0 });
            }
            return new Promise((resolve, reject) => reviewerTurnWaiters.set(sessionId, { resolve, reject }));
          },
          terminate: async () => true,
        };
      },
      ...(observableReviewerSessions ? {
        // T-H12 round-5: observation reattach for an EXISTING session
        // (restart/cross-process adoption) — same controllable turn surface.
        observeSession(sessionId) {
          observedSessions.push(sessionId);
          return {
            sessionId,
            wait: () => {
              const ended = reviewerTurnEnds.get(sessionId);
              if (ended) return Promise.resolve(ended === 'failed' ? { exitCode: 1 } : { exitCode: 0 });
              const rejected = reviewerTurnRejects.get(sessionId);
              if (rejected) return Promise.reject(rejected);
              return new Promise((resolve, reject) => reviewerTurnWaiters.set(sessionId, { resolve, reject }));
            },
          };
        },
      } : {}),
    });
  }
  ctx.provide('taskOrchestrator', Object.freeze(taskOrchestrator));
  const storePath = join(dir, 'changes.json');
  await ctx.plugin(changeControlPlugin, { storePath });
  await ctx.plugin(plugin);
  return {
    ctx, taskStore, dir, storePath, taskOrchestrator,
    reviewerLaunches: () => reviewerLaunches, endReviewerTurn, rejectObservedTurn,
    observedSessions: () => [...observedSessions],
  };
}

/** Create a governed task with an accepted plan, leaving the Change in READY (the guard's required state). */
async function governedReadyTask(ctx, taskStore, dir) {
  const task = await taskStore.create({
    title: 'tH5', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['ship'],
  });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  return { task, change };
}

/** Instant-success governed worker: transitions Change to IMPLEMENTING mid-run and yields a structured proof. */
function successLauncher(ctx, change, { commit = 'c1', afterRevision = 'a1', preflight = ['ok'], manualTransition = true } = {}) {
  let ran = false;
  return {
    async launch() {
      return {
        sessionId: 'sess-w1',
        wait: async () => {
          if (!ran) {
            ran = true;
            // T-H5 PR1-01: real production launchers do NOT transition the
            // Change — this is a test-only move that previously masked the
            // missing controller-owned READY→IMPLEMENTING transition.
            if (manualTransition) {
              await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
            }
          }
          return {
            exitCode: 0, stdout: 'done', stderr: '',
            commit_sha: commit, afterRevision,
            files_changed: ['f'], tests_run: ['t'],
            controllerPreflight: preflight,
            criteria: [{ id: 'ship', satisfied: true }],
            deviations: [], workerChecks: ['ok'],
          };
        },
        terminate: async () => true,
      };
    },
  };
}

const finding = (tag, location = 'src/f.js') => ({
  severity: 'critical', category: 'test', location,
  problem: `issue ${tag}`, fix: 'fix it', requiredOutcome: `issue ${tag} resolved`,
});

const repairProof = (before, after, commit) => ({
  beforeRevision: before, afterRevision: after, commit_sha: commit,
  files_changed: ['f'], tests_run: ['t'], remaining_blockers: [],
  criteria: [{ id: 'ship', satisfied: true }], deviations: [],
  workerChecks: ['ok'], controllerPreflight: ['ok'], summary: 'repaired',
});

const repairLauncher = (sessionId) => ({
  async launch() {
    return {
      sessionId,
      wait: async () => ({ exitCode: 0 }),
      terminate: async () => true,
    };
  },
});

/** Bounded condition wait (test-side observation of async production fibers). */
async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** Drive the production trigger: governed dispatch of the READY task to a successful completion. */
async function dispatchGovernedSuccess(ctx, taskStore, dir, change, overrides = {}) {
  const dispatcher = ctx.taskChangeControl.createGovernedDispatcher({
    launcher: successLauncher(ctx, change, overrides),
  });
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' });
  assert.equal(result.dispatched, true, 'worker must dispatch');
  assert.equal(result.status, 'in_review', 'governed completion must land the task in in_review');
  return result;
}

test('T-H5 trigger: governed dispatcher success auto-advances to REVIEW with an independent reviewer bound', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change);

  // The controller-owned production trigger must have traversed
  // PREFLIGHT → REVIEW and launched+bound the independent reviewer WITHOUT
  // any manual stage call. (RED today: the Change parks in PREFLIGHT.)
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW');
  const reviewers = (await ctx.changeControl.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.equal(reviewers.length, 1, 'exactly one reviewer session bound');
  assert.equal(reviewers[0].sessionId, REVIEWER_SESSION);
  assert.equal(reviewerLaunches(), 1);

  // Reviewer independence: launching a reviewer never grants it the task's
  // claim/lease ownership.
  const taskAfter = await taskStore.get(task.id);
  assert.equal(taskAfter.status, 'in_review');
  assert.equal(taskAfter.claimed_by, null, 'reviewer must not hold the task claim');
  assert.equal(taskAfter.lease_expires_at, null, 'reviewer must not hold the task lease');
});

test('T-H5: pass verdict settles the lifecycle to APPROVED + task done; re-invocation converges without duplicates', async (t) => {
  const { ctx, taskStore, dir, taskOrchestrator } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change);

  const out = await ctx.taskChangeControl.runGovernedSdlc(task.id, { verdict: { verdict: 'pass' } });
  assert.equal(out.outcome, 'approved');
  assert.equal((await taskStore.get(task.id)).status, 'done');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'APPROVED');

  // Idempotent/resumable: a duplicate settlement (restart, double-trigger)
  // converges to the same terminal result with NO new transitions.
  const out2 = await ctx.taskChangeControl.runGovernedSdlc(task.id, { verdict: { verdict: 'pass' } });
  assert.equal(out2.outcome, 'approved');
  const approvals = (await ctx.changeControl.history(change.id)).filter((e) => e.to === 'APPROVED');
  assert.equal(approvals.length, 1, 'APPROVED transition recorded exactly once');
  assert.equal((await taskStore.get(task.id)).status, 'done');

  // A freshly restarted service instance over the same stores also converges.
  const restarted = createTaskChangeControlService({
    taskOrchestrator: () => taskOrchestrator,
    changeControl: () => ctx.changeControl,
  });
  const out3 = await restarted.runGovernedSdlc(task.id, {});
  assert.equal(out3.outcome, 'approved');
});

test('T-H5: fail verdict routes the repair worker automatically; the loop re-enters preflight/review; pass settles', async (t) => {
  const { ctx, taskStore, dir, storePath, reviewerLaunches } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change);

  // One controller call settles the fail verdict, routes the repair worker
  // through Task Orchestrator claim/start, submits the repair (claiming the
  // unresolved finding IDs), converges governed completion, re-runs the
  // deterministic preflight, and returns to the next review round.
  const r1 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {
    verdict: { verdict: 'fail', findings: [finding('p1')] },
    worker: 'w-repair-1',
    workerLauncher: repairLauncher('sess-repair-1'),
    repairProof: repairProof('a1', 'a2', 'c2'),
    maxRepairRounds: 2,
  });
  assert.equal(r1.outcome, 'review_pending', 'second review round awaits its verdict');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW');
  assert.equal((await taskStore.get(task.id)).status, 'in_review');
  assert.equal(reviewerLaunches(), 2, 'T-H12: the new revision gets its own fresh reviewer session — the prior round\'s is never re-prompted');

  // The repair round claimed the UNRESOLVED FINDING ID from the fail verdict.
  const disk = JSON.parse(readFileSync(storePath, 'utf8'));
  const round1Findings = (disk.reviews?.[change.id] ?? [])[0]?.findings ?? [];
  assert.ok(round1Findings.length === 1, 'round-1 finding recorded');
  const claims = disk.repairClaims?.[change.id] ?? [];
  assert.ok(claims.some((c) => c.findingId === round1Findings[0].id && c.status === 'fixed'),
    'repair claim carries the unresolved finding ID');

  // Identity continuity through the loop: same task + Change, reviewer
  // session distinct from every recorded implementation session.
  const r2 = await ctx.taskChangeControl.runGovernedSdlc(task.id, { verdict: { verdict: 'pass' } });
  assert.equal(r2.outcome, 'approved');
  assert.equal(r2.changeId, change.id, 'same Change identity across the loop');
  assert.equal((await taskStore.get(task.id)).status, 'done');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'APPROVED');
  const status = await ctx.changeControl.status(change.id);
  assert.equal(status.attempts.length, 2, 'initial implementation attempt + one repair attempt');
  const attemptSessions = new Set(status.attempts.map((a) => a.sessionId).filter(Boolean));
  assert.ok(!attemptSessions.has(REVIEWER_SESSION), 'reviewer session is distinct from every implementation session');
});

test('T-H5: repeated fail loops honor maxRepairRounds → escalation; re-invocation converges without re-routing', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change);

  const r1 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {
    verdict: { verdict: 'fail', findings: [finding('p1')] },
    worker: 'w-r1', workerLauncher: repairLauncher('sess-repair-r1'),
    repairProof: repairProof('a1', 'a2', 'c2'), maxRepairRounds: 2,
  });
  assert.equal(r1.outcome, 'review_pending');
  const r2 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {
    verdict: { verdict: 'fail', findings: [finding('p2')] },
    worker: 'w-r2', workerLauncher: repairLauncher('sess-repair-r2'),
    repairProof: repairProof('a2', 'a3', 'c3'), maxRepairRounds: 2,
  });
  assert.equal(r2.outcome, 'review_pending');
  const r3 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {
    verdict: { verdict: 'fail', findings: [finding('p3')] },
    maxRepairRounds: 2,
  });
  assert.equal(r3.outcome, 'escalated');
  assert.equal((await taskStore.get(task.id)).status, 'failed');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REPAIR', 'terminal until human disposition');

  // Re-invocation after escalation is a no-op: no re-routing, no second audit.
  const r4 = await ctx.taskChangeControl.runGovernedSdlc(task.id, { verdict: { verdict: 'pass' } });
  assert.equal(r4.outcome, 'escalated');
  assert.equal((await taskStore.get(task.id)).status, 'failed');
  const escalations = (await ctx.changeControl.history(change.id))
    .filter((e) => e.kind === 'review_orchestration' && e.action === 'escalated');
  assert.equal(escalations.length, 1, 'escalation audited exactly once');
  assert.equal(reviewerLaunches(), 3, 'one reviewer launch per revision: rounds a1, a2, a3; no reviewer launch after escalation');
});

test('T-H5: deterministic preflight fails closed (no reviewer launch); the controller resumes after correction', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  const result = await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['FAIL: build'] });

  // A failing controller preflight check must NOT advance to REVIEW or
  // launch a reviewer; the trigger reports the failed gate as an outcome.
  assert.equal((await ctx.changeControl.get(change.id)).state, 'PREFLIGHT');
  assert.equal(reviewerLaunches(), 0, 'no reviewer launched on failed preflight');
  assert.equal(result.task?.sdlc?.outcome ?? result.sdlc?.outcome, 'preflight_failed');

  // Resumable: re-invocation with corrected deterministic input advances.
  const out = await ctx.taskChangeControl.runGovernedSdlc(task.id, { controllerPreflightOverride: ['pass:build'] });
  assert.equal(out.outcome, 'review_pending');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW');
  assert.equal(reviewerLaunches(), 1);
});

test('T-H12: failed reviewer prompt claim is recoverable without a lease wait', async (t) => {
  const { ctx, taskStore, dir, storePath, reviewerLaunches } = await compose(t, {
    reviewerSessionId: (n) => {
      if (n === 1) throw Object.assign(new Error('reviewer prompt failed'), { code: 'SESSION_PROMPT_FAILED' });
      return `sess-review-retry-${n}`;
    },
  });
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['FAIL: build'] });
  assert.equal((await ctx.changeControl.get(change.id)).state, 'PREFLIGHT');

  await assert.rejects(
    ctx.taskChangeControl.runGovernedReview(task.id, { controllerPreflightOverride: ['pass:build'] }),
    (error) => error?.code === 'SESSION_PROMPT_FAILED',
    'the first reviewer prompt failure remains attributable to its launch error',
  );
  assert.equal(reviewerLaunches(), 1, 'failed reviewer launch is counted once');
  assert.equal(
    (await ctx.changeControl.listRoleBindings()).filter((b) => b.changeId === change.id && b.role === 'reviewer').length,
    0,
    'failed reviewer launch leaves no reviewer binding',
  );

  const started = performance.now();
  const retry = await ctx.taskChangeControl.runGovernedReview(task.id, { controllerPreflightOverride: ['pass:build'] });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 30_000, `retry must not wait for the ${10 * 60}s claim lease (elapsed ${elapsed}ms)`);
  assert.equal(retry.outcome, 'review_started');
  assert.equal(reviewerLaunches(), 2, 'retry launches one fresh reviewer session');
  const reviewers = (await ctx.changeControl.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.equal(reviewers.length, 1, 'retry persists exactly one reviewer binding');
  const revision = (await ctx.changeControl.status(change.id)).revision;
  const requests = (await ctx.changeControl.history(change.id))
    .filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested');
  assert.equal(requests.length, 1, 'only the successful retry records a reviewer request');
  assert.equal(requests[0].revision, revision, 'request is attributed to the current proof revision');
  assert.equal(requests[0].sessionId, 'sess-review-retry-2', 'request names the retry reviewer session');
});

test('T-H12 round-3: a prior round\'s reviewer session can never settle the current round', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change);

  // Round A (revision a1, REVIEWER_SESSION) fails; the repair advances the
  // Change to revision a2 with its OWN round-B reviewer session.
  const r1 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {
    verdict: { verdict: 'fail', findings: [finding('p1')] },
    worker: 'w-repair-rs', workerLauncher: repairLauncher('sess-repair-rs'),
    repairProof: repairProof('a1', 'a2', 'c2'), maxRepairRounds: 2,
  });
  assert.equal(r1.outcome, 'review_pending');
  assert.equal(reviewerLaunches(), 2, 'round B launched its own reviewer');

  // Negative case 1 — the controller must REJECT a verdict naming round A's
  // session: it cannot settle round B.
  await assert.rejects(
    ctx.taskChangeControl.runGovernedSdlc(task.id, {
      verdict: { verdict: 'pass', sessionId: REVIEWER_SESSION },
    }),
    (error) => error?.code === 'STALE_ROUND_SESSION',
    'round-A session must not settle round B',
  );
  // Direct settlement path rejects identically.
  await assert.rejects(
    ctx.taskChangeControl.applyReviewOutcome(task.id, { sessionId: REVIEWER_SESSION, verdict: 'pass' }),
    (error) => error?.code === 'STALE_ROUND_SESSION',
    'applyReviewOutcome rejects the stale round session',
  );
  // Nothing settled: Change stays in REVIEW, task stays in_review.
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW');
  assert.equal((await taskStore.get(task.id)).status, 'in_review');
  const audits = await ctx.changeControl.history(change.id);
  assert.ok(audits.some((e) => e.kind === 'review_orchestration'
    && e.action === 'review_outcome_wrong_round_session'
    && e.sessionId === REVIEWER_SESSION),
    'the rejected cross-round settlement is audited with the offending session');
  assert.ok(!audits.some((e) => e.action === 'review_pass_approved'),
    'no settlement was applied');

  // The genuine round-B reviewer session settles.
  const r2 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {
    verdict: { verdict: 'pass', sessionId: `${REVIEWER_SESSION}-2` },
  });
  assert.equal(r2.outcome, 'approved');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'APPROVED');
  assert.equal((await taskStore.get(task.id)).status, 'done');
});

test('T-H12 round-4: the model-facing change_submit_review tool seam rejects a prior-round reviewer on the current revision (F1)', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change);

  // Round A (revision a1, REVIEWER_SESSION) FAILs; repair advances to a2 and
  // round B launches its own fresh reviewer (REVIEWER_SESSION-2).
  const r1 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {
    verdict: { verdict: 'fail', findings: [finding('t1')] },
    worker: 'w-repair-tool', workerLauncher: repairLauncher('sess-repair-tool'),
    repairProof: repairProof('a1', 'a2', 'c2'), maxRepairRounds: 2,
  });
  assert.equal(r1.outcome, 'review_pending');
  assert.equal(reviewerLaunches(), 2);
  assert.equal((await ctx.changeControl.status(change.id)).revision, 'a2');

  const reviewTool = ctx.tools.view().visible.get('change_submit_review');
  assert.ok(reviewTool, 'real model-facing change_submit_review is registered');

  // The CANONICAL tool seam: round A's still-bound reviewer tries to approve
  // the CURRENT revision — rejected BEFORE any store mutation.
  await assert.rejects(
    reviewTool.execute(
      { changeId: change.id, review: { verdict: 'pass', revision: 'a2', findings: [] } },
      { agent: { id: REVIEWER_SESSION } },
    ),
    (error) => error?.code === 'STALE_ROUND_SESSION',
    'the tool seam rejects a prior-round reviewer settling the current revision',
  );
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW', 'no settlement leaked');
  const rejected = (await ctx.changeControl.history(change.id)).filter((e) =>
    e.kind === 'review_orchestration' && e.action === 'review_submit_wrong_round_session');
  assert.equal(rejected.length, 1, 'the rejected tool settlement is audited');
  assert.equal(rejected[0].sessionId, REVIEWER_SESSION);
  assert.equal(rejected[0].expectedSessionId, `${REVIEWER_SESSION}-2`);

  // The current round's own reviewer settles through the same seam.
  const result = await reviewTool.execute(
    { changeId: change.id, review: { verdict: 'pass', revision: 'a2', findings: [] } },
    { agent: { id: `${REVIEWER_SESSION}-2` } },
  );
  assert.equal(result.state, 'APPROVED', 'the current round reviewer settles through the tool seam');
  await waitFor(() => taskStore.get(task.id).status === 'done', 5000, 'H11 wake converged the task');

  // Standalone, non-governed Change Control behavior is untouched: an
  // unlinked Change in REVIEW settles with its (legacy) bound reviewer even
  // without any durable round record.
  const standalone = await ctx.changeControl.create({
    title: 'standalone', objective: 'o', acceptanceCriteria: ['s'], risk: 'low',
  });
  for (const state of ['PLANNED', 'READY', 'IMPLEMENTING']) {
    await ctx.changeControl.transition(standalone.id, state, { actor: 'host' });
  }
  await ctx.changeControl.bindRole(standalone.id, 'sess-standalone', 'reviewer');
  await ctx.changeControl.submitProof(standalone.id, {
    beforeRevision: 'base', afterRevision: 'solo1', commit_sha: 'solo1',
    files_changed: ['f'], tests_run: ['t'], remaining_blockers: [],
    criteria: [{ id: 's', satisfied: true }], deviations: [],
    workerChecks: ['ok'], controllerPreflight: ['ok'], summary: 'standalone done',
  });
  if ((await ctx.changeControl.get(standalone.id)).state === 'PREFLIGHT') {
    await ctx.changeControl.transition(standalone.id, 'REVIEW', { actor: 'host' });
  }
  const soloReview = await reviewTool.execute(
    { changeId: standalone.id, review: { verdict: 'pass', revision: 'solo1', findings: [] } },
    { agent: { id: 'sess-standalone' } },
  );
  assert.equal(soloReview.state, 'APPROVED', 'standalone (no round record) review behavior is unchanged');
});

test('T-H12 round-4: a production-launched reviewer turn that exits/fails without a verdict expires only its round and issues exactly one fresh request (fail-closed)', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches, endReviewerTurn } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change);
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW');
  assert.equal(reviewerLaunches(), 1);

  // (a) The REAL launched reviewer's turn EXITS without a verdict. The
  // production observer (wired to the launcher handle, not a caller callback)
  // expires only round a1 and issues exactly one recoverable fresh request.
  endReviewerTurn(REVIEWER_SESSION, 'exited');
  await waitFor(() => reviewerLaunches() === 2, 5000, 'observer recovered the exited round exactly once');
  const reviewers1 = (await ctx.changeControl.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.deepEqual(reviewers1.map((b) => b.sessionId), [`${REVIEWER_SESSION}-2`],
    'only the dead session\'s binding is invalidated — no leak of the dead round');
  // Fail-closed: the Change never ADVANCES without a real verdict.
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW');
  assert.equal((await taskStore.get(task.id)).status, 'in_review');

  // (b) A turn FAILURE (exit ≠ 0): identical recovery, again exactly once.
  endReviewerTurn(`${REVIEWER_SESSION}-2`, 'failed');
  await waitFor(() => reviewerLaunches() === 3, 5000, 'observer recovered the failed turn exactly once');

  // (c) A live reviewer turn: no churn across further controller wakes.
  const r3 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {});
  assert.equal(r3.outcome, 'review_pending');
  assert.equal(r3.sessionId, `${REVIEWER_SESSION}-3`, 'converged on the current round session');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(reviewerLaunches(), 3, 'healthy reviewer is never re-requested');

  const audits = await ctx.changeControl.history(change.id);
  const ended = audits.filter((e) => e.kind === 'review_orchestration' && e.action === 'reviewer_turn_ended_no_verdict');
  assert.deepEqual(
    ended.map((e) => ({ sessionId: e.sessionId, revision: e.revision, exitCode: e.exitCode })),
    [
      { sessionId: REVIEWER_SESSION, revision: 'a1', exitCode: 0 },
      { sessionId: `${REVIEWER_SESSION}-2`, revision: 'a1', exitCode: 1 },
    ],
    'each dead turn is audited with its session, round revision, and exit status',
  );
  const requests = audits.filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested');
  assert.equal(requests.length, 3, 'one explicit request per round turn — initial + two recoveries');

  // The recovered round still settles normally with a real verdict.
  const r4 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {
    verdict: { verdict: 'pass', sessionId: `${REVIEWER_SESSION}-3` },
  });
  assert.equal(r4.outcome, 'approved');
  assert.equal((await taskStore.get(task.id)).status, 'done');
});

test('T-H12 round-5 (F1): restart-style wake reattaches turn observation to the recorded round session; a rejected existing-session waiter recovers exactly once', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches, rejectObservedTurn, observedSessions } = await compose(t, { observableReviewerSessions: true });
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change);
  assert.equal(reviewerLaunches(), 1);
  assert.deepEqual(observedSessions(), [], 'fresh launches observe their own handle — no duplicate attach');

  // (a) A restart-style wake finds the round's CONFIRMED session through
  // durable state alone: NO new launch; production observation reattaches to
  // exactly the recorded round session (the observer a controller restart
  // would own — the only durable path back to a dead turn).
  const r2 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {});
  assert.equal(r2.outcome, 'review_pending');
  assert.equal(r2.sessionId, REVIEWER_SESSION);
  assert.deepEqual(observedSessions(), [REVIEWER_SESSION], 'observation reattached exactly once to the recorded round session');
  assert.equal(reviewerLaunches(), 1, 'a confirmed round is never re-requested');

  // (b) The existing-session waiter REJECTS (host reports the reviewer
  // session unreachable): dead-turn recovery — expire only this round,
  // fail-closed audit with the rejection evidence, exactly one fresh
  // explicit request. Never swallowed into permanent review_pending.
  rejectObservedTurn(REVIEWER_SESSION);
  await waitFor(() => reviewerLaunches() === 2, 5000, 'rejected waiter recovered exactly once');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW', 'no PASS inferred from a rejection');
  assert.equal((await taskStore.get(task.id)).status, 'in_review');
  const audits = await ctx.changeControl.history(change.id);
  const ended = audits.filter((e) => e.kind === 'review_orchestration' && e.action === 'reviewer_turn_ended_no_verdict');
  assert.equal(ended.length, 1, 'the rejected turn is audited exactly once');
  assert.equal(ended[0].sessionId, REVIEWER_SESSION);
  assert.equal(ended[0].revision, 'a1');
  assert.match(String(ended[0].error ?? ''), /unreachable/, 'the waiter rejection is the audited failure evidence');
  assert.equal(
    audits.filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested').length,
    2, 'initial request + exactly one recovery request — never a burst',
  );
  const reviewers = (await ctx.changeControl.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.deepEqual(reviewers.map((b) => b.sessionId), [`${REVIEWER_SESSION}-2`],
    'only the rejected round\'s binding was invalidated');

  // (c) The recovered current round still settles normally with a real
  // verdict — attribution/guard semantics preserved.
  const r3 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {
    verdict: { verdict: 'pass', sessionId: `${REVIEWER_SESSION}-2` },
  });
  assert.equal(r3.outcome, 'approved');
  assert.equal((await taskStore.get(task.id)).status, 'done');
});

test('T-H12 round-3: crash before the request is sent recovers the unsent request exactly once', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['FAIL: build'] });
  assert.equal((await ctx.changeControl.get(change.id)).state, 'PREFLIGHT');

  // Crash window BEFORE request creation: the dead owner's durable record
  // holds a request identity but was never sent (no session, no sentAt).
  const file = reviewerClaimFileFor(task, change, 'a1');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    claimant: 'dead-host:1', requestId: 'req-unsent-1',
    sessionId: null, sentAt: null, revision: 'a1',
    updatedAt: Date.now() - 2 * 10 * 60 * 1000,
  }));

  const rv = await ctx.taskChangeControl.runGovernedReview(task.id, { controllerPreflightOverride: ['pass:build'] });
  assert.equal(rv.outcome, 'review_started');
  assert.equal(reviewerLaunches(), 1, 'the unsent request is recovered exactly once');

  // The recovered request runs under a FRESH durable identity (the crashed
  // owner's identity is never reused), atomically marked sent with the
  // recorded session.
  const record = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(record.sessionId, REVIEWER_SESSION);
  assert.equal(typeof record.sentAt, 'number', 'send is durably marked');
  assert.equal(typeof record.requestId, 'string');
  assert.notEqual(record.requestId, 'req-unsent-1', 'recovery mints a new request identity');

  // Restart AFTER recovery (re-invocation): converge with zero new launches
  // and zero duplicate request audits.
  const rv2 = await ctx.taskChangeControl.runGovernedReview(task.id, { controllerPreflightOverride: ['pass:build'] });
  assert.equal(rv2.sessionId, REVIEWER_SESSION);
  assert.equal(reviewerLaunches(), 1, 'no duplicate request after recovery');
  const requests = (await ctx.changeControl.history(change.id))
    .filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested');
  assert.equal(requests.length, 1, 'exactly one audited request for the recovered round');
  assert.equal(requests[0].requestId, record.requestId, 'audit carries the durable request identity');
});

test('T-H12 round-3: crash after the request was sent suppresses duplicates — the recorded session is adopted, never re-requested', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['FAIL: build'] });
  assert.equal((await ctx.changeControl.get(change.id)).state, 'PREFLIGHT');

  // Crash window AFTER request creation: the dead owner's record marks the
  // request SENT (session recorded + sentAt) before it bound.
  const file = reviewerClaimFileFor(task, change, 'a1');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    claimant: 'dead-host:1', requestId: 'req-sent-1',
    sessionId: 'sess-sent-unbound', sentAt: Date.now() - 11 * 60 * 1000,
    revision: 'a1', updatedAt: Date.now() - 2 * 10 * 60 * 1000,
  }));

  const rv = await ctx.taskChangeControl.runGovernedReview(task.id, { controllerPreflightOverride: ['pass:build'] });
  assert.equal(rv.outcome, 'review_started');
  assert.equal(rv.sessionId, 'sess-sent-unbound', 'the recorded sent session is adopted');
  assert.equal(reviewerLaunches(), 0, 'a sent request is never re-sent');
  const reviewers = (await ctx.changeControl.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.deepEqual(reviewers.map((b) => b.sessionId), ['sess-sent-unbound'],
    'the adopted session becomes the round\'s reviewer binding');

  // Restart again: the confirmed binding converges — still zero launches,
  // and this host added NO duplicate request audit (the send belongs to the
  // crashed owner; adoption is recorded separately).
  const rv2 = await ctx.taskChangeControl.runGovernedReview(task.id, { controllerPreflightOverride: ['pass:build'] });
  assert.equal(rv2.sessionId, 'sess-sent-unbound');
  assert.equal(reviewerLaunches(), 0);
  const audits = await ctx.changeControl.history(change.id);
  assert.equal(
    audits.filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested').length,
    0,
    'no duplicate explicit request is audited for an adopted sent request',
  );
  assert.ok(audits.some((e) => e.kind === 'review_orchestration' && e.action === 'reviewer_claim_adopted'
    && e.sessionId === 'sess-sent-unbound'), 'the adoption (not a request) is what was audited');
});

test('T-H5: trigger degrades fail-soft when the reviewer launcher is unavailable (completion still converges)', async (t) => {
  const { ctx, taskStore, dir } = await compose(t, { withReviewerLauncher: false });
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  const result = await dispatchGovernedSuccess(ctx, taskStore, dir, change);

  // The governed completion itself must not be undone by a trigger that
  // cannot launch a reviewer: task in_review, Change PREFLIGHT, audited.
  assert.equal(result.status, 'in_review');
  assert.equal(result.task?.sdlc?.outcome, 'trigger_failed');
  assert.equal((await taskStore.get(task.id)).status, 'in_review');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'PREFLIGHT');
  const audits = await ctx.changeControl.history(change.id);
  assert.ok(audits.some((e) => e.kind === 'review_orchestration' && e.action === 'sdlc_trigger_failed'),
    'failed trigger is recorded in the Change audit');
});

test('T-H5: repair routing without a worker is resumable across a restart', async (t) => {
  const { ctx, taskStore, dir, taskOrchestrator } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change);

  // Fail verdict with no repair worker supplied: the controller routes the
  // repair stage (task → ready) and stops at a resumable boundary.
  const r1 = await ctx.taskChangeControl.runGovernedSdlc(task.id, {
    verdict: { verdict: 'fail', findings: [finding('p1')] },
    maxRepairRounds: 2,
  });
  assert.equal(r1.outcome, 'repair_routed');
  assert.ok(Array.isArray(r1.openFindingIds) && r1.openFindingIds.length === 1,
    'the routed repair exposes the unresolved finding IDs');
  assert.equal((await taskStore.get(task.id)).status, 'ready');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REPAIR');

  // Restart: a fresh controller instance over the same stores resumes from
  // the persisted REPAIR state and completes the loop with the repair worker.
  const restarted = createTaskChangeControlService({
    taskOrchestrator: () => taskOrchestrator,
    changeControl: () => ctx.changeControl,
  });
  const r2 = await restarted.runGovernedSdlc(task.id, {
    verdict: { verdict: 'pass' },
    worker: 'w-r1',
    workerLauncher: repairLauncher('sess-repair-resume'),
    repairProof: repairProof('a1', 'a2', 'c2'),
    maxRepairRounds: 2,
  });
  assert.equal(r2.outcome, 'approved');
  assert.equal((await taskStore.get(task.id)).status, 'done');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'APPROVED');
});

test('T-H5 repair-r2: real preflightPolicy.requiredChecks — production trigger traverses PREFLIGHT→REVIEW with one reviewer bind', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await composeWithPolicy(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  const result = await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['pass:build'] });

  // With a real host preflight policy the STORE runPreflight is
  // authoritative: it name-matches the required check ('build') against
  // the controller's parsed check results and performs the state move
  // itself on success.
  assert.equal(result.status, 'in_review');
  const status = await ctx.changeControl.status(change.id);
  assert.equal(status.state, 'REVIEW');
  const controllerResults = status.preflight?.controllerResults ?? [];
  assert.deepEqual(controllerResults.map((r) => r.name), ['build'],
    'the parsed check name matches the host requiredChecks entry exactly');
  assert.equal(controllerResults[0]?.passed, true);

  // Exactly ONE reviewer bind and ONE PREFLIGHT→REVIEW audit transition:
  // the controller must not re-transition a state move the store already
  // performed.
  const reviewers = (await ctx.changeControl.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.equal(reviewers.length, 1, 'exactly one reviewer bound');
  assert.equal(reviewerLaunches(), 1);
  const transitions = (await ctx.changeControl.history(change.id))
    .filter((e) => e.from === 'PREFLIGHT' && e.to === 'REVIEW');
  assert.equal(transitions.length, 1, 'exactly one PREFLIGHT→REVIEW transition');
});

test('T-H5 repair-r2: failing required check under a real policy fails closed (no REVIEW, no reviewer)', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await composeWithPolicy(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  const result = await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['fail:build'] });

  assert.equal(result.status, 'in_review', 'governed completion still converges');
  assert.equal(result.task?.sdlc?.outcome ?? result.sdlc?.outcome, 'preflight_failed');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'PREFLIGHT');
  assert.equal(reviewerLaunches(), 0, 'no reviewer on failed required checks');
  const transitions = (await ctx.changeControl.history(change.id))
    .filter((e) => e.from === 'PREFLIGHT' && e.to === 'REVIEW');
  assert.equal(transitions.length, 0, 'failed required checks never move to REVIEW');
});

test('T-H5 PR1-01: real launcher that does NOT mutate the Change still completes PREFLIGHT→REVIEW (controller-owned READY→IMPLEMENTING)', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  // A production launcher NEVER transitions the Change itself. The controlled
  // dispatch must create/advance the governed lifecycle by transitioning
  // READY→IMPLEMENTING (post-guard) at a host-owned point; the task must land
  // in_review with the Change at REVIEW and one reviewer bound.
  const result = await dispatchGovernedSuccess(ctx, taskStore, dir, change, { manualTransition: false });

  assert.equal(result.status, 'in_review', 'governed completion must not land the task in failed for state READY');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW',
    'controller-owned READY→IMPLEMENTING→PREFLIGHT→REVIEW must be traversed without test-only mutation');
  const reviewers = (await ctx.changeControl.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.equal(reviewers.length, 1, 'exactly one reviewer bound');
  assert.equal(reviewerLaunches(), 1);
  assert.equal((await taskStore.get(task.id)).status, 'in_review');
});

test('T-H5 PR1-02: concurrent runGovernedSdlc calls launch and bind exactly ONE reviewer (atomic reservation)', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await compose(t, {
    reviewerLaunchDelay: 50,
    reviewerSessionId: (n) => `sess-rv-${n}`,
  });
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  // Land in PREFLIGHT with the task in_review and NO reviewer bound yet, so
  // both concurrent controller calls race to launch/bind. (A failing initial
  // preflight parks the Change in PREFLIGHT without a reviewer.)
  const result = await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['FAIL: build'] });
  assert.equal(result.status, 'in_review');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'PREFLIGHT');
  assert.equal(reviewerLaunches(), 0);

  const [a, b] = await Promise.all([
    ctx.taskChangeControl.runGovernedSdlc(task.id, { controllerPreflightOverride: ['pass:build'] }),
    ctx.taskChangeControl.runGovernedSdlc(task.id, { controllerPreflightOverride: ['pass:build'] }),
  ]);
  assert.equal(a.outcome, 'review_pending');
  assert.equal(b.outcome, 'review_pending');
  // Atomic/idempotent reservation: both calls resolve to the SAME reviewer
  // session; exactly one launch, exactly one persisted reviewer binding.
  assert.equal(reviewerLaunches(), 1, 'concurrent controller calls must not launch duplicate reviewers');
  const reviewers = (await ctx.changeControl.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.equal(reviewers.length, 1, 'exactly one reviewer binding persisted');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW');
});

// ─── T-H5 PR2-01 — durable cross-process reviewer claim ───────────────────────

/**
 * Durable claim-file convention (mirrors src/service.js, T-H5 PR2-01 + T-H12):
 *   <task.workspace>/.dsh-governance/reviewer-claims/reviewer-claim-<changeId>-<encoded revision>
 * Exclusive-create claims it; atomic rewrites record the launched session
 * BEFORE binding so a crashed owner's reviewer is adopted, not re-launched.
 * The claim is keyed by the Change's CURRENT revision: dispatchGovernedSuccess
 * defaults to afterRevision 'a1', so the round-1 claim encodes 'a1'.
 */
function reviewerClaimFileFor(task, change, revision = 'a1') {
  const base = typeof task?.workspace === 'string' && task.workspace.trim() !== '' ? task.workspace : tmpdir();
  return join(base, '.dsh-governance', 'reviewer-claims', `reviewer-claim-${String(change.id)}-${encodeURIComponent(String(revision))}`);
}

/** Self-contained host process: same composition as compose(), racing runGovernedSdlc. */
const REVIEWER_CHILD_SCRIPT = `
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import changeControlPlugin from 'dsh-change-control';
import plugin from './src/index.js';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.TCC_DIR;
const taskId = process.env.TCC_TASK_ID;
const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
let launches = 0;
const taskOrchestrator = Object.freeze({
  get: taskStore.get.bind(taskStore),
  update: taskStore.update.bind(taskStore),
  updateIf: (id, expected, patch) => taskStore.updateIf(id, expected, patch),
  createReviewerLauncher: () => ({
    async launch() {
      launches += 1;
      const sessionId = 'sess-child-' + process.pid + '-' + launches;
      appendFileSync(join(dir, 'reviewer-launches.log'), sessionId + '\\n');
      // Widen the cross-process race window deliberately (env-tunable for stress).
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.TCC_LAUNCH_MS || 200)));
      // T-H12 round-4: the observer treats a RESOLVED wait() as a dead turn.
      // A healthy live turn is pending until the child exits.
      return { sessionId, wait: () => new Promise(() => {}), terminate: async () => true };
    },
  }),
});
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime, {});
ctx.provide('taskOrchestrator', taskOrchestrator);
await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
await ctx.plugin(plugin);
const result = await ctx.taskChangeControl.runGovernedSdlc(taskId, { controllerPreflightOverride: ['pass:build'] });
process.stdout.write(JSON.stringify({ outcome: result.outcome, sessionId: result.sessionId ?? null }) + '\\n');
`;

/** Spawn one host process driving runGovernedSdlc against the shared store dir. */
// Bounded execution: a healthy stress child launches/converges in ~1-2 s, so a
// 2-minute ceiling gives generous headroom against SQLite/JSON writer
// contention while still failing FAST (with its captured stderr) when the
// reservation fails to converge — instead of letting a stuck child burn the
// production 11-minute REVIEWER_CLAIM_WAIT_MS deadline per trial.
const CHILD_TIMEOUT_MS = 2 * 60 * 1000;
function spawnReviewerProcess(dir, taskId, { launchMs = 200, timeoutMs = CHILD_TIMEOUT_MS, context = '', t } = {}) {
  const label = context ? `${context} ` : '';
  const child = spawn(process.execPath, ['--input-type=module', '-e', REVIEWER_CHILD_SCRIPT], {
    cwd: PKG_DIR,
    env: { ...process.env, TCC_DIR: dir, TCC_TASK_ID: taskId, TCC_LAUNCH_MS: String(launchMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Guaranteed reaping: any child still alive at test teardown (including an
  // assertion failure before its promise settles) is SIGKILLed, so a hung host
  // can never outlive the test or leak into CI teardown.
  if (t) t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve) => {
    // Bounded execution: a child that never exits (e.g. a reviewer launch deadlock)
    // is killed and reported with its trial/child context instead of hanging CI.
    const timer = setTimeout(() => {
      const msg = `${label}timed out after ${timeoutMs}ms; killed pid ${child.pid}`;
      child.kill('SIGKILL');
      resolve({ code: -2, stdout: stdout.trim(), stderr: `${stderr}${msg}`.trim() });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: stdout.trim(), stderr: `${stderr}${label}${String(err)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr });
    });
  });
}

test('T-H5 PR2-01: two host processes on one store launch exactly ONE reviewer (durable cross-process claim)', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  // Land in PREFLIGHT with the task in_review and NO reviewer yet, exactly
  // like the in-process PR1-02 race — then race TWO SEPARATE processes.
  await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['FAIL: build'] });
  assert.equal((await ctx.changeControl.get(change.id)).state, 'PREFLIGHT');

  const [a, b] = await Promise.all([
    spawnReviewerProcess(dir, task.id, { context: 'host A', t }),
    spawnReviewerProcess(dir, task.id, { context: 'host B', t }),
  ]);
  assert.equal(a.code, 0, `host process A must complete: ${a.stderr || a.stdout}`);
  assert.equal(b.code, 0, `host process B must complete: ${b.stderr || b.stdout}`);
  const ra = JSON.parse(a.stdout);
  const rb = JSON.parse(b.stdout);
  assert.equal(ra.outcome, 'review_pending');
  assert.equal(rb.outcome, 'review_pending');
  assert.equal(ra.sessionId, rb.sessionId, 'both processes converge on the SAME reviewer session');
  // The durable cross-process claim must have produced exactly ONE reviewer
  // launch and ONE persisted reviewer binding — the pre-fix race launched
  // one reviewer PER PROCESS (and left the loser's session orphaned).
  const launchLines = readFileSync(join(dir, 'reviewer-launches.log'), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(launchLines.length, 1, 'concurrent host processes must launch exactly one reviewer');
  const reviewers = (await ctx.changeControl.listRoleBindings())
    .filter((x) => x.changeId === change.id && x.role === 'reviewer');
  assert.equal(reviewers.length, 1, 'exactly one reviewer binding persisted');
  assert.equal(reviewers[0].sessionId, ra.sessionId);
  // State is asserted on DISK truth: a long-lived in-process ChangeStore view
  // is cross-process stale by design (get() never re-reads), so the parent's
  // own store may lag the children's persisted REVIEW.
  const diskState = JSON.parse(readFileSync(join(dir, 'changes.json'), 'utf8'))
    .changes.find((c) => c.id === change.id).domainState;
  assert.equal(diskState, 'REVIEW');
});

test('T-H5 PR2-01: crashed claim owner\'s recorded reviewer session is adopted on restart (no relaunch, no orphan)', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['FAIL: build'] });
  // Simulate a crashed owner: its durable claim records a launched session
  // that was never bound (crash between launch and bind), lease expired.
  const claimFile = reviewerClaimFileFor(task, change);
  await mkdir(dirname(claimFile), { recursive: true });
  await writeFile(claimFile, JSON.stringify({
    claimant: 'dead-host:4242',
    sessionId: 'sess-crashed-reviewer',
    updatedAt: Date.now() - 2 * 10 * 60 * 1000, // stale: beyond the 10-minute claim lease
  }), 'utf8');

  const result = await ctx.taskChangeControl.runGovernedSdlc(task.id, { controllerPreflightOverride: ['pass:build'] });
  assert.equal(result.outcome, 'review_pending');
  assert.equal(reviewerLaunches(), 0, 'a recorded session is adopted, never re-launched');
  const reviewers = (await ctx.changeControl.listRoleBindings())
    .filter((x) => x.changeId === change.id && x.role === 'reviewer');
  assert.equal(reviewers.length, 1, 'the adopted session becomes the one and only reviewer binding');
  assert.equal(reviewers[0].sessionId, 'sess-crashed-reviewer');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW');
});

test('T-H5 PR2-01: a stale claim with no recorded session is taken over with exactly one fresh launch', async (t) => {
  const { ctx, taskStore, dir, reviewerLaunches } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['FAIL: build'] });
  // The owner died before recording any session (crash during launch): a
  // stale claim with no session. A successor must take over and launch
  // exactly one reviewer — no adoption (nothing recorded), no duplicate.
  const claimFile = reviewerClaimFileFor(task, change);
  await mkdir(dirname(claimFile), { recursive: true });
  await writeFile(claimFile, JSON.stringify({
    claimant: 'dead-host:4242',
    sessionId: null,
    updatedAt: Date.now() - 2 * 10 * 60 * 1000,
  }), 'utf8');

  const result = await ctx.taskChangeControl.runGovernedSdlc(task.id, { controllerPreflightOverride: ['pass:build'] });
  assert.equal(result.outcome, 'review_pending');
  assert.equal(reviewerLaunches(), 1, 'a stale empty claim is taken over with one fresh launch');
  const reviewers = (await ctx.changeControl.listRoleBindings())
    .filter((x) => x.changeId === change.id && x.role === 'reviewer');
  assert.equal(reviewers.length, 1);
  assert.equal(result.sessionId, reviewers[0].sessionId);
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REVIEW');
});


// ─── T-H5 PR2-02 — stale-claim takeover race (multi-process stress) ────────

/**
 * Name the exact invariant a stress trial violated (or null when clean), so a
 * flaky multi-process failure is self-diagnosing instead of reporting "duplicate
 * reviewers" regardless of which guarantee broke. The five guarantees are
 * exactly-one LAUNCH, one BINDING, one session (no orphan), REVIEW disk state,
 * and session identity convergence across processes.
 */
function trialViolation({ launches, sessionIds, reviewers, diskState, firstSessionId }) {
  if (launches !== 1) return `launched ${launches} reviewers (expected exactly 1)`;
  const distinct = [...new Set(sessionIds.filter(Boolean))];
  if (distinct.length !== 1) {
    return `diverged to ${distinct.length} distinct reviewer sessions ${JSON.stringify(sessionIds)} (expected 1, no orphan)`;
  }
  if (reviewers.length !== 1) return `persisted ${reviewers.length} reviewer bindings (expected exactly 1)`;
  if (diskState !== 'REVIEW') return `disk Change state is ${diskState} (expected REVIEW)`;
  if (reviewers[0].sessionId !== firstSessionId) {
    return `binding session ${reviewers[0].sessionId} != first process session ${firstSessionId}`;
  }
  return null;
}

test('T-H5 PR2-02: stress — many host processes racing to take over the same stale empty claim launch exactly ONE reviewer', async (t) => {
  // The pre-fix race: a stale reader reads the claim file and then deletes it
  // UNCONDITIONALLY; a fresh claim acquired by another process in that window
  // gets wiped, and the stale reader launches a DUPLICATE reviewer (an orphaned
  // loser). Each process pair is a coin flip, so run independent trials with
  // many processes and stop at the FIRST trial that violates the invariant —
  // exactly ONE reviewer launch, ONE binding, no orphaned loser.
  const N = 48;             // host processes per trial (more processes, more race pairs)
  const LAUNCH_MS = 800;    // widen the "fresh claim, no session" window the race targets
  const MAX_TRIALS = 30;    // cap: post-fix every trial is clean, so all run
  let duplicateTrial = 0;
  let duplicateReason = null;
  for (let trial = 1; trial <= MAX_TRIALS; trial += 1) {
    const { ctx, taskStore, dir } = await compose(t);
    const { task, change } = await governedReadyTask(ctx, taskStore, dir);
    // Land in PREFLIGHT with NO reviewer, then pre-stage the finding's
    // "stale empty claim": an owner died after claiming but before recording
    // any session (no session, updatedAt far past the lease).
    await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['FAIL: build'] });
    assert.equal((await ctx.changeControl.get(change.id)).state, 'PREFLIGHT');
    const claimFile = reviewerClaimFileFor(task, change);
    await mkdir(dirname(claimFile), { recursive: true });
    await writeFile(claimFile, JSON.stringify({
      claimant: 'dead-host:9999',
      sessionId: null,
      updatedAt: Date.now() - 2 * 10 * 60 * 1000,
    }), 'utf8');

    const children = await Promise.all(Array.from({ length: N }, (_, i) => spawnReviewerProcess(dir, task.id, {
      launchMs: LAUNCH_MS,
      context: `trial ${trial} host ${i}`,
      t,
    })));
    children.forEach((ch, i) => assert.equal(ch.code, 0, `trial ${trial} host ${i} must complete: ${ch.stderr || ch.stdout}`));
    const results = children.map((ch) => JSON.parse(ch.stdout));
    results.forEach((r, i) => assert.equal(r.outcome, 'review_pending', `trial ${trial} host ${i} converges to review_pending`));

    let launches = 0;
    try {
      launches = readFileSync(join(dir, 'reviewer-launches.log'), 'utf8').trim().split('\n').filter(Boolean).length;
    } catch { /* zero launches is a violation, recorded below */ }
    // No orphaned loser: every process must converge on the SAME reviewer
    // session — a process that launched its own reviewer left an orphan.
    const sessions = new Set(results.map((r) => r.sessionId));
    const reviewers = (await ctx.changeControl.listRoleBindings())
      .filter((b) => b.changeId === change.id && b.role === 'reviewer');
    const diskState = JSON.parse(readFileSync(join(dir, 'changes.json'), 'utf8')).changes
      .find((c) => c.id === change.id).domainState;
    const violation = trialViolation({
      launches, sessionIds: [...sessions], reviewers, diskState, firstSessionId: results[0]?.sessionId ?? null,
    });
    if (violation) {
      duplicateTrial = trial;
      duplicateReason = violation;
      break;
    }
  }
  assert.equal(duplicateTrial, 0,
    duplicateTrial
      ? `trial ${duplicateTrial} ${duplicateReason} (one launch, one binding, no orphaned loser required)`
      : 'no trial violated the exactly-one invariant');
});

// ─── T-H5 PR2-03 — stale reclaim-lock recovery race (multi-process stress) ─

test('T-H5 PR2-03: stress — many host processes racing to reclaim a stale claim through a STALE RECLAIM LOCK launch exactly ONE reviewer', async (t) => {
  // The pre-fix race: acquireReclaimLock read a stale lock and then
  // UNCONDITIONALLY renamed the lock file aside; a fresh lock created by
  // another process in that window got moved out of the slot, and the stale
  // reader exclusive-created its own lock — two concurrent lock holders, two
  // claim creators, duplicate reviewer launches (orphaned losers). Run
  // independent trials with many processes and stop at the FIRST trial that
  // violates the invariant — exactly ONE reviewer launch, ONE binding, no
  // orphaned loser.
  const N = 16;          // host processes per trial (sized to stay fast under full-suite parallel load)
  const MAX_TRIALS = 30; // cap: post-fix every trial is clean, so all run
  let duplicateTrial = 0;
  let duplicateReason = null;
  for (let trial = 1; trial <= MAX_TRIALS; trial += 1) {
    const { ctx, taskStore, dir } = await compose(t);
    const { task, change } = await governedReadyTask(ctx, taskStore, dir);
    // Land in PREFLIGHT with NO reviewer, then pre-stage the finding's
    // "stale empty claim" PLUS a "stale reclaim lock" (its holder died
    // while breaking the lock): every contender must run the stale-lock
    // recovery path before it can (re)create the claim.
    await dispatchGovernedSuccess(ctx, taskStore, dir, change, { preflight: ['FAIL: build'] });
    assert.equal((await ctx.changeControl.get(change.id)).state, 'PREFLIGHT');
    const claimFile = reviewerClaimFileFor(task, change);
    await mkdir(dirname(claimFile), { recursive: true });
    await writeFile(claimFile, JSON.stringify({
      claimant: 'dead-host:9999',
      sessionId: null,
      updatedAt: Date.now() - 2 * 10 * 60 * 1000,
    }), 'utf8');
    await writeFile(`${claimFile}.lock`, JSON.stringify({
      owner: 'dead-locker:4242',
      updatedAt: Date.now() - 2 * 10 * 60 * 1000, // stale: beyond the 10-minute lease
    }), 'utf8');

    const children = await Promise.all(Array.from({ length: N }, (_, i) => spawnReviewerProcess(dir, task.id, {
      context: `trial ${trial} host ${i}`,
      t,
    })));
    children.forEach((ch, i) => assert.equal(ch.code, 0, `trial ${trial} host ${i} must complete: ${ch.stderr || ch.stdout}`));
    const results = children.map((ch) => JSON.parse(ch.stdout));
    results.forEach((r, i) => assert.equal(r.outcome, 'review_pending', `trial ${trial} host ${i} converges to review_pending`));

    let launches = 0;
    try {
      launches = readFileSync(join(dir, 'reviewer-launches.log'), 'utf8').trim().split('\n').filter(Boolean).length;
    } catch { /* zero launches is a violation, recorded below */ }
    // No orphaned loser: every process must converge on the SAME reviewer
    // session — a process that launched its own reviewer left an orphan.
    const sessions = new Set(results.map((r) => r.sessionId));
    const reviewers = (await ctx.changeControl.listRoleBindings())
      .filter((b) => b.changeId === change.id && b.role === 'reviewer');
    const diskState = JSON.parse(readFileSync(join(dir, 'changes.json'), 'utf8')).changes
      .find((c) => c.id === change.id).domainState;
    const violation = trialViolation({
      launches, sessionIds: [...sessions], reviewers, diskState, firstSessionId: results[0]?.sessionId ?? null,
    });
    if (violation) {
      duplicateTrial = trial;
      duplicateReason = violation;
      break;
    }
  }
  assert.equal(duplicateTrial, 0,
    duplicateTrial
      ? `trial ${duplicateTrial} ${duplicateReason} (one launch, one binding, no orphaned loser required)`
      : 'no trial violated the exactly-one invariant');
});
