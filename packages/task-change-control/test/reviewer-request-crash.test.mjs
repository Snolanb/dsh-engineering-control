/**
 * T-H12 round-4 (F3) — crash/ambiguity around the REAL send boundary on the
 * REAL session-launcher seam.
 *
 * The durable round request identity is written by the production launcher
 * itself at two boundaries (post-session.create, post-prompt-acceptance).
 * A real child host is SIGKILLed inside those windows; the durable claim
 * record and the session host's own history are the only survivors. A fresh
 * host then proves:
 *
 *   1. prompt accepted but response lost (record has sessionId, no sentAt)
 *      → the probe finds THE SAME requestId live in the session → the
 *      recorded session is adopted, the send is marked, and NO duplicate
 *      prompt/session/launch ever happens;
 *   2. crash after session creation but before the prompt → the probe proves
 *      the request was never delivered → the ambiguous record is expired and
 *      exactly ONE fresh request (fresh requestId) is issued.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import { createSessionRpcClient } from 'dsh-task-orchestrator/dispatcher';
import { WorkerDispatcher } from 'dsh-task-orchestrator/dispatcher';
import { WorkerSpecRegistry } from 'dsh-task-orchestrator/worker-specs';
import { createReviewerLauncher } from '../../task-orchestrator/lib/reviewer-launcher.js';
import changeControlPlugin from 'dsh-change-control';
import plugin from '../src/index.js';

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REQUEST_MARKER = /\[review-request ([0-9a-f-]{36})\]/;

const WORKER_SPEC = {
  mode: 'session', profile: 'wp', agentPreset: 'worker',
  provider: 'ollama', model: 'm', workspacePolicy: 'any',
  timeoutMs: 5000, leaseSeconds: 300, name: 'worker',
};

/** Bounded condition wait (test-side observation of async fibers). */
async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/**
 * Minimal but REAL session-host server: session.create/selectModel/history/
 * prompt/cancel. Delivered prompts are recorded into the session's history
 * (as any host records the user message — this is what the production probe
 * reads). A prompt (or the baseline history call) whose session/route is
 * held is RECEIVED but never answered: the requesting child stays blocked at
 * the exact crash window until the test kills it.
 */
async function startStubHost(t) {
  const sessions = new Map(); // sessionId -> { prompt: string|null }
  const promptLog = [];
  const waiters = []; // { kind: 'prompt'|'history', sessionId } -> resolve queue via events
  let counter = 0;
  let holdPrompt = false;
  let holdBaselineHistory = false;
  let historyCalls = new Map(); // sessionId -> count
  const watchers = [];
  const notify = (event) => {
    for (const w of [...watchers]) {
      if (w(event)) watchers.splice(watchers.indexOf(w), 1); // only consumed by a match
    }
  };
  const nextEvent = (kind, sessionId) => new Promise((resolve) => {
    watchers.push((event) => {
      if (event.kind === kind && event.sessionId === sessionId) {
        resolve(event);
        return true;
      }
      return false;
    });
  });

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let message = {};
    try { message = JSON.parse(body || '{}'); } catch { /* malformed */ }
    const method = message.method;
    const payload = message.payload ?? {};
    const sessionId = payload.sessionId;
    const respond = (value) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: { ok: true, value } }));
    };
    if (method === 'session.create') {
      const id = `stub-${++counter}`;
      sessions.set(id, { prompt: null });
      historyCalls.set(id, 0);
      return respond({ sessionId: id });
    }
    if (method === 'session.selectModel') return respond({});
    if (method === 'session.cancel') return respond({});
    if (method === 'session.prompt') {
      const s = sessions.get(sessionId);
      if (!s) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { ok: false, error: { message: 'unknown session' } } }));
        return undefined;
      }
      s.prompt = payload.content?.[0]?.text ?? '';
      promptLog.push({ sessionId, prompt: s.prompt });
      notify({ kind: 'prompt', sessionId });
      if (holdPrompt) return new Promise(() => {}); // response withheld: acceptance proven, return value lost
      return respond({});
    }
    if (method === 'session.history') {
      const n = (historyCalls.get(sessionId) ?? 0) + 1;
      historyCalls.set(sessionId, n);
      const isBaseline = n === 1;
      notify({ kind: isBaseline ? 'history-baseline' : 'history', sessionId });
      if (holdBaselineHistory && isBaseline) return new Promise(() => {}); // crash after create, before prompt
      const s = sessions.get(sessionId);
      const events = s?.prompt
        ? [{ seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: s.prompt }] } } }]
        : [];
      return respond({ events, hasMore: false });
    }
    return respond({});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    // Held responses and keep-alive RPC sockets must never stall teardown.
    const timer = setTimeout(resolve, 1000);
    timer.unref?.();
    server.close(() => { clearTimeout(timer); resolve(); });
    server.closeAllConnections?.();
  }));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    sessions,
    promptLog,
    nextEvent,
    sessionCount: () => counter,
    holdPrompts: () => { holdPrompt = true; },
    holdBaselineHistory: () => { holdBaselineHistory = true; },
    /** After the child is dead, the recovering host must answer again. */
    releaseHolds: () => { holdPrompt = false; holdBaselineHistory = false; },
  };
}

