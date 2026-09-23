import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import changeControlPlugin from 'dsh-change-control';
import plugin from '../src/index.js';
import { createIntegrationTools } from '../src/tools.js';

const SYSTEM = 'dsh-task-orchestrator';
const INTEGRATION_TOOLS = ['change_bootstrap_task', 'change_for_task', 'governed_start_planning'];
const CHANGE_TOOLS = ['change_get', 'change_submit_plan', 'change_submit_proof', 'change_submit_review', 'change_submit_repair'];

function toolNames(ctx) {
  return [...ctx.tools.view().knownNames].sort();
}

async function compose(t, { withIntegration = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  const releaseCalls = [];
  const dispatchCalls = [];
  const listCalls = [];
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    claim: taskStore.claim.bind(taskStore),
    release: (...args) => { releaseCalls.push(args); return taskStore.release(...args); },
    updateIf: taskStore.updateIf.bind(taskStore),
    complete: taskStore.complete.bind(taskStore),
    list: (...args) => { listCalls.push(args); return taskStore.list(...args); },
    subscribe: taskStore.subscribe.bind(taskStore),
    resolveWorkerSpec: () => ({ name: 'worker', enabled: true, mode: 'session' }),
    createWorkerLauncher: () => ({ async launch() { return { launched: true }; } }),
    createDispatcher: () => ({
      dispatchOnce: async (input) => { dispatchCalls.push(input); return { dispatched: true }; },
    }),
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  if (withIntegration) await ctx.plugin(plugin);
  return { ctx, taskStore, releaseCalls, dispatchCalls, listCalls };
}

test('integration active: the model-facing surface exposes only narrow tools', async (t) => {
  const { ctx } = await compose(t);
  assert.deepEqual(toolNames(ctx), [...CHANGE_TOOLS, ...INTEGRATION_TOOLS].sort());
});

test('integration absent: neither integration tool exists', async (t) => {
  const { ctx } = await compose(t, { withIntegration: false });
  const names = toolNames(ctx);
  for (const n of INTEGRATION_TOOLS) assert.ok(!names.includes(n), `${n} must not exist without the integration package`);
});

test('governed_start_planning exposes only taskId and forwards the host exec unchanged', async () => {
  const exec = { agent: { id: 'trusted-controller' }, extra: { source: 'host' } };
  let received;
  const tool = createIntegrationTools({
    getChangeForTask: async () => null,
    bootstrapTask: async () => ({ ok: true }),
    startControllerOwnedPlanning: async (taskId, forwardedExec) => {
      received = { taskId, exec: forwardedExec };
      return { ok: true, sessionId: forwardedExec.agent.id };
    },
  }).find((entry) => entry.name === 'governed_start_planning');
  assert.ok(tool);
  assert.deepEqual(tool.parameters, { type: 'object', properties: { taskId: { type: 'string' } } });
  const result = await tool.execute({
    taskId: 'task-1', worker: 'spoof', sessionId: 'spoof', claimed_by: 'spoof',
    authenticatedSessionId: 'spoof', actor: 'spoof', captain: 'spoof',
  }, exec);
  assert.deepEqual(received, { taskId: 'task-1', exec });
  assert.equal(result.sessionId, 'trusted-controller');
});

test('governed_start_planning uses R1 through the registered wrapped service', async (t) => {
  const { ctx, taskStore } = await compose(t);
  const task = await taskStore.create({ title: 'controller startup', status: 'ready' });
  const tools = ctx.tools.view().visible;
  await tools.get('change_bootstrap_task').execute({ taskId: task.id }, {});
  const tool = tools.get('governed_start_planning');
  await assert.rejects(
    tool.execute({ taskId: task.id }, { agent: {} }),
    (error) => error?.code === 'AUTHENTICATED_SESSION_REQUIRED',
  );
  assert.equal(taskStore.get(task.id).claimed_by, null);
  const exec = { agent: { id: 'trusted-controller' }, spoof: 'ignored' };
  const result = await tool.execute({ taskId: task.id, worker: 'spoof', sessionId: 'spoof' }, exec);
  assert.equal(result.sessionId, 'trusted-controller');
  assert.equal(taskStore.get(task.id).claimed_by, 'trusted-controller');
  const change = (await tools.get('change_for_task').execute({ taskId: task.id }, {})).change;
  const binding = await ctx.get('changeControl').getBinding(change.id, 'trusted-controller');
  assert.equal(binding.role, 'planner');
  const replay = await tool.execute({ taskId: task.id }, exec);
  assert.equal(replay.sessionId, 'trusted-controller');
});

test('composed tool startup drives automatic R2 handoff and one governed dispatch', async (t) => {
  const { ctx, taskStore, releaseCalls, dispatchCalls, listCalls } = await compose(t);
  const task = await taskStore.create({ title: 'composed startup', status: 'ready', worker_profile: 'worker' });
  const tools = ctx.tools.view().visible;
  const requests = [];
  const checkpoints = [];
  const dispose = ctx.events.on('task-change-control/handoff-requested', (payload) => { checkpoints.push('handoff-requested'); requests.push(payload); });
  const disposePlan = ctx.events.on('change-control/plan-accepted', () => checkpoints.push('plan-accepted'));
  t.after(() => { dispose?.(); disposePlan?.(); });
  const boot = await tools.get('change_bootstrap_task').execute({ taskId: task.id }, {});
  const exec = { agent: { id: 'controller-S' } };
  await tools.get('governed_start_planning').execute({ taskId: task.id, worker: 'spoof', sessionId: 'spoof', claimed_by: 'spoof' }, exec);
  assert.equal(taskStore.get(task.id).claimed_by, 'controller-S');
  const binding = await ctx.get('changeControl').getBinding(boot.change.id, 'controller-S');
  assert.equal(binding.role, 'planner');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests.length, 0, 'R2 must not hand off before READY');

  const plan = await ctx.get('changeControl').submitPlan(boot.change.id, { steps: ['accept'] });
  await ctx.get('changeControl').acceptPlan(boot.change.id, plan.id, { authorized: true, actor: 'host' });
  await taskStore.update(task.id, { title: 'composed startup ready' });
  assert.equal(taskStore.get(task.id).status, 'claimed');
  const deadline = Date.now() + 1000;
  while (releaseCalls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(taskStore.get(task.id).claimed_by, null, `consumer releases the controller claim after automatic handoff; checkpoints=${checkpoints.join(',')},listCalls=${listCalls.length}`);
  assert.equal(releaseCalls.length, 1, 'consumer release path runs exactly once');
  assert.equal(dispatchCalls.length, 1, 'consumer invokes governed dispatch once');
  await taskStore.update(task.id, { status: 'ready' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dispatchCalls.length, 1, 'duplicate reconciliation is deduplicated');
});

test('no generic change_create or change_bind tool exists anywhere in the workspace', async () => {
  const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const repoRoot = join(pkgRoot, '..', '..');
  async function* walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        yield* walk(full);
      } else if (/\.m?js$/.test(e.name)) yield full;
    }
  }
  const offenders = [];
  for await (const file of walk(join(repoRoot, 'packages'))) {
    const src = await readFile(file, 'utf8');
    if (/name:\s*['"]change_(create|bind)['"]/.test(src)) offenders.push(relative(repoRoot, file));
  }
  assert.deepEqual(offenders, [], `generic change tools forbidden: ${offenders.join(', ')}`);
});

test('change_for_task on an unlinked task returns a structured not-linked result', async (t) => {
  const { ctx, taskStore } = await compose(t);
  const task = await taskStore.create({ title: 'unlinked task' });
  const tool = ctx.tools.view().visible.get('change_for_task');
  assert.ok(tool, 'tool registered');
  const result = await tool.execute({ taskId: task.id }, {});
  assert.equal(result.linked, false);
  assert.equal(result.taskId, task.id);
  assert.equal(result.change, null);
});

test('tools reject blank taskId with INVALID_TASK_ID', async (t) => {
  const { ctx } = await compose(t);
  const tools = ctx.tools.view().visible;
  await assert.rejects(tools.get('change_for_task').execute({ taskId: '  ' }, {}), (e) => e.code === 'INVALID_TASK_ID');
  await assert.rejects(tools.get('change_bootstrap_task').execute({ taskId: '' }, {}), (e) => e.code === 'INVALID_TASK_ID');
});

test('change_bootstrap_task + change_for_task round-trip through the real registry', async (t) => {
  const { ctx, taskStore } = await compose(t);
  const task = await taskStore.create({ title: 'boot me', description: 'd', acceptance_criteria: ['a'] });
  const tools = ctx.tools.view().visible;
  const boot = await tools.get('change_bootstrap_task').execute({ taskId: task.id }, {});
  assert.ok(boot.change?.id);
  assert.equal(boot.change.title, 'boot me');
  const read = await tools.get('change_for_task').execute({ taskId: task.id }, {});
  assert.equal(read.linked, true);
  assert.equal(read.change.id, boot.change.id);
});

// The host materializes a successful tool result by calling output.render and
// treating the return value as an array of content blocks (ToolRuntime
// createSuccessResult -> content.map). Returning the raw value instead throws
// "content is not iterable" in the real host — which execute-level tests above
// cannot observe, because they never run the render step.
test('integration tools render an array of content blocks, never a raw value', async (t) => {
  const { ctx, taskStore } = await compose(t);
  const task = await taskStore.create({ title: 'render contract', status: 'ready' });
  const visible = ctx.tools.view().visible;
  for (const name of INTEGRATION_TOOLS) {
    const definition = visible.get(name);
    assert.equal(typeof definition.output?.render, 'function', `${name} declares a renderer`);
    const args = { taskId: task.id };
    if (name === 'governed_start_planning') {
      await visible.get('change_bootstrap_task').execute(args, {});
    }
    const value = await definition.execute(args, name === 'governed_start_planning' ? { agent: { id: 'render-controller' } } : {});
    const rendered = definition.output.render(args, value);
    assert.ok(Array.isArray(rendered), `${name}.output.render must return an array of content blocks`);
    assert.ok(rendered.length > 0, `${name}.output.render must return at least one content block`);
    for (const block of rendered) {
      assert.equal(block.type, 'text', `${name}.output.render blocks must be text blocks`);
      assert.equal(typeof block.text, 'string', `${name}.output.render block text must be a string`);
    }
    const text = rendered.map((block) => block.text).join('\n');
    assert.equal(text, JSON.stringify(value, null, 2), `${name} must render the produced value, not discard it`);
  }
});
