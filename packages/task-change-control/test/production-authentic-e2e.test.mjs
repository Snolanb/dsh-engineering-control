import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as taskOrchestratorPlugin from 'dsh-task-orchestrator';
import { createSessionRpcClient } from 'dsh-task-orchestrator/dispatcher';
import changeControlPlugin from 'dsh-change-control';
import integrationPlugin from '../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

// This is a real child-process session host. It executes the production
// worker_complete tool, exposes durable session.history over HTTP, and sends
// reviewer tool calls through the parent host's real ToolRuntime bridge.
const SESSION_HOST = String.raw`
import { createServer } from 'node:http';
import { createTaskTools } from 'dsh-task-orchestrator/tools';
import { WORKER_COMPLETION_TOOL } from 'dsh-task-orchestrator/dispatcher';

const bridgeUrl = process.env.DSH_REVIEW_BRIDGE;
const sessions = new Map();
const hostEvents = [];
let sessionNumber = 0;
let workerNumber = 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const workerTool = createTaskTools({}).find((tool) => tool.name === WORKER_COMPLETION_TOOL);
if (!workerTool) throw new Error('production worker_complete tool is unavailable');
const proofs = [
  {
    beforeRevision: 'main@baseline', afterRevision: 'abc123', commit_sha: 'abc123',
    files_changed: ['src/x.js'], tests_run: ['test/x.test.mjs'], remaining_blockers: [],
    criteria: [{ id: 'ship', satisfied: true }], controllerPreflight: ['pass:build'], summary: 'initial worker complete',
  },
  {
    beforeRevision: 'abc123', afterRevision: 'def456', commit_sha: 'def456',
    files_changed: ['src/x.js', 'src/y.js'], tests_run: ['test/x.test.mjs', 'test/y.test.mjs'], remaining_blockers: [],
    criteria: [{ id: 'ship', satisfied: true }], controllerPreflight: ['pass:build'], summary: 'repair worker complete',
  },
];

function append(session, type, data) {
  session.seq += 1;
  session.events.push({ seq: session.seq, type, data });
}
function reply(res, value, ok = true, error = null) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ result: { ok, value, ...(error ? { error } : {}) } }));
}
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
async function requestReview(session, prompt) {
  const response = await fetch(bridgeUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'reviewer.request', payload: { sessionId: session.id, prompt } }),
  });
  const envelope = await response.json();
  if (!envelope?.result?.ok) throw new Error(envelope?.result?.error?.message ?? 'review request bridge failed');
  return envelope.result.value;
}
async function callReview(session, payload) {
  const response = await fetch(bridgeUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'change_submit_review', payload: { ...payload, sessionId: session.id } }),
  });
  const envelope = await response.json();
  if (!envelope?.result?.ok) throw new Error(envelope?.result?.error?.message ?? 'review bridge failed');
  return envelope.result.value;
}
async function runSession(session) {
  await wait(session.agentPreset === 'reviewer' ? 60 : 20);
  if (session.cancelled) return;
  if (session.agentPreset === 'worker') {
    const args = proofs[Math.min(workerNumber++, proofs.length - 1)];
    const value = await workerTool.execute(args, { agent: { id: session.id } });
    const meta = workerTool.output.presentationMeta(args, value);
    const callId = 'worker-complete-' + session.id;
    append(session, 'tool/call', { callId, name: WORKER_COMPLETION_TOOL, arguments: JSON.stringify(args) });
    append(session, 'tool/result', { message: { content: [{ type: 'tool-result', toolCallId: callId, isError: false }] }, meta });
    hostEvents.push({ name: WORKER_COMPLETION_TOOL, sessionId: session.id, commit_sha: meta.commit_sha });
  } else {
    // A reviewer submits one verdict only after the parent host records the
    // production request for this session. The response is derived from the
    // persisted revision observed at request time, never from a future round.
    const requested = await requestReview(session, session.prompt);
    const { changeId, revision, review } = requested ?? {};
    if (typeof changeId !== 'string' || typeof revision !== 'string' || !review || review.revision !== revision) {
      throw new Error('review request did not return the current revision-bound verdict');
    }
    const value = await callReview(session, { changeId, review });
    const callId = 'change-submit-review-' + session.id + '-' + review.verdict;
    append(session, 'tool/call', { callId, name: 'change_submit_review', arguments: JSON.stringify({ changeId, review }) });
    append(session, 'tool/result', { message: { content: [{ type: 'tool-result', toolCallId: callId, isError: false }] }, value });
    hostEvents.push({ name: 'change_submit_review', sessionId: session.id, verdict: review.verdict, revision, changeId });
  }
  append(session, 'assistant/message', { message: { content: [{ type: 'text', text: 'session tool completed' }] } });
  append(session, 'turn/end', { reason: { kind: 'completed' } });
}
async function invoke(message) {
  const method = message.method;
  const payload = message.payload ?? {};
  if (method === 'session.create') {
    const id = 'session-' + (++sessionNumber);
    sessions.set(id, { id, agentPreset: payload.agentPreset, events: [], seq: 0, prompt: '', cancelled: false });
    return { sessionId: id };
  }
  if (method === 'session.selectModel' || method === 'session.history') {
    const session = sessions.get(payload.sessionId);
    return { events: session?.events ?? [] };
  }
  if (method === 'session.prompt') {
    const session = sessions.get(payload.sessionId);
    if (!session) throw new Error('unknown session');
    session.prompt = payload.content?.[0]?.text ?? '';
    hostEvents.push({ name: 'session.prompt', sessionId: session.id, agentPreset: session.agentPreset, prompt: session.prompt });
    void runSession(session).catch((error) => {
      append(session, 'turn/end', { reason: { kind: 'error', error: { message: String(error) } } });
    });
    return {};
  }
  if (method === 'session.cancel') {
    const session = sessions.get(payload.sessionId);
    if (session) session.cancelled = true;
    return {};
  }
  if (method === 'host.events') return { events: hostEvents };
  return {};
}
const server = createServer(async (req, res) => {
  try {
    const message = await readJson(req);
    reply(res, await invoke(message));
  } catch (error) {
    reply(res, null, false, { code: 'HOST_ERROR', message: String(error) });
  }
});
server.listen(0, '127.0.0.1', () => {
  console.log('READY ' + server.address().port);
});
process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startReviewBridge(t) {
  let executeReview = null;
  let executeRequest = null;
  const calls = [];
  const results = [];
  const requests = [];
  const requestResults = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (message.method === 'reviewer.request') {
        if (typeof executeRequest !== 'function') throw new Error('review request bridge is not ready');
        requests.push(message.payload);
        const value = await executeRequest(message.payload);
        requestResults.push(value);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { ok: true, value } }));
        return;
      }
      if (message.method !== 'change_submit_review' || typeof executeReview !== 'function') throw new Error('review bridge is not ready');
      calls.push(message.payload);
      const value = await executeReview(message.payload);
      results.push(value);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: { ok: true, value } }));
    } catch (error) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: { ok: false, error: { message: String(error) } } }));
    }
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    results,
    requests,
    requestResults,
    setExecutor(fn) { executeReview = fn; },
    setRequestExecutor(fn) { executeRequest = fn; },
  };
}

async function startSessionHost(t, bridgeUrl) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', SESSION_HOST], {
    cwd: packageRoot,
    env: { ...process.env, DSH_REVIEW_BRIDGE: bridgeUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const ready = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const onExit = (code, signal) => reject(new Error(`session host exited before READY (${code ?? signal}): ${stderr.join('')}`));
    child.once('error', reject);
    child.once('exit', onExit);
    lines.on('line', (line) => {
      if (!line.startsWith('READY ')) return;
      child.removeListener('exit', onExit);
      lines.close();
      resolve(Number(line.slice(6)));
    });
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  });
  return { baseUrl: `http://127.0.0.1:${ready}/api`, child };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('condition not reached before timeout');
}