async function composeParent(t, stub) {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-th12-f3-'));
  // SQLite WAL files may still be flushing when teardown runs; retry briefly.
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  const orchestrator = {
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
    // The REAL reviewer launcher + REAL session-launcher RPC client — the
    // production prompt/history seam, no faked hooks.
    createReviewerLauncher: () => createReviewerLauncher({
      rpc: createSessionRpcClient({ baseUrl: stub.baseUrl }),
    }),
  };
  ctx.provide('taskOrchestrator', Object.freeze(orchestrator));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);
  return { ctx, taskStore, dir };
}

/** A governed task parked in PREFLIGHT (preflight gated FAIL) with the task in_review. */
async function governedPreflight(ctx, taskStore, dir) {
  const task = await taskStore.create({
    title: 'f3', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['ship'],
  });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  const dispatcher = ctx.taskChangeControl.createGovernedDispatcher({
    launcher: {
      async launch() {
        return {
          sessionId: 'sess-worker-f3',
          wait: async () => ({
            exitCode: 0,
            commit_sha: 'c1', afterRevision: 'a1',
            files_changed: ['f'], tests_run: ['t'],
            controllerPreflight: ['FAIL: build'],
            criteria: [{ id: 'ship', satisfied: true }],
            deviations: [], workerChecks: ['ok'],
          }),
          terminate: async () => true,
        };
      },
    },
  });
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' });
  assert.equal(result.status, 'in_review');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'PREFLIGHT');
  return { task, change };
}

const claimFileFor = (task, change, revision = 'a1') => join(
  task.workspace,
  '.dsh-governance', 'reviewer-claims',
  `reviewer-claim-${change.id}-${encodeURIComponent(String(revision))}`,
);

// The child host: the SAME production composition, running the REAL session
// launcher against the test's stub host. It is killed mid-window by the test.
const CRASH_CHILD_SCRIPT = `
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import { createSessionRpcClient } from 'dsh-task-orchestrator/dispatcher';
import { createReviewerLauncher } from '../task-orchestrator/lib/reviewer-launcher.js';
import changeControlPlugin from 'dsh-change-control';
import plugin from './src/index.js';
import { join } from 'node:path';

const dir = process.env.TCC_DIR;
const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
const taskOrchestrator = Object.freeze({
  get: taskStore.get.bind(taskStore),
  update: taskStore.update.bind(taskStore),
  updateIf: (id, expected, patch) => taskStore.updateIf(id, expected, patch),
  createReviewerLauncher: () => createReviewerLauncher({
    rpc: createSessionRpcClient({ baseUrl: process.env.STUB_URL }),
  }),
});
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime, {});
ctx.provide('taskOrchestrator', taskOrchestrator);
await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
await ctx.plugin(plugin);
await ctx.taskChangeControl.runGovernedReview(process.env.TCC_TASK_ID, { controllerPreflightOverride: ['pass:build'] });
process.stdout.write('DONE\\n');
`;

function spawnCrashChild(t, dir, taskId, stub) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CRASH_CHILD_SCRIPT], {
    cwd: PKG_DIR,
    env: { ...process.env, TCC_DIR: dir, TCC_TASK_ID: taskId, STUB_URL: stub.baseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.on('exit', (code, signal) => t.diagnostic(`child exit code=${code} signal=${signal} stdout=${stdout.trim()} stderr=${stderr.slice(-2000)}`));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, stderr: () => stderr };
}

