// T-H11 RED regressions — reviewer settlement must wake the governed SDLC.
//
// Today runGovernedSdlc launches+binds an independent reviewer and returns
// review_pending. The reviewer's structured change_submit_review persists
// REVIEW→APPROVED|REPAIR, but nothing wakes the controller afterward: the
// task side only converges when a host/external caller re-invokes
// runGovernedSdlc(taskId, { verdict }). These tests drive the REAL
// change_submit_review tool against REAL stores/plugins (no verdict
// injection) and assert automatic PASS/FAIL convergence, idempotent
// duplicate delivery, fail-closed identity/stale/missing-review boundaries,
// and restart recovery from the persisted post-review crash window.
//
// H11 event contract under test (native Cordis convention — the leading
// carrier object becomes listener `this`, so the payload stays an argument):
//   ctx.events.parallel(carrier, 'change-control/review-settled',
//     { changeId, reviewId, verdict, revision, sessionId })
// emitted AFTER the authoritative Change review transition is durably
// persisted. The integration subscriber re-reads persisted Task/Change state
// and converges with no model-supplied verdict. Durable state, not the
// in-memory event, is the restart recovery source.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as taskOrchestratorPlugin from 'dsh-task-orchestrator';
import changeControlPlugin from 'dsh-change-control';
import integrationPlugin from '../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REVIEW_SETTLED_EVENT = 'change-control/review-settled';

// Deterministic stand-in for the host session server (same seam the real
// createWorkerLauncher/createReviewerLauncher poll via globalThis.fetch).
function createSessionRpc(proof) {
  const sessions = new Map();
  let counter = 0;
  const createdSessionIds = [];
  const respond = (value) => ({
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: true, value } }),
  });
  const completedEvents = () => proof === null
    ? [
        { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
        { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ]
    : [
        { seq: 1, type: 'turn/start', data: { turn: 1 } },
        { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'worker-complete-1', name: 'worker_complete', arguments: '{}' } },
        { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'worker-complete-1', content: [{ type: 'text', text: 'completed' }], isError: false }] }, meta: proof } },
        { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ];
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init?.body ?? '{}');
    const sessionId = body.payload?.sessionId;
    if (method === 'session.create') {
      const sid = `sess-${++counter}`;
      sessions.set(sid, { historyCalls: 0 });
      createdSessionIds.push(sid);
      return respond({ sessionId: sid });
    }
    if (method === 'session.selectModel' || method === 'session.prompt' || method === 'session.cancel') return respond({});
    if (method === 'session.history') {
      const s = sessions.get(sessionId) ?? { historyCalls: 0 };
      s.historyCalls += 1;
      sessions.set(sessionId, s);
      if (s.historyCalls === 1) return respond({ events: [] });
      return respond({ events: completedEvents() });
    }
    return respond({});
  };
  return { fetchImpl, createdSessionIds };
}