const orchestrator = { name: taskOrchestratorPlugin.name, inject: taskOrchestratorPlugin.inject, apply: taskOrchestratorPlugin.apply };

test('authentic production E2E executes worker_complete and change_submit_review in a real child session host', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'h11-authentic-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bridge = await startReviewBridge(t);
  const host = await startSessionHost(t, bridge.url);
  const ctx = new Context();
  t.after(() => ctx.dispose?.());
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, {});
  ctx.provide('webServer', { register() { return () => {}; } });
  await ctx.plugin(orchestrator, {
    dbPath: join(dir, 'tasks.db'),
    workerSpecs: {
      worker: {
        mode: 'session', profile: 'worker-profile', agentPreset: 'worker',
        provider: 'ollama', model: 'm', workspacePolicy: 'any',
        timeoutMs: 2000, leaseSeconds: 30,
      },
    },
    preflightOptions: {
      presetExists: new Set(['worker']),
      llm: {
        listProviders() { return [{ id: 'ollama' }]; },
        async listModels(provider) { return provider === 'ollama' ? [{ id: 'm' }] : []; },
      },
    },
    workerLauncherOptions: { sessionOptions: { rpc: createSessionRpcClient({ baseUrl: host.baseUrl }), pollIntervalMs: 5 } },
    reviewerLauncherOptions: { sessionOptions: { rpc: createSessionRpcClient({ baseUrl: host.baseUrl }), pollIntervalMs: 5 } },
  });
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(integrationPlugin);

  const orch = ctx.get('taskOrchestrator');
  const cc = ctx.get('changeControl');
  const tcc = ctx.get('taskChangeControl');
  bridge.setExecutor(async ({ sessionId, changeId, review }) => {
    const outcome = await ctx.tools.execute({
      callId: `authentic-review-${bridge.calls.length}`,
      name: 'change_submit_review',
      arguments: { changeId, review },
      agent: { id: sessionId },
      signal: new AbortController().signal,
    });
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    return outcome;
  });
  bridge.setRequestExecutor(async ({ sessionId, prompt }) => {
    const changeId = prompt.match(/Change ([A-Za-z0-9-]+)/)?.[1];
    assert.ok(changeId, 'review request names its governed Change');
    const status = await cc.status(changeId);
    const revision = status.revision;
    const firstRound = status.attempts.length === 1;
    const review = firstRound
      ? { verdict: 'fail', revision, findings: [{ severity: 'critical', category: 'authentic-e2e', location: 'src/x.js', problem: 'missing guard', requiredOutcome: 'fix and re-test' }] }
      : { verdict: 'pass', revision, findings: [] };
    return { sessionId, changeId, revision, review };
  });

  const task = orch.create({
    title: 'authentic governed e2e', description: 'execute real session-host tool calls',
    status: 'ready', workspace: dir, worker_profile: 'worker', acceptance_criteria: ['ship'],
  });
  const { change } = await tcc.bootstrapTask(task.id);
  const plan = await cc.submitPlan(change.id, { steps: ['implement', 'test'] });
  await cc.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });

  const dispatcher = tcc.createGovernedDispatcher();
  const dispatched = await dispatcher.dispatchOnce({ workerProfile: 'worker' });
  assert.equal(dispatched.dispatched, true, JSON.stringify(dispatched));
  assert.equal(dispatched.status, 'in_review', JSON.stringify(dispatched));

  // Every new persisted REVIEW revision must produce a new production prompt
  // before its child session is allowed to submit a verdict. The current
  // implementation reuses the first binding after FAIL, so this RED wait
  // times out on main instead of accepting a pre-programmed PASS.
  try {
    await waitFor(() => bridge.requestResults.length === 2);
  } catch {
    assert.fail(`expected two revision-bound reviewer requests, observed ${bridge.requestResults.length}: ${JSON.stringify(bridge.requestResults)}`);
  }

  await waitFor(async () => {
    const current = orch.get(task.id);
    const state = await cc.get(change.id);
    return current?.status === 'done' && state?.state === 'APPROVED';
  });
  const hostEvents = await createSessionRpcClient({ baseUrl: host.baseUrl }).call('host.events');
  const workerCalls = hostEvents.events.filter((event) => event.name === 'worker_complete');
  const promptEvents = hostEvents.events.filter((event) => event.name === 'session.prompt' && event.agentPreset === 'reviewer');
  const reviewCalls = hostEvents.events.filter((event) => event.name === 'change_submit_review');
  assert.equal(promptEvents.length, 2, 'production sends one reviewer session.prompt per REVIEW revision');
  assert.equal(workerCalls.length, 2, 'initial worker and repair worker executed worker_complete');
  assert.equal(reviewCalls.length, 2, 'FAIL and PASS were submitted through change_submit_review');
  assert.deepEqual(reviewCalls.map((event) => event.verdict), ['fail', 'pass']);
  assert.equal(bridge.requests.length, 2, 'one production reviewer request per REVIEW revision');
  assert.ok(bridge.requests.every((request) => typeof request.sessionId === 'string' && request.sessionId.length > 0), 'each request is attributable to its reviewer session');
  assert.ok(bridge.requests.every((request) => typeof request.prompt === 'string' && request.prompt.length > 0), 'requests carry the production prompt');
  const requestedRevisions = bridge.requestResults.map((request) => request.revision);
  assert.equal(new Set(requestedRevisions).size, 2, 'requests are bound to distinct current revisions');
  assert.deepEqual(reviewCalls.map((event) => event.revision), requestedRevisions, 'each verdict uses the revision observed for its request');
  assert.equal(bridge.calls.length, 2, 'the child session invoked the parent host review tool bridge twice');
  assert.equal(bridge.results.length, 2, 'the parent ToolRuntime returned both review outcomes');
  assert(bridge.results.every((outcome) => outcome.isError === false), JSON.stringify(bridge.results));
  assert.equal(orch.get(task.id).status, 'done');
  assert.equal((await cc.get(change.id)).state, 'APPROVED');
});
