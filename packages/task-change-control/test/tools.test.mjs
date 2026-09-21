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

const SYSTEM = 'dsh-task-orchestrator';
const INTEGRATION_TOOLS = ['change_bootstrap_task', 'change_for_task'];
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
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  if (withIntegration) await ctx.plugin(plugin);
  return { ctx, taskStore };
}

test('integration active: the model-facing Change surface is exactly seven narrow tools', async (t) => {
  const { ctx } = await compose(t);
  const changeTools = toolNames(ctx).filter((name) => name.startsWith('change_'));
  assert.deepEqual(changeTools, [...CHANGE_TOOLS, ...INTEGRATION_TOOLS].sort());
  assert.equal(changeTools.length, 7);
});

test('integration absent: neither integration tool exists', async (t) => {
  const { ctx } = await compose(t, { withIntegration: false });
  const names = toolNames(ctx);
  for (const n of INTEGRATION_TOOLS) assert.ok(!names.includes(n), `${n} must not exist without the integration package`);
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
  const task = await taskStore.create({ title: 'render contract' });
  const visible = ctx.tools.view().visible;
  for (const name of INTEGRATION_TOOLS) {
    const definition = visible.get(name);
    assert.equal(typeof definition.output?.render, 'function', `${name} declares a renderer`);
    const args = { taskId: task.id };
    const value = await definition.execute(args, {});
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