function workerProof() {
  return {
    protocol: 'dsh.worker-completion.v1',
    beforeRevision: 'main@baseline',
    afterRevision: 'abc123',
    commit_sha: 'abc123',
    files_changed: ['src/x.js'],
    tests_run: ['test/x.test.mjs'],
    remaining_blockers: [],
    criteria: [{ id: 'ship', satisfied: true }],
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

async function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not reached before timeout${lastError ? `: ${lastError.message}` : ''}`);
}

/** Full production composition: all three real plugins, real stores. */
async function compose(t) {
  const dir = mkdtempSync(join(tmpdir(), 'h11-wake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const taskDbPath = join(dir, 'tasks.db');
  const changesJsonPath = join(dir, 'changes.json');

  const rpc = createSessionRpc(workerProof());
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
        mode: 'session', profile: 'wp', agentPreset: 'worker',
        provider: 'ollama', model: 'm', workspacePolicy: 'any',
        timeoutMs: 5000, leaseSeconds: 300,
      },
    },
  });
  await ctx.plugin(changeControlPlugin, { storePath: changesJsonPath });
  await ctx.plugin(integrationPlugin);

  return { ctx, dir, taskDbPath, changesJsonPath, rpc };
}

/** Change Control only (no integration subscriber): emulates a dead host
 * process persisting the review after the crash window opened. */
async function composeChangeOnly(t, paths) {
  const ctx = new Context();
  t.after(() => ctx.dispose?.());
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(changeControlPlugin, { storePath: paths.changesJsonPath });
  return ctx;
}

/** Fresh full production composition over the SAME durable files (restart). */
async function reopen(t, paths) {
  const ctx = new Context();
  t.after(() => ctx.dispose?.());
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, {});
  ctx.provide('webServer', { register() { return () => {}; } });
  await ctx.plugin(taskOrchestratorPluginObject, {
    dbPath: paths.taskDbPath,
    workerSpecs: {
      worker: {
        mode: 'session', profile: 'wp', agentPreset: 'worker',
        provider: 'ollama', model: 'm', workspacePolicy: 'any',
        timeoutMs: 5000, leaseSeconds: 300,
      },
    },
  });
  await ctx.plugin(changeControlPlugin, { storePath: paths.changesJsonPath });
  await ctx.plugin(integrationPlugin);
  return {
    ctx,
    orch: ctx.get('taskOrchestrator'),
    cc: ctx.get('changeControl'),
    tcc: ctx.get('taskChangeControl'),
  };
}

/** Drive a governed task through real dispatch to REVIEW + bound reviewer. */
async function governedReviewPending(c) {
  const orch = c.ctx.get('taskOrchestrator');
  const tcc = c.ctx.get('taskChangeControl');
  const cc = c.ctx.get('changeControl');
  const task = orch.create({
    title: 'h11', description: 'd', status: 'ready', workspace: c.dir,
    worker_profile: 'worker', acceptance_criteria: ['ship'],
  });
  const { change } = await tcc.bootstrapTask(task.id);
  const plan = await cc.submitPlan(change.id, { steps: ['s'] });
  await cc.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  const dispatcher = tcc.createGovernedDispatcher({
    preflight: async () => ({ ok: true, spec: { mode: 'session', profile: 'wp', agentPreset: 'worker', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 5000, leaseSeconds: 300, name: 'worker' } }),
  });
  const dispatched = await dispatcher.dispatchOnce({ workerProfile: 'worker' });
  assert.equal(dispatched.status, 'in_review');
  assert.equal(dispatched.task.sdlc.outcome, 'review_pending');
  const reviewerSession = dispatched.task.sdlc.sessionId;
  const reviewTool = c.ctx.tools.view().visible.get('change_submit_review');
  return { task, change, orch, cc, tcc, reviewerSession, reviewTool, workerSession: c.rpc.createdSessionIds[0] };
}

const failFindings = [{
  severity: 'critical', category: 'test', location: 'src/x.js',
  problem: 'missing guard', requiredOutcome: 'fix and re-test',
}];

test('T-H11: PASS review through change_submit_review auto-converges APPROVED + done without a verdict re-invocation', async (t) => {
  const c = await compose(t);
  const { task, change, orch, cc, reviewerSession, reviewTool } = await governedReviewPending(c);

  const settlements = [];
  c.ctx.events.on(REVIEW_SETTLED_EVENT, (payload) => settlements.push(payload));

  const result = await reviewTool.execute(
    { changeId: change.id, review: { verdict: 'pass', revision: 'abc123', findings: [] } },
    { agent: { id: reviewerSession } },
  );
  assert.equal(result.state, 'APPROVED');

  // The durable transition must emit one narrow native Cordis lifecycle event.
  await waitFor(() => settlements.length === 1
    && settlements[0].changeId === change.id
    && settlements[0].verdict === 'pass');

  // The integration subscriber must wake the controller with NO model-supplied
  // verdict and converge the task automatically.
  await waitFor(() => orch.get(task.id).status === 'done');
  assert.equal((await cc.get(change.id)).state, 'APPROVED');
  assert.equal(orch.get(task.id).status, 'done', 'task must converge without runGovernedSdlc({verdict})');
  const history = await cc.history(change.id);
  assert.equal(history.filter((e) => e.to === 'APPROVED').length, 1, 'single APPROVED transition');
});

test('T-H11: FAIL review through change_submit_review auto-converges REPAIR + task changes_requested and routes repair', async (t) => {
  const c = await compose(t);
  const { task, change, orch, cc, reviewerSession, reviewTool } = await governedReviewPending(c);

  const result = await reviewTool.execute(
    { changeId: change.id, review: { verdict: 'fail', revision: 'abc123', findings: failFindings } },
    { agent: { id: reviewerSession } },
  );
  assert.equal(result.state, 'REPAIR');

  // The woken controller settles the task side (in_review →
  // changes_requested → repair routing begins) with NO model-supplied
  // verdict. The durable settlement audit is the stable convergence signal
  // regardless of how far repair routing proceeds in this wired composition.
  await waitFor(async () => {
    const history = await cc.history(change.id);
    return history.some((e) => e.kind === 'review_orchestration' && e.action === 'review_fail_settled');
  });
  const status = await cc.status(change.id);
  assert.equal(status.openFindings.length, 1, 'authoritative finding preserved');
});

test('T-H11: duplicate/concurrent PASS wake-ups converge exactly once', async (t) => {
  const c = await compose(t);
  const { task, change, orch, cc, reviewerSession, reviewTool } = await governedReviewPending(c);

  const settlements = [];
  c.ctx.events.on(REVIEW_SETTLED_EVENT, (payload) => settlements.push(payload));

  await reviewTool.execute(
    { changeId: change.id, review: { verdict: 'pass', revision: 'abc123', findings: [] } },
    { agent: { id: reviewerSession } },
  );
  await waitFor(() => orch.get(task.id).status === 'done');
  const payload = settlements[0];

  // Three duplicate/concurrent deliveries of the same durable settlement
  // (native Cordis dispatch: carrier object, event name, payload argument).
  await Promise.all([
    c.ctx.events.parallel({}, REVIEW_SETTLED_EVENT, payload),
    c.ctx.events.parallel({}, REVIEW_SETTLED_EVENT, payload),
    c.ctx.events.parallel({}, REVIEW_SETTLED_EVENT, payload),
  ]);

  assert.equal(orch.get(task.id).status, 'done');
  const history = await cc.history(change.id);
  assert.equal(history.filter((e) => e.to === 'APPROVED').length, 1, 'no duplicate APPROVED transition');
  assert.equal(
    history.filter((e) => e.kind === 'review_orchestration' && /^review_pass/.test(e.action ?? '')).length,
    1,
    'PASS convergence audited exactly once',
  );
});

test('T-H11: duplicate FAIL wake-ups settle and route the repair exactly once', async (t) => {
  const c = await compose(t);
  const { task, change, orch, cc, reviewerSession, reviewTool } = await governedReviewPending(c);

  const settlements = [];
  c.ctx.events.on(REVIEW_SETTLED_EVENT, (payload) => settlements.push(payload));

  await reviewTool.execute(
    { changeId: change.id, review: { verdict: 'fail', revision: 'abc123', findings: failFindings } },
    { agent: { id: reviewerSession } },
  );
  await waitFor(async () => {
    const history = await cc.history(change.id);
    return history.some((e) => e.kind === 'review_orchestration' && e.action === 'review_fail_settled');
  });
  const payload = settlements[0];

  await Promise.all([
    c.ctx.events.parallel({}, REVIEW_SETTLED_EVENT, payload),
    c.ctx.events.parallel({}, REVIEW_SETTLED_EVENT, payload),
  ]);

  const history = await cc.history(change.id);
  assert.equal(
    history.filter((e) => e.kind === 'review_orchestration' && e.action === 'review_fail_settled').length,
    1,
    'FAIL settlement audited exactly once',
  );
  const status = await cc.status(change.id);
  assert.equal(status.openFindings.length, 1, 'no duplicated findings');
});

test('T-H11: reviewer session that exits without a structured review stays fail-closed', async (t) => {
  const c = await compose(t);
  const { task, change, orch, cc } = await governedReviewPending(c);

  // The reviewer session terminates (deterministic host serves turn/end) but
  // never calls change_submit_review. Wait long enough for any wake path that
  // wrongly infers a verdict from process exit.
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(orch.get(task.id).status, 'in_review', 'no PASS inferred from reviewer exit');
  assert.equal((await cc.get(change.id)).state, 'REVIEW');
  const history = await cc.history(change.id);
  assert.ok(
    !history.some((e) => e.kind === 'review_orchestration' && e.action === 'review_pass_converged'),
    'no convergence audit without a structured review',
  );
});

test('T-H11: stale revision and already-advanced review are rejected by the real seam', async (t) => {
  const c = await compose(t);
  const { change, cc, reviewerSession, reviewTool } = await governedReviewPending(c);

  await assert.rejects(
    reviewTool.execute(
      { changeId: change.id, review: { verdict: 'fail', revision: 'stale-rev', findings: failFindings } },
      { agent: { id: reviewerSession } },
    ),
    (e) => e?.code === 'STALE_REVISION',
    'stale review revision is rejected',
  );

  await reviewTool.execute(
    { changeId: change.id, review: { verdict: 'pass', revision: 'abc123', findings: [] } },
    { agent: { id: reviewerSession } },
  );
  await waitFor(() => cc.get(change.id).then((x) => x.state === 'APPROVED'));

  // A late/duplicate structured result after the Change advanced is rejected.
  await assert.rejects(
    reviewTool.execute(
      { changeId: change.id, review: { verdict: 'fail', revision: 'abc123', findings: failFindings } },
      { agent: { id: reviewerSession } },
    ),
    (e) => e?.code === 'INVALID_CHANGE_STATE' || e?.code === 'INVALID_STATE',
    'review after advancement is rejected',
  );
});

test('T-H11: unbound and wrong-role sessions cannot settle a review', async (t) => {
  const c = await compose(t);
  const { task, change, orch, cc, reviewTool } = await governedReviewPending(c);

  await assert.rejects(
    reviewTool.execute(
      { changeId: change.id, review: { verdict: 'pass', revision: 'abc123', findings: [] } },
      { agent: { id: 'session-that-does-not-exist' } },
    ),
    // deriveIdentity rejects with a raw AuthorizationError (.reason); the
    // ChangeService path shapes it to .code — accept either.
    (e) => e?.code === 'SESSION_NOT_BOUND' || e?.reason === 'SESSION_NOT_BOUND',
    'unbound session cannot review',
  );
  // A session bound in a non-reviewer role (the dispatched worker binding is
  // released on completion, so bind a live planner session) is denied.
  await cc.bindRole(change.id, 'sess-planner-h11', 'planner');
  await assert.rejects(
    reviewTool.execute(
      { changeId: change.id, review: { verdict: 'pass', revision: 'abc123', findings: [] } },
      { agent: { id: 'sess-planner-h11' } },
    ),
    (e) => e?.code === 'ROLE_NOT_ALLOWED' || e?.reason === 'ROLE_NOT_ALLOWED',
    'planner-role session cannot review',
  );
  assert.equal(orch.get(task.id).status, 'in_review');
  assert.equal((await cc.get(change.id)).state, 'REVIEW');
});

test('T-H11: restart recovers a persisted PASS before task convergence', async (t) => {
  const c = await compose(t);
  const paths = { taskDbPath: c.taskDbPath, changesJsonPath: c.changesJsonPath };
  const { task, change, orch, cc, reviewerSession } = await governedReviewPending(c);

  // Simulate a crash AFTER durable review persistence but BEFORE the
  // controller converged the task: submit from a change-control-only host
  // with no integration subscriber, then dispose the original host.
  const changeOnly = await composeChangeOnly(t, paths);
  const tool = changeOnly.tools.view().visible.get('change_submit_review');
  await tool.execute(
    { changeId: change.id, review: { verdict: 'pass', revision: 'abc123', findings: [] } },
    { agent: { id: reviewerSession } },
  );
  assert.equal((await changeOnly.get('changeControl').get(change.id)).state, 'APPROVED');
  assert.equal(orch.get(task.id).status, 'in_review', 'crash window: task not yet converged');
  // (The original host's in-memory subscriber never saw the changeOnly
  // Context's event — a separate Cordis bus — so the task stays unconverged.)

  // Fresh host startup over the same durable files must recover with no
  // manual verdict invocation.
  const restarted = await reopen(t, paths);
  await waitFor(() => restarted.orch.get(task.id).status === 'done');
  assert.equal((await restarted.cc.get(change.id)).state, 'APPROVED');
});

test('T-H11: restart recovers a persisted FAIL and resumes repair routing', async (t) => {
  const c = await compose(t);
  const paths = { taskDbPath: c.taskDbPath, changesJsonPath: c.changesJsonPath };
  const { task, change, orch, cc, reviewerSession } = await governedReviewPending(c);

  const changeOnly = await composeChangeOnly(t, paths);
  const tool = changeOnly.tools.view().visible.get('change_submit_review');
  await tool.execute(
    { changeId: change.id, review: { verdict: 'fail', revision: 'abc123', findings: failFindings } },
    { agent: { id: reviewerSession } },
  );
  assert.equal((await changeOnly.get('changeControl').get(change.id)).state, 'REPAIR');
  assert.equal(orch.get(task.id).status, 'in_review', 'crash window: task not yet settled');
  // (The original host's in-memory subscriber never saw the changeOnly
  // Context's event — a separate Cordis bus — so the task stays unsettled.)

  const restarted = await reopen(t, paths);
  // Startup recovery must observe the persisted REPAIR state and settle the
  // task side (audited) without a manual verdict invocation.
  await waitFor(async () => {
    const history = await restarted.cc.history(change.id);
    return history.some((e) => e.kind === 'review_orchestration' && e.action === 'review_fail_settled');
  });
  const status = await restarted.cc.status(change.id);
  assert.equal(status.openFindings.length, 1, 'finding survives into recovery');
});
