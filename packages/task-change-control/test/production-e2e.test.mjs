// T-H7 — release-gate production E2E regression for the three-plugin governed
// SDLC workflow. This test loads the ACTUAL production packages
// (dsh-task-orchestrator, dsh-change-control, dsh-task-change-control) in one
// real Cordis Context, persists against a real TaskStore (SQLite) and a real
// ChangeStore (JSON), and drives the lifecycle through the ACTUAL governed
// dispatcher completion hook and the ACTUAL runGovernedSdlc controller using
// the ACTUAL session launcher factories (createWorkerLauncher /
// createReviewerLauncher) backed by a deterministic test-host RPC — it does
// NOT fake the dispatcher or the stores, and does NOT call each SDLC stage by
// hand to simulate the controller.
//
// The deterministic test-host RPC is installed by overriding `globalThis.fetch`
// (the seam `createSessionRpcClient` defaults to). It emulates the host's
// session server: session.create/selectModel/history/prompt/cancel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as taskOrchestratorPlugin from 'dsh-task-orchestrator';
import { TaskStore } from 'dsh-task-orchestrator/store';
import changeControlPlugin from 'dsh-change-control';
import integrationPlugin from '../src/index.js';
import { WORK_ITEM_SYSTEM } from '../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Deterministic test-host session RPC ──────────────────────────────────

/**
 * A stateful fake of the host session server. Tracks, per session, how many
 * `session.history` polls have occurred so the real session launcher's
 * `wait()` loop terminates exactly once (baseline poll returns no terminal,
 * every later poll returns a completed `turn/end`).
 *
 * When `proof` is set (T-H9 canonical completion envelope), the completed
 * turn the host serves carries the worker's `tool/call` + `tool/result` events
 * whose `meta` is that envelope — the durable DSH-native carrier the real
 * session launcher reads back via `session.history`. This is NOT a test
 * adapter: it emulates the host serving the session history a real
 * worker-completion tool would have produced.
 */
function createSessionRpc() {
  const sessions = new Map();
  let counter = 0;
  let proof = null;
  const createdSessionIds = [];
  const respond = (value) => ({
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: true, value } }),
  });

  const completedEvents = () => {
    if (proof === null) {
      return [
        { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'governed run completed' }] } } },
        { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ];
    }
    return [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'worker-complete-1', name: 'worker_complete', arguments: '{}' } },
      { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'worker-complete-1', content: [{ type: 'text', text: 'completed' }], isError: false }] }, meta: proof } },
      { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'governed run completed' }] } } },
      { seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ];
  };

  const fetchImpl = async (url, init) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init?.body ?? '{}');
    const payload = body.payload ?? {};
    const sessionId = payload.sessionId;

    if (method === 'session.create') {
      const sid = `sess-${++counter}`;
      sessions.set(sid, { historyCalls: 0 });
      createdSessionIds.push(sid);
      return respond({ sessionId: sid });
    }
    if (method === 'session.selectModel') return respond({});
    if (method === 'session.prompt') return respond({});
    if (method === 'session.cancel') return respond({});
    if (method === 'session.history') {
      const s = sessions.get(sessionId) ?? { historyCalls: 0 };
      s.historyCalls += 1;
      sessions.set(sessionId, s);
      if (s.historyCalls === 1) return respond({ events: [] }); // baseline
      return respond({ events: completedEvents() });
    }
    return respond({});
  };

  return { fetchImpl, setProof: (value) => { proof = value; }, createdSessionIds };
}

// ─── Composition helpers ──────────────────────────────────────────────────

function workerProof(commitSha, { files = ['src/x.js'], tests = ['test/x.test.mjs'], criteria = ['ship'], beforeRevision = 'main@baseline' } = {}) {
  return {
    protocol: 'dsh.worker-completion.v1',
    beforeRevision,
    afterRevision: commitSha,
    commit_sha: commitSha,
    files_changed: files,
    tests_run: tests,
    remaining_blockers: [],
    criteria: criteria.map((id) => ({ id, satisfied: true })),
    deviations: [],
    workerChecks: ['tests green'],
    controllerPreflight: ['pass:build'],
    summary: 'governed implementation complete',
  };
}

