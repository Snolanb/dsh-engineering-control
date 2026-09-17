import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import changeControlPlugin from 'dsh-change-control';
import integrationPlugin from '../src/index.js';
import { createTaskChangeControlService } from '../src/service.js';
import { resolveGovernancePolicy } from '../src/policy.js';
import { createLifecycleBootstrapper } from '../src/lifecycle-bootstrap.js';

const SYSTEM = 'dsh-task-orchestrator';
const ACTIVE_STATUSES = ['ready', 'claimed', 'running', 'in_review'];

function governedTask(overrides = {}) {
  return {
    title: 'Rotate OAuth credentials',
    description: 'Rotate the OAuth credentials for deployment.',
    acceptance_criteria: ['credentials are rotated'],
    metadata: { governance: { mode: 'auto' } },
    ...overrides,
  };
}

function ordinaryTask(overrides = {}) {
  return {
    title: 'Document API examples',
    description: 'Update the examples in the developer documentation.',
    ...overrides,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, { timeoutMs = 1500, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) throw lastError;
  throw new Error('condition was not met before timeout');
}

async function composeCore(t, { dir: providedDir } = {}) {
  const dir = providedDir ?? await mkdtemp(join(tmpdir(), 'tcc-lifecycle-bootstrap-'));
  if (!providedDir) t.after(() => rm(dir, { recursive: true, force: true }));

  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  t.after(() => taskStore.close());

  // This is the same service shape exposed by the real task-orchestrator
  // plugin; the store and Change Control package remain the real implementations.
  const taskOrchestrator = Object.freeze({
    create: taskStore.create.bind(taskStore),
    get: taskStore.get.bind(taskStore),
    list: taskStore.list.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    claim: taskStore.claim.bind(taskStore),
    start: taskStore.start.bind(taskStore),
    complete: taskStore.complete.bind(taskStore),
    subscribe: taskStore.subscribe.bind(taskStore),
  });
  ctx.provide('taskOrchestrator', taskOrchestrator);
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });

  const changeControl = ctx.get('changeControl');
  const service = createTaskChangeControlService({
    taskOrchestrator: () => taskOrchestrator,
    changeControl: () => changeControl,
  });
  return { ctx, dir, taskStore, taskOrchestrator, changeControl, service };
}

async function composeIntegration(t, options = {}) {
  const core = await composeCore(t, options);
  await core.ctx.plugin(integrationPlugin);
  return core;
}

function makeController({ taskOrchestrator, changeControl, service }) {
  return createLifecycleBootstrapper({
    taskOrchestrator,
    changeControl,
    bootstrapTask: service.bootstrapTask.bind(service),
    // The default is the G1 resolver; omitting it freezes that contract.
  });
}

async function linkedChanges(changeControl, taskId) {
  return changeControl.listByWorkItem(SYSTEM, taskId);
}

async function assertExactlyOneLink(changeControl, taskId) {
  const changes = await eventually(async () => {
    const current = await linkedChanges(changeControl, taskId);
    return current.length > 0 ? current : false;
  });
  assert.equal(changes.length, 1, 'one and only one nonterminal Change is linked');
  assert.deepEqual(changes[0].workItem, { system: SYSTEM, id: taskId });
  assert.equal(changes[0].state, 'DRAFT');
  return changes[0];
}

test('controller contract: reconcile is deterministic and start is disposable', async (t) => {
  const core = await composeCore(t);
  const controller = makeController(core);
  const task = core.taskStore.create(governedTask());

  core.taskStore.update(task.id, { status: 'ready' });
  const reconciliation = controller.reconcile();
  assert.equal(typeof reconciliation?.then, 'function', 'reconcile() returns a Promise');
  await reconciliation;
  await assertExactlyOneLink(core.changeControl, task.id);

  const dispose = controller.start();
  assert.equal(typeof dispose, 'function', 'start() returns a disposer');
  dispose();

  const afterDispose = core.taskStore.create(governedTask({ title: 'Rotate API tokens' }));
  core.taskStore.update(afterDispose.id, { status: 'ready' });
  await sleep(100);
  assert.deepEqual(await linkedChanges(core.changeControl, afterDispose.id), []);
});

