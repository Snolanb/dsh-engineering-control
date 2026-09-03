import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import { WorkerSpecRegistry } from 'dsh-task-orchestrator/worker-specs';
import { WorkerDispatcher } from 'dsh-task-orchestrator/dispatcher';
import changeControlPlugin from 'dsh-change-control';
import plugin from '../src/index.js';

const SYSTEM = 'dsh-task-orchestrator';

async function compose(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-binding-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  const registry = new WorkerSpecRegistry({
    worker: { mode: 'session', profile: 'wp', agentPreset: 'worker', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 60000, leaseSeconds: 300 },
  });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    createDispatcher: (options = {}) => new WorkerDispatcher({
      store: taskStore, registry,
      launcher: options.launcher,
      preflight: options.preflight ?? (async () => ({ ok: true, spec: registry.get('worker') })),
      preDispatch: options.preDispatch ?? null,
    }),
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);
  return { ctx, taskStore, dir };
}

async function governedReadyTask(ctx, taskStore, dir) {
  const task = await taskStore.create({
    title: 'governed session task', description: 'd', status: 'ready',
    workspace: dir, worker_profile: 'worker', acceptance_criteria: ['a'],
  });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['x'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  return { task, change };
}

/** Fake session-mode launcher. Returns real sessionId; retains/controls wait resolve. */
function fakeSessionLauncher({ sessionId = 'sess-1' } = {}) {
  const state = { resolveGate: null, gatePromise: null, launchedResolve: null };
  state.gatePromise = new Promise((r) => { state.resolveGate = r; });
  return {
    launched: [],
    launchedResolved: new Promise((r) => { state.launchedResolve = r; }),
    resolveGate(v) { const r = state.resolveGate; state.resolveGate = null; r?.(v); },
    async launch({ task, runId }) {
      this.launched.push({ taskId: task.id, runId });
      state.launchedResolve?.();
      return {
        sessionId,
        wait: () => state.gatePromise,
        async terminate() { const r = state.resolveGate; state.resolveGate = null; r?.({ exitCode: null, signal: 'SIGTERM', stdout: '', stderr: 'terminated' }); return true; },
      };
    },
  };
}

test('governed dispatch in session mode binds the ACTUAL returned sessionId as worker role', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  const launcher = fakeSessionLauncher({ sessionId: 'sess-real-42' });
  const dispatcher = ctx.taskChangeControl.createGovernedDispatcher({ launcher });
  const done = dispatcher.dispatchTask(task);
  // Let the launcher actually start and the binder run.
  await launcher.launchedResolved;
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(launcher.launched.length, 1);
  // Binding exists against the returned sessionId, NOT against any requested identity.
  const bindings = await ctx.changeControl.status(change.id).then((s) => s.bindings);
  assert.ok(bindings.some((b) => b.sessionId === 'sess-real-42' && b.role === 'worker'), JSON.stringify(bindings));
  // Settle: success → in_review.
  launcher.resolveGate({ exitCode: 0, stdout: 'done', stderr: '' });
  const result = await done;
  assert.equal(result.status, 'in_review');
});

test('worker binding is CLEANED when the dispatched run ends', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  const launcher = fakeSessionLauncher({ sessionId: 'sess-out' });
  const dispatcher = ctx.taskChangeControl.createGovernedDispatcher({ launcher });
  const done = dispatcher.dispatchTask(task);
  await launcher.launchedResolved;
  await new Promise((r) => setTimeout(r, 25));
  launcher.resolveGate({ exitCode: 1, stdout: '', stderr: 'boom' });
  await done;
  const bindings = await ctx.changeControl.status(change.id).then((s) => s.bindings);
  assert.equal(bindings.filter((b) => b.sessionId === 'sess-out').length, 0, 'stale binding must be removed');
});

test('failed launch: no worker binding is created (nothing to clean up)', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  const failing = {
    async launch() { throw new Error('spawn blew up'); },
  };
  const dispatcher = ctx.taskChangeControl.createGovernedDispatcher({ launcher: failing });
  const result = await dispatcher.dispatchTask(task);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'launch_failed');
  const bindings = await ctx.changeControl.status(change.id).then((s) => s.bindings);
  assert.equal(bindings.length, 0);
});