const taskOrchestratorPluginObject = {
  name: taskOrchestratorPlugin.name,
  inject: taskOrchestratorPlugin.inject,
  apply: taskOrchestratorPlugin.apply,
};

/**
 * Compose the three real production plugins in one real Cordis Context.
 * Returns the task service facade, the change-control facade, the integration
 * service, both durable store paths, and the RPC (for observability).
 */
async function compose(t) {
  const dir = mkdtempSync(join(tmpdir(), 'h7-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const taskDbPath = join(dir, 'tasks.db');
  const changesJsonPath = join(dir, 'changes.json');

  const rpc = createSessionRpc();
  const realFetch = globalThis.fetch;
  globalThis.fetch = rpc.fetchImpl;
  t.after(() => { globalThis.fetch = realFetch; });

  const ctx = new Context();
  t.after(() => ctx.dispose?.());

  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, {});
  ctx.provide('webServer', { register() { return () => {}; } });

  await ctx.plugin(taskOrchestratorPluginObject, {
    dbPath: taskDbPath,
    workerSpecs: {
      worker: {
        mode: 'session',
        profile: 'wp',
        agentPreset: 'worker',
        provider: 'ollama',
        model: 'm',
        workspacePolicy: 'any',
        timeoutMs: 5000,
        leaseSeconds: 300,
      },
    },
  });

  await ctx.plugin(changeControlPlugin, { storePath: changesJsonPath });
  await ctx.plugin(integrationPlugin);

  return {
    ctx,
    rpc,
    task: () => ctx.get('taskOrchestrator'),
    changeControl: () => ctx.get('changeControl'),
    taskChangeControl: () => ctx.get('taskChangeControl'),
    taskDbPath,
    changesJsonPath,
    dir,
  };
}

// ─── Test 1 — the full positive 28-step governed SDLC ──────────────────────

test('T-H7 positive: full governed SDLC driven by the real controller and real launchers', async (t) => {
  const c = await compose(t);
  const orch = c.task();
  const tcc = c.taskChangeControl();
  const cc = c.changeControl();

  // 1. create task (real TaskStore via the real orchestrator plugin)
  const task = orch.create({
    title: 'governed e2e', description: 'prove the three-plugin SDLC',
    status: 'ready', workspace: c.dir, worker_profile: 'worker',
    acceptance_criteria: ['ship'],
  });
  assert.ok(task.id, 'task created');

  // 2. bootstrap → 3. snapshot (durable, canonical task copy)
  const { change } = await tcc.bootstrapTask(task.id);
  assert.equal(change.workItem?.system, WORK_ITEM_SYSTEM, 'canonical work-item system');
  assert.ok(change.bootstrapSnapshot, 'canonical bootstrap snapshot persisted');
  assert.equal(change.bootstrapSnapshot.title, 'governed e2e');
  assert.deepEqual(change.bootstrapSnapshot.acceptance_criteria, ['ship']);

  // 4. plan → 5. approve → 6. READY
  const plan = await cc.submitPlan(change.id, { steps: ['implement', 'test'] });
  await cc.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  const statusAfterAccept = await cc.status(change.id);
  assert.equal((await cc.get(change.id)).state, 'READY', 'Change READY after accept');
  assert.ok(statusAfterAccept.acceptedPlan, 'accepted plan recorded');

  // 7. governed dispatch through the REAL tcc.createGovernedDispatcher() and
  // the UNMODIFIED production orch.createWorkerLauncher() handle. The real
  // session launcher drives session.create/history/prompt against the
  // deterministic host, reads the worker's canonical `tool/result.meta` back
  // off session.history, and surfaces the envelope on its wait() outcome —
  // no proof-surfacing adapter, no manual claim/start/bind/complete.
  let boundSession = null;
  const initialProof = workerProof('abc123'); // canonical envelope; worker's presentationMeta
  const rpc = c.rpc;
  rpc.setProof(initialProof);
  const dispatcher = tcc.createGovernedDispatcher({
    preflight: async () => ({ ok: true, spec: { mode: 'session', profile: 'wp', agentPreset: 'worker', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 5000, leaseSeconds: 300, name: 'worker' } }),
  });
  const dispatched = await dispatcher.dispatchOnce({ workerProfile: 'worker' });

  // 8. bind worker (session identity bound during the run), 9. run, 10. proof,
  // 11. governed completion, 12. in_review — all through the dispatcher.
  assert.equal(dispatched.dispatched, true, 'governed dispatch ran');
  assert.equal(dispatched.status, 'in_review', 'dispatched run converged to in_review via governed completion; error=' + JSON.stringify(dispatched.error ?? {}));
  const tAfter = orch.get(task.id);
  assert.equal(tAfter.status, 'in_review', 'task in_review');
  assert.equal(tAfter.commit_sha, 'abc123', 'commit_sha aligned on task');
  // The initial worker session is the FIRST session the deterministic host
  // created (before the reviewer and repair sessions were launched).
  assert.ok(rpc.createdSessionIds.length >= 1, 'initial worker session was created');
  boundSession = rpc.createdSessionIds[0];

  // 13. PREFLIGHT is reached, then the dispatcher's completion hook
  // auto-triggers runGovernedSdlc: deterministic preflight passes (from the
  // surfaced controllerPreflight) and the reviewer launches → the Change ends
  // up in REVIEW with a bound reviewer, returning review_pending in .sdlc.
  const sdlcFromHook = dispatched.task?.sdlc;
  assert.ok(sdlcFromHook, 'completion hook auto-advanced the SDLC');
  assert.equal(sdlcFromHook.outcome, 'review_pending', 'auto-advance stopped at review_pending');
  assert.ok(sdlcFromHook.sessionId, 'reviewer session auto-launched');
  const reviewerSession = sdlcFromHook.sessionId;
  const chAfterDispatch = await cc.get(change.id);
  assert.equal(chAfterDispatch.state, 'REVIEW', 'Change REVIEW after auto-advanced preflight');
  const proofStored = (await cc.status(change.id)).proof;
  assert.ok(proofStored && proofStored.commit_sha === 'abc123', 'proof persisted on Change');

  // 16. FAIL finding (via the controller's verdict settlement)
  const failingFindings = [
    { severity: 'critical', category: 't', location: 'src/x.js', problem: 'missing guard', requiredOutcome: 'fix and re-test' },
  ];
  const sdlc2 = await tcc.runGovernedSdlc(task.id, {
    controllerPreflightOverride: ['pass:build'],
    verdict: { verdict: 'fail', findings: failingFindings, sessionId: reviewerSession },
    maxRepairRounds: 3,
  });
  // No worker supplied → controller stops at the resumable repair_routed
  // boundary and reports the exact open finding IDs for exact-ID repair.
  assert.equal(sdlc2.outcome, 'repair_routed');
  assert.ok(Array.isArray(sdlc2.openFindingIds) && sdlc2.openFindingIds.length === 1, 'one open finding');

  // 17. REPAIR + 18. changes_requested + 19. repair are controller-owned:
  // route the repair worker (REAL session launcher) claiming the EXACT
  // finding ID, converging governed completion, then re-running preflight.
  const repairWorker = 'repair-worker-1';
  const repairProof = workerProof('def456', { files: ['src/x.js', 'src/y.js'], tests: ['test/x.test.mjs', 'test/y.test.mjs'], beforeRevision: 'abc123' });
  const repairLauncher = orch.createWorkerLauncher({}); // real factory → fetch stub RPC
  const sdlc3 = await tcc.runGovernedSdlc(task.id, {
    controllerPreflightOverride: ['pass:build'],
    worker: repairWorker,
    workerLauncher: repairLauncher,
    repairProof,
    repairFindings: sdlc2.openFindingIds.map((id) => ({ findingId: id, status: 'fixed', claim: 'fixed' })),
    repairClaim: 'fixed',
    maxRepairRounds: 3,
  });
  assert.equal(sdlc3.outcome, 'review_pending', 'repair converged → re-preflight → REVIEW → pending pass');

  // The repair claimed the EXACT finding ID from the review and converged:
  // the repair proof is now the current revision and the Change re-entered
  // REVIEW. (A scratch/wrong finding ID would have been rejected as
  // UNKNOWN_FINDING by submitRepair before reaching here.)
  const statusAfterRepair = await cc.status(change.id);
  assert.equal(statusAfterRepair.revision, 'def456', 'repair proof is the current revision');
  assert.equal(statusAfterRepair.openFindings.length, 1, 'finding record persists for the reviewer');
  assert.ok(statusAfterRepair.openFindings[0].id === sdlc2.openFindingIds[0], 'finding identity matches the reviewed ID');
  assert.equal((await cc.get(change.id)).state, 'REVIEW', 'Change back in REVIEW after repair');

  // 20. re-preflight happened inside sdlc3; 21. reviewer pass →
  // 22. APPROVED → 23. done
  const sdlc4 = await tcc.runGovernedSdlc(task.id, {
    controllerPreflightOverride: ['pass:build'],
    verdict: { verdict: 'pass', sessionId: reviewerSession },
    maxRepairRounds: 3,
  });
  assert.equal(sdlc4.outcome, 'approved');
  assert.equal((await cc.get(change.id)).state, 'APPROVED', 'Change APPROVED');
  assert.equal(orch.get(task.id).status, 'done', 'task done');

  // 24. terminal binding outcomes — the WORKER bindings are transient and
  // already released by the dispatcher/governor (audited UNBIND); the REVIEWER
  // binding intentionally persisists as the durable review record and is NOT
  // part of reconciliation. Capture both outcomes and the durable UNBIND
  // audit evidence BEFORE reopening the stores.
  const terminalBindings = (await cc.listRoleBindings()).filter((b) => b.changeId === change.id);
  const terminalWorkers = terminalBindings.filter((b) => b.role === 'worker');
  const terminalReviewers = terminalBindings.filter((b) => b.role === 'reviewer');
  assert.equal(terminalWorkers.length, 0, 'no worker binding leaks at terminal (all released)');
  assert.equal(terminalReviewers.length, 1, 'exactly one reviewer binding persists at terminal');
  assert.equal(terminalReviewers[0].sessionId, reviewerSession, 'persisted reviewer binding is the review session');
  assert.equal(terminalReviewers[0].worker, undefined, 'reviewer binding carries no worker identity');

  // 25. durable UNBIND audit evidence — the two worker dispatches (initial +
  // repair) each produced a `type:'UNBIND'` record for the SESSION they bound;
  // the reviewer session is never unbound (intentional reviewer lifecycle).
  const audit = await cc.history(change.id);
  const workerUnbinds = audit.filter((e) => e.type === 'UNBIND');
  assert.equal(workerUnbinds.length, 2, 'initial + repair worker each produced a durable UNBIND record');
  assert.ok(workerUnbinds.some((e) => e.sessionId === boundSession), 'unbind evidence for the initial dispatched worker session');
  for (const u of workerUnbinds) {
    assert.ok(typeof u.sessionId === 'string' && u.sessionId.length > 0, 'UNBIND record carries the sessionId');
    assert.notEqual(u.sessionId, reviewerSession, 'reviewer session is never unbound');
  }
  // The reconciliation operation is idempotent here: no orphaned worker
  // bindings remain, so it records nothing and must not fabricate an unbind.
  const reconciliation = await tcc.reconcileTaskChange(task.id);
  assert.ok(reconciliation, 'reconciliation ran');
  assert.equal(reconciliation.repairs.length, 0, 'clean terminal path reports no orphaned worker repairs');
  const auditAfterReconcile = await cc.history(change.id);
  assert.equal(auditAfterReconcile.length, audit.length, 'reconciliation fabricates no spurious audit records');

  // 26. ordered audit signature + state transitions (canonical projection of
  // the durable fields; ts/eventId intentionally excluded as they are not part
  // of the semantic record). Capture the EXACT ordered sequence.
  const auditSignature = audit.map((e) => ({
    type: e.type ?? null, action: e.action ?? null, to: e.to ?? null, from: e.from ?? null,
    actor: e.actor ?? null, sessionId: e.sessionId ?? null, kind: e.kind ?? null,
  }));
  // The ordered state-transition chain: pure transition records carry `to`
  // without a `type`/`action` (audit action/type records re-report the current
  // state but are not state moves). This is the exact SDLC lifecycle.
  const transitions = audit
    .filter((e) => e.to != null && e.type == null && e.action == null)
    .map((e) => e.to);
  assert.deepEqual(
    transitions,
    ['DRAFT', 'PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW', 'REPAIR', 'PREFLIGHT', 'REVIEW', 'APPROVED'],
    'exact ordered state transitions',
  );

  // Reopen both durable stores fresh (new Context + new stores on same files).
  const ctx2 = new Context();
  t.after(() => ctx2.dispose?.());
  await ctx2.plugin(SystemPrompt);
  await ctx2.plugin(ToolRuntime, {});
  await ctx2.plugin(changeControlPlugin, { storePath: c.changesJsonPath });
  const cc2 = ctx2.get('changeControl');
  const ch2 = await cc2.get(change.id);
  assert.equal(ch2.state, 'APPROVED', 'Change APPROVED survives JSON restart');

  const store2 = new TaskStore({ dbPath: c.taskDbPath });
  t.after(() => store2.close?.());
  assert.equal(store2.get(task.id).status, 'done', 'task done survives SQLite restart');
  assert.equal(store2.get(task.id).commit_sha, 'def456', 'final commit_sha survives restart');

  // 27. exact ordered audit + binding comparison across restart: the durable
  // audit trail re-read from disk is BYTE-IDENTICAL in the semantic fields, in
  // the same order, and the terminal binding outcome (reviewer persists, no
  // worker leaks) is equally durable.
  const audit2 = await cc2.history(change.id);
  const auditSignature2 = audit2.map((e) => ({
    type: e.type ?? null, action: e.action ?? null, to: e.to ?? null, from: e.from ?? null,
    actor: e.actor ?? null, sessionId: e.sessionId ?? null, kind: e.kind ?? null,
  }));
  assert.equal(audit2.length, audit.length, 'audit trail length consistent across restart');
  assert.deepEqual(auditSignature2, auditSignature, 'exact ordered audit records identical across restart');
  const bindingsAfterRestart = (await cc2.listRoleBindings()).filter((b) => b.changeId === change.id);
  assert.deepEqual(
    bindingsAfterRestart.slice().sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    terminalBindings.slice().sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    'terminal binding outcome (reviewer persists, no worker leak) survives restart',
  );
});

// ─── Test 2 — governed dispatch + completion hook wired & fails closed ────

test('T-H7: governed dispatcher completion hook fails closed without proof (success cannot bypass proof)', async (t) => {
  const c = await compose(t);
  const orch = c.task();
  const tcc = c.taskChangeControl();
  const cc = c.changeControl();

  const task = orch.create({
    title: 'dispatch-hook', description: 'd', status: 'ready', workspace: c.dir,
    worker_profile: 'worker', acceptance_criteria: ['ship'],
  });
  const { change } = await tcc.bootstrapTask(task.id);
  const plan = await cc.submitPlan(change.id, { steps: ['s'] });
  await cc.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });

  // The REAL session launcher does not surface commit_sha, so a worker that
  // "succeeds" with no structured proof must NOT reach in_review/PREFLIGHT.
  const dispatcher = tcc.createGovernedDispatcher({
    preflight: async () => ({ ok: true, spec: { mode: 'session', profile: 'wp', agentPreset: 'worker', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 5000, leaseSeconds: 300, name: 'worker' } }),
  });
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' });

  // The dispatcher completes the run (worker exited 0) but the governed
  // completion hook rejects the proof-less success and funnels to failed.
  assert.equal(result.dispatched, true, 'dispatcher ran the worker');
  assert.equal(result.status, 'failed', 'proof-less success fails closed');
  const tAfter = orch.get(task.id);
  assert.notEqual(tAfter.status, 'in_review', 'task must NOT reach in_review without proof');
  assert.notEqual(tAfter.status, 'done', 'task must NOT reach done');
  const chAfter = await cc.get(change.id);
  assert.notEqual(chAfter.state, 'PREFLIGHT', 'Change must NOT reach PREFLIGHT without proof');
});

