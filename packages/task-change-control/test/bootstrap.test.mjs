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
import plugin from '../src/index.js';

const SYSTEM = 'dsh-task-orchestrator';

async function compose(t, storePath, dbPath) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
  }));
  await ctx.plugin(changeControlPlugin, { storePath });
  await ctx.plugin(plugin);
  return { ctx, taskStore };
}

async function composeFresh(t, dir) {
  return compose(t, join(dir, 'changes.json'), join(dir, 'tasks.db'));
}

const TASK_INPUT = {
  title: 'canonical title',
  description: 'canonical objective body',
  acceptance_criteria: ['ac-1', 'ac-2'],
  workspace: '/ws', repo: 'org/repo', branch: 'feat/x',
  task_type: 'story', project_id: null, milestone_id: null,
};

async function makeTask(taskStore) {
  const t = await taskStore.create({ ...TASK_INPUT });
  return t.id;
}

test('spoofed overrides are ignored: bootstrap snapshots the canonical task record', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { ctx, taskStore } = await composeFresh(t, dir);
  const taskId = await makeTask(taskStore);
  const { change } = await ctx.taskChangeControl.bootstrapTask(taskId, {
    title: 'SPOOFED', objective: 'SPOOFED', acceptanceCriteria: ['SPOOFED'],
  });
  assert.equal(change.title, 'canonical title');
  assert.equal(change.objective, 'canonical objective body');
  assert.deepEqual(change.acceptanceCriteria, ['ac-1', 'ac-2']);
  assert.equal(JSON.stringify(change).includes('SPOOFED'), false);
});

test('idempotent: sequential and concurrent bootstraps return the same Change', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { ctx, taskStore } = await composeFresh(t, dir);
  const taskId = await makeTask(taskStore);
  const first = await ctx.taskChangeControl.bootstrapTask(taskId);
  const again = await ctx.taskChangeControl.bootstrapTask(taskId);
  assert.equal(again.change.id, first.change.id);
  const [c1, c2] = await Promise.all([
    ctx.taskChangeControl.bootstrapTask(taskId),
    ctx.taskChangeControl.bootstrapTask(taskId),
  ]);
  assert.equal(c1.change.id, first.change.id);
  assert.equal(c2.change.id, first.change.id);
});

test('fresh bootstrap yields DRAFT, no plan, no role bindings, projection written', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { ctx, taskStore } = await composeFresh(t, dir);
  const taskId = await makeTask(taskStore);
  const { change } = await ctx.taskChangeControl.bootstrapTask(taskId);
  assert.equal(change.state, 'DRAFT');
  const status = await ctx.changeControl.status(change.id);
  assert.equal(status.acceptedPlan, null);
  assert.equal(status.bindings.length, 0);
  assert.deepEqual(change.workItem, { system: SYSTEM, id: taskId });
  const task = await ctx.taskOrchestrator.get(taskId);
  assert.equal(task.metadata.changeControl.changeId, change.id);
});

test('TASK_NOT_FOUND for nonexistent task; no Change is created', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { ctx } = await composeFresh(t, dir);
  await assert.rejects(
    ctx.taskChangeControl.bootstrapTask('no-such-task'),
    (e) => e.code === 'TASK_NOT_FOUND'
  );
  assert.equal(await ctx.changeControl.findByWorkItem(SYSTEM, 'no-such-task'), null);
});

test('service rejects blank taskId; linkTaskChange on a deleted task yields TASK_NOT_FOUND (not TypeError)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { ctx, taskStore } = await composeFresh(t, dir);
  assert.throws(() => ctx.taskChangeControl.bootstrapTask('   '), (e) => e.code === 'INVALID_TASK_ID');
  const task = await taskStore.create({ title: 'x' });
  await ctx.taskChangeControl.bootstrapTask(task.id);
  await taskStore.delete(task.id);
  await assert.rejects(
    ctx.taskChangeControl.linkTaskChange(task.id),
    (e) => e.code === 'TASK_NOT_FOUND'
  );
});

test('padded taskId is rejected before any Change-side call (no split-brain duplicates)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { ctx, taskStore } = await composeFresh(t, dir);
  const task = await taskStore.create({ title: 'pad victim' });
  assert.throws(
    () => ctx.taskChangeControl.bootstrapTask(` ${task.id} `),
    (e) => e.code === 'INVALID_TASK_ID'
  );
  // Only the canonical id works, and it yields exactly one Change.
  const first = await ctx.taskChangeControl.bootstrapTask(task.id);
  const again = await ctx.taskChangeControl.bootstrapTask(task.id);
  assert.equal(again.change.id, first.change.id);
});

test('cross-boundary persistence: link survives full recomposition against the same files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { ctx, taskStore } = await composeFresh(t, dir);
  const taskId = await makeTask(taskStore);
  const { change } = await ctx.taskChangeControl.bootstrapTask(taskId);
  // Terminate everything; recompose a fresh Cordis host over the SAME files.
  const { ctx: ctx2, } = await compose(t, join(dir, 'changes.json'), join(dir, 'tasks.db'));
  const found = await ctx2.changeControl.findByWorkItem(SYSTEM, taskId);
  assert.equal(found?.id, change.id);
  const resolved = await ctx2.taskChangeControl.getChangeForTask(taskId);
  assert.equal(resolved?.id, change.id);
});