test('kill switch: terminate on the WIRED handle unbinds the binding (no leaked role)', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  const { createBindingLauncher } = await import('../src/binding.js');
  const launcher = fakeSessionLauncher({ sessionId: 'sess-kill' });
  const wrapped = createBindingLauncher(launcher, ctx.get('changeControl'), SYSTEM);
  const handle = await wrapped.launch({ task: { id: task.id }, spec: { mode: 'session' }, runId: 'run-kill' });
  let s = await ctx.changeControl.status(change.id);
  assert.ok(s.bindings.some((b) => b.sessionId === 'sess-kill'), 'bound pre-terminate');
  await handle.terminate('SIGTERM');
  s = await ctx.changeControl.status(change.id);
  assert.deepEqual(s.bindings.filter((b) => b.sessionId === 'sess-kill'), [], 'post-terminate unbound');
});

test('importing an incidental sessionId on a HEADLESS spec does NOT bind', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await governedReadyTask(ctx, taskStore, dir);
  const { createBindingLauncher } = await import('../src/binding.js');
  const raw = {
    async launch() { return { sessionId: 'incidental-headless', wait: async () => ({ exitCode: 0 }) }; },
  };
  const wrapped = createBindingLauncher(raw, ctx.get('changeControl'), SYSTEM);
  const handle = await wrapped.launch({ task: { id: task.id }, spec: { mode: 'headless-profile' }, runId: 'run-h' });
  assert.equal(handle.sessionId, 'incidental-headless'); // pass through untouched
  const s = await ctx.changeControl.status(change.id);
  assert.equal(s.bindings.filter((b) => b.sessionId === 'incidental-headless').length, 0);
});

test('UNGOVERNED task: session launch never binds (bindRole is never invoked)', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({
    title: 'ungoverned sesh', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['a'],
  });
  const cc = ctx.get('changeControl');
  let bindRoleCalls = 0;
  // Proxy wrap is forbidden across the dispatcher boundary — spread + intercept.
  const spy = { ...cc, bindRole: async (...args) => { bindRoleCalls++; return cc.bindRole(...args); } };
  const launcher = fakeSessionLauncher({ sessionId: 'sess-ungoverned' });
  // Construct the wrapper directly against the SPY (bypassing service js wiring).
  const { createBindingLauncher } = await import('../src/binding.js');
  const wrapped = createBindingLauncher(launcher, spy, SYSTEM);
  const handle = await wrapped.launch({ task: { id: task.id }, spec: { mode: 'session' }, runId: 'run-ug' });
  assert.equal(handle.sessionId, 'sess-ungoverned');
  assert.equal(bindRoleCalls, 0, 'ungoverned dispatch must never call bindRole');
});

test('bind failure mid-launch TERMINATES the orphaned session before rethrow', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task } = await governedReadyTask(ctx, taskStore, dir);
  const { createBindingLauncher } = await import('../src/binding.js');
  let terminateCalls = 0;
  const raw = {
    async launch() {
      return {
        sessionId: 'sess-orphan',
        wait: async () => ({ exitCode: 0 }),
        async terminate() { terminateCalls++; return true; },
      };
    },
  };
  const broken = {
    ...ctx.get('changeControl'),
    bindRole: async () => { throw Object.assign(new Error('clash'), { code: 'ALREADY_BOUND' }); },
  };
  const wrapped = createBindingLauncher(raw, broken, SYSTEM);
  await assert.rejects(
    wrapped.launch({ task: { id: task.id }, spec: { mode: 'session' }, runId: 'run-orphan' }),
    (error) => error && error.code === 'ALREADY_BOUND',
  );
  assert.equal(terminateCalls, 1, 'orphaned sessions must be terminated before rethrow');
});

test('model surface: zero change_bind* / change_create* / change_set* tool exists on the integration', async (t) => {
  const { ctx } = await compose(t);
  const names = [...ctx.tools.view().knownNames];
  for (const n of names) {
    assert.ok(!n.startsWith('change_bind'), `${n} must not exist`);
    assert.ok(!/change_(create|set_|bootstrap_state)/.test(n) || n === 'change_bootstrap_task', `${n} must not exist`);
  }
});
