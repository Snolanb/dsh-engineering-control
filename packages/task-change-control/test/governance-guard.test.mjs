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
import changeControlPlugin from 'dsh-change-control';
import plugin from '../src/index.js';

async function compose(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  const registry = new WorkerSpecRegistry({
    worker: { mode: 'headless-profile', profile: 'wp', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 1000, leaseSeconds: 30 },
  });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    // Same constructor the domain plugin exposes.
    createDispatcher: (options = {}) => {
      const { WorkerDispatcher } = requireDispatcher();
      return new WorkerDispatcher({
        store: taskStore,
        registry,
        launcher: options.launcher ?? GOOD_LAUNCHER,
        preflight: options.preflight ?? (async () => ({ ok: true, spec: registry.get('worker') })),
        preDispatch: options.preDispatch ?? null,
      });
    },
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);
  return { ctx, taskStore };
}

// Lazy import to keep composition readable.
import * as dispatcherMod from 'dsh-task-orchestrator/dispatcher';
function requireDispatcher() { return dispatcherMod; }

const GOOD_LAUNCHER = { async launch() { return { wait: async () => ({ exitCode: 0, stdout: 'done', stderr: '' }) }; } };

async function makeReadyGovernedTask(t, ctx, taskStore, dirName) {
  const task = await taskStore.create({
    title: 'governed', description: 'd', status: 'ready', workspace: dirName,
    worker_profile: 'worker', acceptance_criteria: ['a'],
  });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['do'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  return { task, change };
}

test('governed task WITHOUT accepted plan or READY Change is blocked with named preconditions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-guard-pre-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { ctx, taskStore } = await compose(t);
  const task = await taskStore.create({
    title: 'half-governed', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['a'],
  });
  await ctx.taskChangeControl.bootstrapTask(task.id); // DRAFT, no plan
  const dispatcher = ctx.taskChangeControl.createGovernedDispatcher({ launcher: GOOD_LAUNCHER });
  const result = await dispatcher.dispatchTask(task);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch_not_governed');
  const names = result.predispatch.preconditions.filter((p) => !p.satisfied).map((p) => p.name).sort();
  assert.deepEqual(names, ['accepted_plan', 'change_ready'].sort());
  assert.equal((await taskStore.get(task.id)).status, 'ready', 'claim released');
});

test('non-{ok:true} verdict (undefined/null/false) fails closed at the dispatcher', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-guard-fco-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { taskStore } = await compose(t);
  // Direct WorkerDispatcher with a leaky callback — no integration layer involved.
  const registry = new WorkerSpecRegistry({
    worker: { mode: 'headless-profile', profile: 'wp', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 1000, leaseSeconds: 30 },
  });
  const task = await taskStore.create({
    title: 'raw dispatcher', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['a'],
  });
  const inheritedOk = Object.create({ ok: true });
  const evilProxy = new Proxy({}, { getPrototypeOf() { throw new Error('proto trap') }, ownKeys() { throw new Error('ownKeys trap') } });
  const getterVerdict = Object.defineProperty({ ok: true }, 'ok', { get() { throw new Error('ok getter trap') } });
  const badShapes = [
    evilProxy,
    undefined, null, false, {}, 'ok', { ok: true, extra: 'unexpected' }, { ok: 1 }, [],
    (() => { const a = []; a.ok = true; return a; })(),                 // array with own key
    inheritedOk,                                                          // prototype-inherited ok
    (() => { const o = { ok: true }; Object.defineProperty(o, 'sneak', { value: 1, enumerable: false }); return o; })(), // non-enumerable extra
    (() => { const o = { ok: true }; o[Symbol('s')] = 1; return o; })(),  // symbol extra
    new (class { constructor() { this.ok = true; } })(),                  // custom prototype
    Object.freeze({ ok: false }),                                         // frozen false
    getterVerdict,                                                        // throwing ok getter
    (() => { const f = () => {}; f.ok = true; return f; })(),             // function with own ok
  ];
  // Null-prototype {ok:true} is a LEGITIMATE plain object and must pass.
  {
    const { WorkerDispatcher } = await import('dsh-task-orchestrator/dispatcher');
    let launched = 0;
    const ok = new WorkerDispatcher({
      store: taskStore, registry,
      preflight: async () => ({ ok: true, spec: registry.get('worker') }),
      launcher: { async launch() { launched++; return { wait: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) }; } },
      preDispatch: async () => Object.assign(Object.create(null), { ok: true }),
    });
    const cleanTask = await taskStore.create({
      title: 'null-proto', description: 'd', status: 'ready', workspace: dir,
      worker_profile: 'worker', acceptance_criteria: ['a'],
    });
    const r = await ok.dispatchTask(cleanTask);
    assert.equal(r.dispatched, true);
    assert.equal(launched, 1);
    // Recreate the same shape task for the main bad-shape loop.
  }

  for (const bad of badShapes) {
    const { WorkerDispatcher } = await import('dsh-task-orchestrator/dispatcher');
    const dispatcher = new WorkerDispatcher({
      store: taskStore, registry,
      preflight: async () => ({ ok: true, spec: registry.get('worker') }),
      launcher: { async launch() { throw new Error('must not launch with fail-closed policy') } },
      preDispatch: async () => bad,
    });
    const result = await dispatcher.dispatchTask(task);
    assert.equal(result.dispatched, false, `shape #${badShapes.indexOf(bad)} must fail closed`);
    assert.equal(result.reason, 'dispatch_not_governed');
    assert.equal((await taskStore.get(task.id)).status, 'ready', 'claim restored');
  }
});

test('fully governed task clears the guard and dispatches', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-guard-go-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { ctx, taskStore } = await compose(t);
  const { task } = await makeReadyGovernedTask(t, ctx, taskStore, dir);
  const dispatcher = ctx.taskChangeControl.createGovernedDispatcher({ launcher: GOOD_LAUNCHER });
  const result = await dispatcher.dispatchTask(task);
  assert.equal(result.dispatched, true);
  assert.equal(result.status, 'in_review');
});

test('caller preDispatch may NOT replace the integration guard; it only composes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-guard-override-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { ctx, taskStore } = await compose(t);
  const task = await taskStore.create({
    title: 'override-attempt', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['a'],
  });
  await ctx.taskChangeControl.bootstrapTask(task.id); // linked, DRAFT — MUST be blocked
  const laxed = ctx.taskChangeControl.createGovernedDispatcher({
    launcher: GOOD_LAUNCHER,
    preDispatch: async () => ({ ok: true }), // attacker proposes "always allow"
  });
  const result = await laxed.dispatchTask(task);
  assert.equal(result.dispatched, false, 'governance must be fail-closed even under override');
  assert.equal(result.reason, 'dispatch_not_governed');
});

test('ungoverned task passes the guard untouched (no Change, no failure)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-guard-ung-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { ctx, taskStore } = await compose(t);
  const task = await taskStore.create({
    title: 'ungoverned', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['a'],
  });
  const dispatcher = ctx.taskChangeControl.createGovernedDispatcher({ launcher: GOOD_LAUNCHER });
  const result = await dispatcher.dispatchTask(task);
  assert.equal(result.dispatched, true);
  assert.equal(result.status, 'in_review');
});
