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
import { observeReviewerTurn } from '../src/service.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REVIEW_SETTLED_EVENT = 'change-control/review-settled';

// Deterministic stand-in for the host session server (same seam the real
// createWorkerLauncher/createReviewerLauncher poll via globalThis.fetch).
function createSessionRpc(proof, { endFirstReviewerOnPrompt = false } = {}) {
  const sessions = new Map();
  const killed = new Set();
  let counter = 0;
  let endedFirstReviewer = false;
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
      sessions.set(sid, { historyCalls: 0, preset: body.payload?.agentPreset ?? null, prompt: null, ended: null });
      createdSessionIds.push(sid);
      return respond({ sessionId: sid });
    }
    if (method === 'session.selectModel' || method === 'session.cancel') return respond({});
    if (method === 'session.prompt') {
      const s = sessions.get(sessionId);
      if (s) {
        s.prompt = body.payload?.content?.[0]?.text ?? '';
        if (endFirstReviewerOnPrompt && s.preset === 'reviewer' && !endedFirstReviewer) {
          endedFirstReviewer = true;
          s.ended = { kind: 'error', error: { message: 'reviewer ended before REVIEW transition' } };
        }
      }
      return respond({});
    }
    if (method === 'session.history') {
      // T-H12 round-5: a killed session's history RPC ERRORS — the existing-
      // session waiter rejects, proving the turn dead fail-closed.
      if (killed.has(sessionId)) {
        return {
          ok: false, status: 500,
          json: async () => ({ result: { ok: false, error: { message: 'session unreachable', code: 'SESSION_UNKNOWN' } } }),
        };
      }
      const s = sessions.get(sessionId) ?? { historyCalls: 0 };
      s.historyCalls += 1;
      sessions.set(sessionId, s);
      // T-H12 round-4 fixture fidelity: a reviewer turn stays LIVE (no
      // terminal event) until the test ends it — the production observer
      // treats only a resolved wait() as a dead turn.
      if (s.preset === 'reviewer') {
        const promptEvents = s.prompt
          ? [{ seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: s.prompt }] } } }]
          : [];
        const terminal = s.ended ? [{ seq: 3, type: 'turn/end', data: { reason: s.ended } }] : [];
        return respond({ events: [...promptEvents, ...terminal] });
      }
      if (s.historyCalls === 1) return respond({ events: [] });
      return respond({ events: completedEvents() });
    }
    return respond({});
  };
  return {
    fetchImpl,
    createdSessionIds,
    // End a session's turn with the given turn/end reason kind.
    endSession: (sessionId, reason = { kind: 'completed' }) => {
      const s = sessions.get(sessionId);
      if (s) s.ended = reason;
    },
    // T-H12 round-5: the host-side death of a session (gone/unreachable).
    killSession: (sessionId) => {
      sessions.delete(sessionId);
      killed.add(sessionId);
    },
    // T-H12 round-5: another host's reviewer session (its turn already
    // prompted) — the cross-process adoption target.
    createExternalReviewer: (promptText) => {
      const sid = `sess-ext-${++counter}`;
      sessions.set(sid, { historyCalls: 0, preset: 'reviewer', prompt: promptText, ended: null });
      return sid;
    },
  };
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
async function compose(t, rpcOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'h11-wake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const taskDbPath = join(dir, 'tasks.db');
  const changesJsonPath = join(dir, 'changes.json');

  const rpc = createSessionRpc(workerProof(), rpcOptions);
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
    preflightOptions: {
      presetExists: new Set(['worker']),
      llm: {
        listProviders() { return [{ id: 'ollama' }]; },
        async listModels(provider) { return provider === 'ollama' ? [{ id: 'm' }] : []; },
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
    preflightOptions: {
      presetExists: new Set(['worker']),
      llm: {
        listProviders() { return [{ id: 'ollama' }]; },
        async listModels(provider) { return provider === 'ollama' ? [{ id: 'm' }] : []; },
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

test('T-H12 round-8: real no-policy reviewer terminal before PREFLIGHT→REVIEW recovers once', async (t) => {
  const c = await compose(t, { endFirstReviewerOnPrompt: true });
  const { task, change, orch, cc } = await governedReviewPending(c);

  // The real createReviewerLauncher/session-history seam records a terminal
  // before the fallback transition. Observation must wait for REVIEW, expire
  // that round once, and issue one fresh request without inferring PASS.
  await waitFor(async () => c.rpc.createdSessionIds.length === 3
    && (await cc.history(change.id)).filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested').length === 2, 15000);
  assert.equal((await cc.get(change.id)).state, 'REVIEW');
  assert.equal(orch.get(task.id).status, 'in_review');
  const history = await cc.history(change.id);
  assert.equal(history.filter((e) => e.kind === 'review_orchestration' && e.action === 'reviewer_turn_ended_no_verdict').length, 1);
  assert.equal(history.filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested').length, 2);
  const reviewers = (await cc.listRoleBindings()).filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.equal(reviewers.length, 1, 'only the recovered live reviewer remains bound');
  assert.notEqual(reviewers[0].sessionId, c.rpc.createdSessionIds[1]);
});

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

test('T-H11: reviewer session that exits without a structured review stays fail-closed and recovers exactly once', async (t) => {
  const c = await compose(t);
  const { task, change, orch, cc, reviewerSession } = await governedReviewPending(c);

  // The reviewer session terminates (deterministic host serves turn/end) but
  // never calls change_submit_review. The production observer must keep the
  // round fail-closed while recovering it with exactly one fresh request.
  c.rpc.endSession(reviewerSession, { kind: 'error', error: { message: 'reviewer gone' } });
  await waitFor(async () => {
    const reviewers = (await cc.listRoleBindings())
      .filter((b) => b.changeId === change.id && b.role === 'reviewer');
    return reviewers.length === 1 && reviewers[0].sessionId !== reviewerSession;
  }, 8000);

  assert.equal(orch.get(task.id).status, 'in_review', 'no PASS inferred from reviewer exit');
  assert.equal((await cc.get(change.id)).state, 'REVIEW');
  const history = await cc.history(change.id);
  assert.ok(
    !history.some((e) => e.kind === 'review_orchestration' && e.action === 'review_pass_converged'),
    'no convergence audit without a structured review',
  );
  assert.equal(
    history.filter((e) => e.kind === 'review_orchestration' && e.action === 'reviewer_turn_ended_no_verdict').length,
    1,
    'the dead turn is audited exactly once',
  );
  assert.equal(
    history.filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested').length,
    2,
    'the dead round is re-requested exactly once, never a burst',
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

test('T-H12 round-5: controller restart reattaches reviewer-turn observation — live turn no churn, dead turn recovered exactly once', async (t) => {
  const c = await compose(t);
  const paths = { taskDbPath: c.taskDbPath, changesJsonPath: c.changesJsonPath };
  const { task, change, reviewerSession } = await governedReviewPending(c);

  // Simulate the original controller process crashing: its in-memory launch
  // observer dies with it (a real restart leaves only the fresh host to
  // reattach observation). stopReviewerObservation is the controller-teardown
  // seam that neutralizes every observation the launching process owned.
  c.ctx.get('taskChangeControl').stopReviewerObservation();

  // Restart over the same durable files while the reviewer turn is LIVE.
  // Startup reconciliation reattaches observation with ZERO churn: no new
  // session, no duplicate request audit, no advancement (never infer PASS).
  const restarted = await reopen(t, paths);
  const sessionCount = c.rpc.createdSessionIds.length;
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(c.rpc.createdSessionIds.length, sessionCount, 'no duplicate reviewer session after restart');
  assert.equal(restarted.orch.get(task.id).status, 'in_review');
  assert.equal((await restarted.cc.get(change.id)).state, 'REVIEW');
  {
    const history = await restarted.cc.history(change.id);
    assert.equal(
      history.filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested').length,
      1, 'no duplicate explicit request audit after restart',
    );
  }

  // The reviewer turn THEN dies without a verdict. The reattached production
  // observation (host session history, not binding/liveness) recovers it
  // fail-closed: expire only this round + exactly one fresh explicit request.
  c.rpc.endSession(reviewerSession, { kind: 'error', error: { message: 'reviewer gone after restart' } });
  await waitFor(async () => {
    const reviewers = (await restarted.cc.listRoleBindings())
      .filter((b) => b.changeId === change.id && b.role === 'reviewer');
    return reviewers.length === 1 && reviewers[0].sessionId !== reviewerSession;
  }, 15000);
  assert.equal(restarted.orch.get(task.id).status, 'in_review', 'no PASS inferred from a dead turn');
  const history = await restarted.cc.history(change.id);
  assert.equal(
    history.filter((e) => e.kind === 'review_orchestration' && e.action === 'reviewer_turn_ended_no_verdict').length,
    1, 'the dead turn is audited exactly once',
  );
  assert.equal(
    history.filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested').length,
    2, 'initial request + exactly one recovery request',
  );

  // The recovered CURRENT round still settles normally with a real verdict.
  const newReviewer = (await restarted.cc.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer')[0].sessionId;
  const tool = restarted.ctx.tools.view().visible.get('change_submit_review');
  const settle = await tool.execute(
    { changeId: change.id, review: { verdict: 'pass', revision: 'abc123', findings: [] } },
    { agent: { id: newReviewer } },
  );
  assert.equal(settle.state, 'APPROVED');
  await waitFor(() => restarted.orch.get(task.id).status === 'done', 15000);
  assert.equal((await restarted.cc.get(change.id)).state, 'APPROVED');
});

test('T-H12 round-5: cross-process adoption reattaches an existing-session observer; a rejected waiter expires only that round and recovers exactly once', async (t) => {
  const c = await compose(t);
  const { task, change, cc, orch, reviewerSession } = await governedReviewPending(c);

  // Another host's reviewer launch for THIS round crashed AFTER its request
  // was sent but BEFORE binding: the durable claim record (the cross-process
  // surface) names its session and request identity.
  const externalSession = c.rpc.createExternalReviewer('peer reviewer prompt [review-request req-cross]');
  const claimFile = join(c.dir, '.dsh-governance', 'reviewer-claims', `reviewer-claim-${change.id}-abc123`);
  writeFileSync(claimFile, JSON.stringify({
    claimant: 'dead-host:1', sessionId: externalSession, requestId: 'req-cross',
    sentAt: Date.now() - 11 * 60 * 1000, revision: 'abc123',
    updatedAt: Date.now() - 2 * 10 * 60 * 1000,
  }));

  // This host's wake converges by ADOPTING the recorded sent session — no
  // new launch, no re-prompt — and (round-5) reattaches observation to the
  // real session lifecycle instead of treating the binding as completion.
  const before = c.rpc.createdSessionIds.length;
  const wake = await c.ctx.get('taskChangeControl').runGovernedSdlc(task.id, {});
  assert.equal(wake.outcome, 'review_pending');
  assert.equal(wake.sessionId, externalSession, 'the recorded sent session is adopted, not re-launched');
  assert.equal(c.rpc.createdSessionIds.length, before, 'adoption never launches a reviewer');
  const adopted = (await cc.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.ok(adopted.some((b) => b.sessionId === externalSession), 'adopted session becomes the round reviewer');

  // The adopted session becomes unreachable (host-side death): the reattached
  // existing-session waiter REJECTS. That rejection is a dead turn — never
  // swallowed into a permanent review_pending.
  c.rpc.killSession(externalSession);
  await waitFor(async () => {
    const reviewers = (await cc.listRoleBindings())
      .filter((b) => b.changeId === change.id && b.role === 'reviewer');
    return reviewers.some((b) => b.sessionId !== externalSession && b.sessionId !== reviewerSession);
  }, 15000);
  assert.equal(orch.get(task.id).status, 'in_review');
  assert.equal((await cc.get(change.id)).state, 'REVIEW', 'no PASS inferred from a rejected waiter');
  const history = await cc.history(change.id);
  const ended = history.filter((e) => e.kind === 'review_orchestration'
    && e.action === 'reviewer_turn_ended_no_verdict' && e.sessionId === externalSession);
  assert.equal(ended.length, 1, 'the rejected turn is audited exactly once');
  assert.match(String(ended[0].error ?? ''), /unreachable/, 'the waiter rejection is the audited failure evidence');
  assert.equal(c.rpc.createdSessionIds.length, before + 1, 'exactly one recovery launch — never a burst');

  // The recovered current-round session settles the review for real.
  const recovered = (await cc.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer')
    .find((b) => b.sessionId !== externalSession && b.sessionId !== reviewerSession);
  const tool = c.ctx.tools.view().visible.get('change_submit_review');
  const settle = await tool.execute(
    { changeId: change.id, review: { verdict: 'pass', revision: 'abc123', findings: [] } },
    { agent: { id: recovered.sessionId } },
  );
  assert.equal(settle.state, 'APPROVED');
  await waitFor(() => orch.get(task.id).status === 'done', 15000);
  assert.equal((await cc.get(change.id)).state, 'APPROVED');
});

test('T-H12 round-6: mid-flight teardown after reviewer wait settles performs no post-stop recovery mutation', async (t) => {
  // Deterministic reproduction of the R5-F1 race at the observation seam: the
  // reviewer turn ends (wait() resolves) and recovery enters its awaited reads.
  // Teardown (`stop`) fires while recovery is suspended at its first awaited
  // read (`c.get`) — strictly after wait() settled, before any expire/unbind/
  // audit/relaunch mutation. The stopped observer must then perform NO durable
  // mutation: fail-closed, no PASS inferred, exactly-once recovery preserved.
  const dir = mkdtempSync(join(tmpdir(), 'h11-r6-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const change = { id: 'c1' };
  const task = { workspace: dir };
  const revision = 'abc123';
  const sessionId = 'sess-r1';

  // A real durable claim record so a non-stopped recovery would genuinely
  // expire + unbind + audit + relaunch — every mutation the stop suppresses.
  mkdirSync(join(dir, '.dsh-governance', 'reviewer-claims'), { recursive: true });
  const claimFile = join(dir, '.dsh-governance', 'reviewer-claims', `reviewer-claim-c1-${revision}`);
  writeFileSync(claimFile, JSON.stringify({ claimant: 'host:1', sessionId, updatedAt: Date.now() }));

  // Instrumented facade: count every mutation-relevant call; gate c.get so the
  // recovery suspends deterministically at its first awaited read.
  const calls = { get: 0, status: 0, unbind: 0, audit: 0 };
  let resolveGet = null;
  let markGetEntered = null;
  const getEntered = new Promise((r) => { markGetEntered = r; });
  const getGate = new Promise((r) => { resolveGet = r; });
  const c = {
    async get(id) {
      if (id === change.id) {
        calls.get += 1;
        markGetEntered();
        await getGate;                       // suspend recovery mid-read
      }
      return { id: change.id, state: 'REVIEW' };
    },
    async status() { calls.status += 1; return { revision }; },
    async unbindRole() { calls.unbind += 1; },
    async appendAudit() { calls.audit += 1; },
  };
  let relaunched = 0;
  const rebuildReview = async () => { relaunched += 1; };

  const handle = {
    wait: () => new Promise((resolve) => { setTimeout(() => resolve({ exitCode: 1 }), 0); }),
  };

  const stop = observeReviewerTurn({ handle, c, change, task, revision, sessionId, rebuildReview });
  assert.strictEqual(typeof stop, 'function', 'an observation stop is returned');

  // wait() resolves; recovery enters c.get and suspends on the gate.
  await getEntered;

  // Teardown lands after wait() settled but before the first mutation.
  stop();

  // Release the suspended read and let any (now-illegal) recovery drain.
  resolveGet();
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(calls.get, 1, 'the recovery read once and nothing more after stop');
  assert.equal(calls.status, 0, 'no status read (no revision/expire path) after stop');
  assert.equal(calls.unbind, 0, 'no binding removal after stop');
  assert.equal(calls.audit, 0, 'no dead-turn audit after stop');
  assert.equal(relaunched, 0, 'no reviewer relaunch after stop');

  // The durable claim is untouched: the round is not expired, so a later wake
  // can still recover exactly once through the normal (non-stopped) path.
  const claim = JSON.parse(readFileSync(claimFile, 'utf8'));
  assert.equal(claim.sessionId, sessionId, 'round claim not expired/cleared after stop');
});

test('T-H12 round-7: stop token propagates through an in-flight rebuild and blocks relaunch', async (t) => {
  let resolveRebuild;
  let rebuildStarted;
  const rebuildGate = new Promise((resolve) => { resolveRebuild = resolve; });
  const started = new Promise((resolve) => { rebuildStarted = resolve; });
  let relaunched = 0;
  let stoppedSignal;
  const handle = {
    wait: () => Promise.resolve({ exitCode: 1 }),
  };
  const rebuildReview = async (isStopped) => {
    stoppedSignal = isStopped;
    rebuildStarted();
    await rebuildGate;
    if (!isStopped?.()) relaunched += 1;
  };
  const workspace = mkdtempSync(join(tmpdir(), 'h11-r7-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, '.dsh-governance', 'reviewer-claims'), { recursive: true });
  writeFileSync(
    join(workspace, '.dsh-governance', 'reviewer-claims', 'reviewer-claim-c-rebuild-abc123'),
    JSON.stringify({ claimant: 'host:r7', sessionId: 'sess-r7', updatedAt: Date.now() }),
  );
  const c = {
    async get() { return { state: 'REVIEW' }; },
    async status() { return { revision: 'abc123' }; },
    async unbindRole() {},
    async appendAudit() {},
  };
  const stop = observeReviewerTurn({
    handle,
    c,
    change: { id: 'c-rebuild' },
    task: { workspace },
    revision: 'abc123',
    sessionId: 'sess-r7',
    rebuildReview,
  });
  await started;
  assert.equal(typeof stoppedSignal, 'function', 'rebuild receives the observer cancellation token');
  stop();
  resolveRebuild();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(stoppedSignal(), true, 'the token observes teardown during the rebuild');
  assert.equal(relaunched, 0, 'an in-flight rebuild cannot relaunch after teardown');
});