// ─── Negative invariants (real facades) ────────────────────────────────────

test('T-H7: governed dispatch requires an accepted plan', async (t) => {
  const c = await compose(t);
  const orch = c.task();
  const tcc = c.taskChangeControl();
  const cc = c.changeControl();

  const task = orch.create({ title: 'no-plan', description: 'd', status: 'ready', workspace: c.dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  const { change } = await tcc.bootstrapTask(task.id);
  // No submitPlan / acceptPlan — the Change stays DRAFT; the governance guard
  // must reject governed dispatch before any worker run.
  const dispatcher = tcc.createGovernedDispatcher({
    preflight: async () => ({ ok: true, spec: { mode: 'session', profile: 'wp', agentPreset: 'worker', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 5000, leaseSeconds: 300, name: 'worker' } }),
  });
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' });
  assert.equal(result.reason, 'dispatch_not_governed', 'governed dispatch rejected without accepted plan');
  assert.equal(orch.get(task.id).status, 'ready', 'task untouched after rejected dispatch');
});

test('T-H7: reviewer/planner cannot mutate the Change (role-bound denial)', async (t) => {
  const c = await compose(t);
  const orch = c.task();
  const tcc = c.taskChangeControl();
  const cc = c.changeControl();

  const task = orch.create({ title: 'roles', description: 'd', status: 'ready', workspace: c.dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  const { change } = await tcc.bootstrapTask(task.id);
  const plan = await cc.submitPlan(change.id, { steps: ['s'] });
  await cc.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  await cc.transition(change.id, 'IMPLEMENTING', { actor: 'host' });

  // Bind a session as reviewer and as planner.
  await cc.bindRole(change.id, 'sess-reviewer', 'reviewer');
  await cc.bindRole(change.id, 'sess-planner', 'planner');
  const claim = orch.claim(task.id, 'worker-roles', { lease_seconds: 300, actor: 'host' });
  assert.ok(claim.claimed);
  orch.start(task.id, 'worker-roles', { actor: 'host' });

  // A reviewer-bound session cannot submit proof (worker-only).
  await assert.rejects(
    () => cc.submitProof(change.id, workerProof('ccc111'), { sessionId: 'sess-reviewer', expectedWorker: 'worker-roles' }),
    (e) => e && (e.code === 'SESSION_NOT_BOUND' || e.code === 'SESSION_WORKER_MISMATCH'),
    'reviewer session cannot submit proof',
  );
  // A planner-bound session cannot submit proof either.
  await assert.rejects(
    () => cc.submitProof(change.id, workerProof('ccc111'), { sessionId: 'sess-planner', expectedWorker: 'worker-roles' }),
    (e) => e && e.code === 'SESSION_NOT_BOUND',
    'planner session cannot submit proof',
  );
  // The Change never advanced.
  assert.equal((await cc.get(change.id)).state, 'IMPLEMENTING', 'Change still IMPLEMENTING after denied mutations');
});

test('T-H7: task not done while Change non-APPROVED; duplicate completion does not dup proof/audit', async (t) => {
  const c = await compose(t);
  const orch = c.task();
  const tcc = c.taskChangeControl();
  const cc = c.changeControl();

  const task = orch.create({ title: 'idem', description: 'd', status: 'ready', workspace: c.dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  const { change } = await tcc.bootstrapTask(task.id);
  const plan = await cc.submitPlan(change.id, { steps: ['s'] });
  await cc.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });

  const worker = 'worker-idem';
  orch.claim(task.id, worker, { lease_seconds: 300, actor: 'host' });
  orch.start(task.id, worker, { actor: 'host' });
  await cc.bindRole(change.id, 'sess-idem', 'worker', { worker });

  const proof = workerProof('idem111');
  const res1 = await tcc.completeGovernedTask(task.id, { sessionId: 'sess-idem', worker, proof });
  assert.ok(res1.ok);
  assert.equal(orch.get(task.id).status, 'in_review');
  assert.equal((await cc.get(change.id)).state, 'PREFLIGHT');

  // The task is in_review (NOT done) while the Change is PREFLIGHT (non-APPROVED).
  assert.notEqual(orch.get(task.id).status, 'done', 'task not done before APPROVED');

  // Replayed completion with the SAME proof converges without duplicating.
  const res2 = await tcc.completeGovernedTask(task.id, { sessionId: 'sess-idem', worker, proof });
  assert.ok(res2.ok, 'idempotent replay converges');
  const toPreflight = (await cc.history(change.id)).filter((e) => e.to === 'PREFLIGHT');
  assert.equal(toPreflight.length, 1, 'PREFLIGHT transition recorded exactly once');
  const storedProof = (await cc.status(change.id)).proof;
  assert.ok(storedProof && storedProof.commit_sha === 'idem111', 'single persisted proof');

  // A REPLAY with a DIFFERENT proof is rejected (no silent overwrite/dup).
  await assert.rejects(
    () => tcc.completeGovernedTask(task.id, { sessionId: 'sess-idem', worker, proof: workerProof('idem222') }),
    (e) => e && e.code === 'PROOF_MISMATCH',
    'divergent replay rejected',
  );
});

test('T-H7: stale task projection cannot override authoritative Change-side workItem', async (t) => {
  const c = await compose(t);
  const orch = c.task();
  const tcc = c.taskChangeControl();
  const cc = c.changeControl();

  const task = orch.create({ title: 'projection', description: 'd', status: 'ready', workspace: c.dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  const { change } = await tcc.bootstrapTask(task.id);

  // Corrupt the denormalized task-side projection to point at a wrong change id.
  const stale = await orch.update(task.id, { metadata: { changeControl: { changeId: 'bogus-change-id' } } });
  assert.equal(stale.metadata.changeControl.changeId, 'bogus-change-id', 'projection corrupted');

  // The authoritative linkage still resolves through the Change-side workItem.
  const authoritative = await cc.findByWorkItem(WORK_ITEM_SYSTEM, task.id);
  assert.ok(authoritative, 'Change-side workItem still resolves');
  assert.equal(authoritative.id, change.id, 'authoritative change id');
  assert.notEqual(authoritative.id, 'bogus-change-id', 'stale projection ignored');
});

test('T-H7: negative — preflight fails closed on exhausted controller checks', async (t) => {
  const c = await compose(t);
  const orch = c.task();
  const tcc = c.taskChangeControl();
  const cc = c.changeControl();

  const task = orch.create({ title: 'pf-fail', description: 'd', status: 'ready', workspace: c.dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  const { change } = await tcc.bootstrapTask(task.id);
  const plan = await cc.submitPlan(change.id, { steps: ['s'] });
  await cc.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });

  const worker = 'worker-pf';
  orch.claim(task.id, worker, { lease_seconds: 300, actor: 'host' });
  orch.start(task.id, worker, { actor: 'host' });
  await cc.bindRole(change.id, 'sess-pf', 'worker', { worker });
  await tcc.completeGovernedTask(task.id, { sessionId: 'sess-pf', worker, proof: workerProof('pf111') });

  const out = await tcc.runGovernedSdlc(task.id, { controllerPreflightOverride: ['FAIL:build'] });
  assert.equal(out.outcome, 'preflight_failed', 'exhausted controller check fails closed');
  assert.equal((await cc.get(change.id)).state, 'PREFLIGHT', 'Change stays PREFLIGHT');
  assert.equal(orch.get(task.id).status, 'in_review', 'task stays in_review');
});

// ─── Test — model-facing tool surface: no self-binding, unauthorized bind ──

test('T-H7: composed production ToolRuntime has no change_bind/change_create tool; unbound/wrong-role sessions cannot mutate', async (t) => {
  const c = await compose(t);
  const orch = c.task();
  const tcc = c.taskChangeControl();
  const cc = c.changeControl();
  const ctx = c.ctx;

  // Enumerate the REAL composed ToolRuntime (system-prompt/task/change/...).
  const knownNames = [...ctx.tools.view().knownNames];
  const forbidden = knownNames.filter((n) => /^change_(bind|unbind|create|transition|set_state|set_role|grant)/.test(n));
  assert.deepEqual(forbidden, [], `self-binding/role-granting tools must not be registered: ${forbidden.join(', ')}`);
  // The canonical role-gated surface is present and gated (not self-service).
  assert.ok(knownNames.includes('change_submit_proof'), 'worker mutation tool present (role-gated)');

  // Set up a governed Change in IMPLEMENTING (the worker-mutation state), so
  // the ONLY thing blocking a mutation is identity/role authorization.
  const task = orch.create({ title: 'no-self-bind', description: 'd', status: 'ready', workspace: c.dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  const { change } = await tcc.bootstrapTask(task.id);
  const plan = await cc.submitPlan(change.id, { steps: ['s'] });
  await cc.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  await cc.transition(change.id, 'IMPLEMENTING', { actor: 'host' });

  const tool = ctx.tools.view().visible.get('change_submit_proof');
  assert.ok(tool, 'change_submit_proof tool registered');
  const errCode = (code) => (e) => e?.code === code || e?.reason === code;

  // An UNBOUND model session (no controller-issued role binding) is denied:
  // roles come only from the controller-side bindRole, never from the model.
  await assert.rejects(
    tool.execute({ changeId: change.id, proof: JSON.stringify(workerProof('x1')) }, { agent: { id: 'unbound-model-session' } }),
    errCode('SESSION_NOT_BOUND'),
    'unbound model session cannot submit proof (no self-service binding)',
  );

  // A session bound to the WRONG role (planner) is still denied for the
  // worker-only mutation — role separation cannot be bypassed.
  await cc.bindRole(change.id, 'planner-session', 'planner');
  await assert.rejects(
    tool.execute({ changeId: change.id, proof: JSON.stringify(workerProof('x2')) }, { agent: { id: 'planner-session' } }),
    (e) => errCode('ROLE_NOT_ALLOWED')(e) || errCode('SESSION_NOT_BOUND')(e),
    'planner-role session cannot submit proof',
  );

  // No mutation leaked: the Change is still IMPLEMENTING with no proof.
  assert.equal((await cc.get(change.id)).state, 'IMPLEMENTING', 'Change still IMPLEMENTING after denied mutations');
  assert.equal((await cc.status(change.id)).proof, null, 'no proof persisted from denied mutations');
});