test('T-H12 round-4: crash AFTER prompt acceptance (response lost) adopts the recorded request — never re-sent', async (t) => {
  const stub = await startStubHost(t);
  const { ctx, taskStore, dir } = await composeParent(t, stub);
  const { task, change } = await governedPreflight(ctx, taskStore, dir);

  stub.holdPrompts(); // the next prompt's RESPONSE is withheld: acceptance proven, caller lost it
  const { child } = spawnCrashChild(t, dir, task.id, stub);
  // The child's session id is stub-1: deterministic per fresh stub host.
  await stub.nextEvent('prompt', 'stub-1'); // the request IS live in the session host
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));

  // The crashed child left its REAL launcher-written durable record: session
  // + requestId, no send marker. Age ONLY the lease timestamp (production
  // staleness); everything else is exactly what the launcher persisted.
  const claimFile = claimFileFor(task, change);
  const crashed = JSON.parse(readFileSync(claimFile, 'utf8'));
  assert.equal(crashed.sessionId, 'stub-1', 'the real launcher recorded the created session pre-send');
  assert.equal(typeof crashed.requestId, 'string', 'the durable request identity exists before the send');
  assert.equal(crashed.sentAt ?? null, null, 'no send marker: the accept/record gap is genuinely open');
  await writeFile(claimFile, JSON.stringify({ ...crashed, updatedAt: Date.now() - 2 * 10 * 60 * 1000 }));
  process.stderr.write('[f3] claim aged; reconciling\n');

  // A FRESH host reconciliation: the probe must prove the request live in the
  // session history → adopt the SAME session, mark it sent, never re-request.
  const rv = await ctx.taskChangeControl.runGovernedReview(task.id, { controllerPreflightOverride: ['pass:build'] });
  process.stderr.write('[f3] reconciled\n');
  assert.equal(rv.sessionId, 'stub-1', 'the recorded session is adopted, not replaced');
  assert.equal(stub.sessionCount(), 1, 'no second session was created');
  assert.equal(stub.promptLog.length, 1, 'the request was prompted exactly once (by the crashed host)');
  const bindings = (await ctx.changeControl.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.deepEqual(bindings.map((b) => b.sessionId), ['stub-1'], 'the adopted session is the one reviewer binding');
  const recovered = JSON.parse(readFileSync(claimFile, 'utf8'));
  assert.equal(recovered.sessionId, 'stub-1');
  assert.equal(recovered.requestId, crashed.requestId, 'the SAME request identity survives reconciliation');
  assert.equal(typeof recovered.sentAt, 'number', 'the probe-confirmed send is now durably marked');
  const requests = (await ctx.changeControl.history(change.id))
    .filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested');
  assert.equal(requests.length, 1, 'exactly one audited request for the round');
  assert.equal(requests[0].requestId, crashed.requestId, 'the single audit carries the original request identity');

  // The ADOPTED original reviewer still settles its own round through the
  // canonical tool seam — no settlement capability was lost in the window.
  const reviewTool = ctx.tools.view().visible.get('change_submit_review');
  const settle = await reviewTool.execute(
    { changeId: change.id, review: { verdict: 'pass', revision: 'a1', findings: [] } },
    { agent: { id: 'stub-1' } },
  );
  assert.equal(settle.state, 'APPROVED');
});

test('T-H12 round-4: crash after session create but BEFORE the prompt recovers with exactly one fresh request', async (t) => {
  const stub = await startStubHost(t);
  const { ctx, taskStore, dir } = await composeParent(t, stub);
  const { task, change } = await governedPreflight(ctx, taskStore, dir);

  stub.holdBaselineHistory(); // block the child between session.create and session.prompt
  const { child } = spawnCrashChild(t, dir, task.id, stub);
  await stub.nextEvent('history-baseline', 'stub-1'); // child created the session, never prompted
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  stub.releaseHolds(); // the recovering host answers normally

  const claimFile = claimFileFor(task, change);
  const crashed = JSON.parse(readFileSync(claimFile, 'utf8'));
  assert.equal(crashed.sessionId, 'stub-1', 'the real launcher recorded the created session pre-send');
  assert.equal(typeof crashed.requestId, 'string');
  assert.equal(crashed.sentAt ?? null, null);
  assert.equal(stub.promptLog.length, 0, 'nothing was ever prompted');
  await writeFile(claimFile, JSON.stringify({ ...crashed, updatedAt: Date.now() - 2 * 10 * 60 * 1000 }));

  // Reconciliation: the probe proves the request was NEVER delivered →
  // expire the ambiguous record and issue exactly one fresh request.
  const rv = await ctx.taskChangeControl.runGovernedReview(task.id, { controllerPreflightOverride: ['pass:build'] });
  assert.equal(rv.outcome, 'review_started');
  assert.notEqual(rv.sessionId, 'stub-1', 'the never-prompted session is not adopted');
  assert.equal(stub.sessionCount(), 2, 'exactly one fresh session for the retry');
  assert.equal(stub.promptLog.length, 1, 'exactly one fresh prompt — no duplicate of a dead request');
  const fresh = stub.promptLog[0];
  assert.equal(fresh.sessionId, rv.sessionId);
  const freshRequestId = fresh.prompt.match(REQUEST_MARKER)?.[1];
  assert.ok(freshRequestId, 'the fresh prompt carries its own request identity');
  assert.notEqual(freshRequestId, crashed.requestId, 'the never-sent identity is never reused');

  const bindings = (await ctx.changeControl.listRoleBindings())
    .filter((b) => b.changeId === change.id && b.role === 'reviewer');
  assert.deepEqual(bindings.map((b) => b.sessionId), [rv.sessionId], 'only the fresh reviewer is bound — the unprompted session is never bound');
  const recovered = JSON.parse(readFileSync(claimFile, 'utf8'));
  assert.equal(recovered.sessionId, rv.sessionId);
  assert.equal(recovered.requestId, freshRequestId);
  assert.equal(typeof recovered.sentAt, 'number');
  const requests = (await ctx.changeControl.history(change.id))
    .filter((e) => e.kind === 'review_orchestration' && e.action === 'review_round_requested');
  assert.equal(requests.length, 1, 'exactly one audited request');
  assert.equal(requests[0].requestId, freshRequestId);
});