test('AC1: ready, claimed, running, and in_review each create one linked Change', async (t) => {
  const core = await composeCore(t);
  const controller = makeController(core);
  const task = core.taskStore.create(governedTask());
  assert.equal(resolveGovernancePolicy(task).required, true, 'fixture is auto-governed by G1');
  const dispose = controller.start();
  t.after(dispose);

  core.taskStore.update(task.id, { status: 'ready' });
  await assertExactlyOneLink(core.changeControl, task.id);
  assert.equal(core.taskStore.get(task.id).status, ACTIVE_STATUSES[0]);

  const claim = core.taskStore.claim(task.id, 'worker-1', { lease_seconds: 30 });
  assert.equal(claim.claimed, true);
  await assertExactlyOneLink(core.changeControl, task.id);
  assert.equal(core.taskStore.get(task.id).status, ACTIVE_STATUSES[1]);

  core.taskStore.start(task.id, 'worker-1');
  await assertExactlyOneLink(core.changeControl, task.id);
  assert.equal(core.taskStore.get(task.id).status, ACTIVE_STATUSES[2]);

  core.taskStore.complete(task.id, { result_summary: 'submitted for review' }, { worker: 'worker-1' });
  await assertExactlyOneLink(core.changeControl, task.id);
  assert.equal(core.taskStore.get(task.id).status, ACTIVE_STATUSES[3]);
});

test('AC2: repeated lifecycle notifications never create duplicate Changes', async (t) => {
  const core = await composeCore(t);
  const controller = makeController(core);
  const task = core.taskStore.create(governedTask());
  const dispose = controller.start();
  t.after(dispose);

  core.taskStore.update(task.id, { status: 'ready' });
  await eventually(async () => (await linkedChanges(core.changeControl, task.id)).length === 1);

  // TaskStore notifications intentionally carry no event payload. Repeated
  // writes exercise the subscription's persisted-state rescan, including
  // overlapping asynchronous reconciliations.
  for (let index = 0; index < 12; index += 1) {
    core.taskStore.update(task.id, { description: `same persisted task ${index}` });
  }
  await eventually(async () => (await linkedChanges(core.changeControl, task.id)).length > 0);
  assert.equal((await linkedChanges(core.changeControl, task.id)).length, 1);
});

test('AC3: startup reconciliation recreates a missing link for a governed active task', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-lifecycle-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const persistedStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  const task = persistedStore.create(governedTask());
  persistedStore.update(task.id, { status: 'ready' });
  persistedStore.close();

  const core = await composeCore(t, { dir });
  assert.deepEqual(await linkedChanges(core.changeControl, task.id), [], 'restart begins with no Change linkage');
  const controller = makeController(core);
  const dispose = controller.start();
  t.after(dispose);

  const change = await assertExactlyOneLink(core.changeControl, task.id);
  assert.equal(change.workItem.id, task.id);
});

test('AC4: ordinary ungoverned tasks remain usable without Change creation', async (t) => {
  const core = await composeCore(t);
  const controller = makeController(core);
  const task = core.taskStore.create(ordinaryTask());
  const dispose = controller.start();
  t.after(dispose);

  core.taskStore.update(task.id, { status: 'ready' });
  await sleep(100);
  assert.equal(core.taskStore.get(task.id).status, 'ready');
  assert.deepEqual(await linkedChanges(core.changeControl, task.id), []);
});

test('AC5: the normal governed path bootstraps without a captain bootstrap call', async (t) => {
  const core = await composeIntegration(t);
  const task = core.taskStore.create(governedTask());

  // No change_bootstrap_task or taskChangeControl.bootstrapTask call is made.
  core.taskStore.update(task.id, { status: 'ready' });
  await assertExactlyOneLink(core.changeControl, task.id);
});

test('AC6: a manually bootstrapped Change remains compatible and is not duplicated', async (t) => {
  const core = await composeIntegration(t);
  const task = core.taskStore.create(governedTask());
  const manual = await core.ctx.taskChangeControl.bootstrapTask(task.id);

  core.taskStore.update(task.id, { status: 'ready' });
  const change = await assertExactlyOneLink(core.changeControl, task.id);
  assert.equal(change.id, manual.change.id);
});
