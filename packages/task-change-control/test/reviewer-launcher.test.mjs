import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import changeControlPlugin from 'dsh-change-control';
import plugin from '../src/index.js';

async function compose(t, { withReviewerLauncher = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tcc-t81-'));
  t.after(() => { /* tmp */ });
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, {});
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  const facade = {
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    updateIf: (id, e, p) => taskStore.updateIf(id, e, p),
    complete: taskStore.complete.bind(taskStore),
  };
  if (withReviewerLauncher) {
    facade.createReviewerLauncher = () => ({
      async launch({ task, spec }) {
        return { sessionId: 'sess-rev-true', handle: { sessionId: 'sess-rev-true' } };
      },
    });
  }
  ctx.provide('taskOrchestrator', Object.freeze(facade));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);
  return { ctx, taskStore, dir };
}

test('launchReviewer: task lease untouched; binding lands as reviewer with REAL sessionId', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({
    title: 'g', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', reviewer_profile: 'code-reviewer',
    acceptance_criteria: ['x'],
  });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const leaseBefore = (await taskStore.get(task.id)).lease_expires_at ?? null;
  const claimedBefore = (await taskStore.get(task.id)).claimed_by ?? null;

  const { sessionId, changeId, binding } = await ctx.taskChangeControl.launchReviewer(task.id);
  const after = await taskStore.get(task.id);
  assert.equal(after.lease_expires_at ?? null, leaseBefore);
  assert.equal(after.claimed_by ?? null, claimedBefore);
  assert.equal(sessionId, 'sess-rev-true');
  assert.equal(changeId, change.id);
  assert.equal(binding.role, 'reviewer');
  const stored = await ctx.changeControl.listRoleBindings();
  assert.ok(stored.some((b) => b.changeId === change.id && b.sessionId === 'sess-rev-true' && b.role === 'reviewer'));
});

test('launchReviewer without launcher support fails REVIEWER_LAUNCHER_UNAVAILABLE', async (t) => {
  const { ctx, taskStore, dir } = await compose(t, { withReviewerLauncher: false });
  const task = await taskStore.create({ title: 'x', description: 'd', status: 'ready', workspace: dir, worker_profile: 'w', acceptance_criteria: ['a'] });
  await ctx.taskChangeControl.bootstrapTask(task.id);
  await assert.rejects(
    ctx.taskChangeControl.launchReviewer(task.id),
    (e) => e && e.code === 'REVIEWER_LAUNCHER_UNAVAILABLE',
  );
});

test('launchReviewer without a Change fails CHANGE_NOT_FOUND', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({ title: 'x', description: 'd', status: 'ready', workspace: dir, worker_profile: 'w', acceptance_criteria: ['a'] });
  await assert.rejects(
    ctx.taskChangeControl.launchReviewer(task.id),
    (e) => e && e.code === 'CHANGE_NOT_FOUND',
  );
});

test('reviewer role cannot submit proof (read-only gate)', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({ title: 'g', description: 'd', status: 'ready', workspace: dir, worker_profile: 'w', acceptance_criteria: ['a'] });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
  const { sessionId } = await ctx.taskChangeControl.launchReviewer(task.id);
  await assert.rejects(
    ctx.changeControl.submitProof(change.id, {
      beforeRevision: 'a', afterRevision: 'b', commit_sha: 'x',
      files_changed: [], tests_run: [], remaining_blockers: [],
      criteria: [{ id: 'a', satisfied: true }],
      deviations: [], workerChecks: [], controllerPreflight: [], summary: 'x',
    }, { sessionId }),
    (e) => e && /not bound as worker/.test(String(e?.message ?? '')) || e?.code === 'SESSION_WORKER_MISMATCH',
  );
});
