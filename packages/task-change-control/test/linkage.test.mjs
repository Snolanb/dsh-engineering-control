import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
// The Change side is composed through the REAL published plugin entry; its
// ChangeStore internals never cross the package boundary.
import changeControlPlugin from 'dsh-change-control';
import plugin from '../src/index.js';

const SYSTEM = 'dsh-task-orchestrator';

async function compose(t, { omitTask = false, omitChange = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-linkage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  let taskStore;
  if (!omitTask) {
    taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
    // Same frozen shape the task plugin puts on ctx.taskOrchestrator.
    ctx.provide('taskOrchestrator', Object.freeze({
      get: taskStore.get.bind(taskStore),
      update: taskStore.update.bind(taskStore),
    }));
  }
  if (!omitChange) {
    await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  }
  await ctx.plugin(plugin);
  return { ctx, dir, taskStore };
}

test('AC1: linking a Change projects changeId into real task metadata, durably', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({ title: 'linked task' });
  const change = await ctx.changeControl.findOrCreateForWorkItem({
    system: SYSTEM, id: task.id, change: { title: 'c', objective: 'o', acceptanceCriteria: [] },
  });
  const result = await ctx.taskChangeControl.linkTaskChange(task.id);
  assert.equal(result.changeId, change.id);
  const persisted = await ctx.taskOrchestrator.get(task.id);
  assert.equal(persisted.metadata?.changeControl?.changeId, change.id);
  // Durability: reopen the real SQLite store and read it again.
  const reopened = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  assert.equal((await reopened.get(task.id)).metadata.changeControl.changeId, change.id);
});

test('AC3: Change-side workItem wins over a stale projection, which is repaired', async (t) => {
  const { ctx, taskStore } = await compose(t);
  const task = await taskStore.create({ title: 'conflict task' });
  const canonical = await ctx.changeControl.findOrCreateForWorkItem({
    system: SYSTEM, id: task.id, change: { title: 'c', objective: 'o', acceptanceCriteria: [] },
  });
  // Plant a stale projection pointing somewhere else, then resolve.
  await ctx.taskOrchestrator.update(task.id, { metadata: { changeControl: { changeId: 'stale-id' } } });
  const resolved = await ctx.taskChangeControl.getChangeForTask(task.id);
  assert.equal(resolved?.id, canonical.id, 'Change-side workItem wins');
  // linkTaskChange repairs the stale projection to canonical.
  const relinked = await ctx.taskChangeControl.linkTaskChange(task.id);
  assert.equal(relinked.changeId, canonical.id);
  assert.equal((await ctx.taskOrchestrator.get(task.id)).metadata.changeControl.changeId, canonical.id);
});

test('AC4: omits taskOrchestrator — ops report LINKAGE_UNAVAILABLE, no corruption', async (t) => {
  const { ctx } = await compose(t, { omitTask: true });
  assert.throws(() => ctx.taskChangeControl.linkTaskChange('task-x'), (e) => e.code === 'LINKAGE_UNAVAILABLE');
  // changeControl unaffected: still fully functional.
  const created = await ctx.changeControl.create({ title: 'x', objective: 'y', acceptanceCriteria: [] });
  assert.ok(created.id);
});

test('AC4 mirror: omits changeControl — ops report LINKAGE_UNAVAILABLE', async (t) => {
  const { ctx } = await compose(t, { omitChange: true });
  assert.throws(() => ctx.taskChangeControl.getChangeForTask('task-x'), (e) => e.code === 'LINKAGE_UNAVAILABLE');
});
