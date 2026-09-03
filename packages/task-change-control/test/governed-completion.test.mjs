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
const WORKER_RUN = 'worker:run-c1';

async function compose(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-complete-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    complete: taskStore.complete.bind(taskStore),
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);
  return { ctx, taskStore, dir };
}

/** Create a task, bootstrap linkage + ready the Change, claim+start the task with worker Wsession. */
async function runningGovernedTask(ctx, taskStore, dir) {
  const task = await taskStore.create({
    title: 'governed', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['ship'],
  });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
  const runId = 'worker:run-c1';
  const claimed = await taskStore.claim(task.id, runId, { lease_seconds: 300, actor: 'host' });
  assert.ok(claimed.claimed);
  await taskStore.start(task.id, runId, { actor: 'host' });
  await ctx.changeControl.bindRole(change.id, 'sess-worker-1', 'worker', { worker: WORKER_RUN });
  return { task, change, runId };
}

test('expired/missing lease blocks completion (TASK_LEASE_INVALID, no mutation)', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({ title: 't', description: 'd', status: 'ready', workspace: dir });
  await assert.rejects(
    ctx.taskChangeControl.completeGovernedTask(task.id, { sessionId: 'sess', worker: 'w', proof: { summary: 'x' } }),
    (e) => e && (e.code === 'TASK_LEASE_INVALID' || e.code === 'SESSION_NOT_BOUND'),
  );
  const after = await taskStore.get(task.id);
  assert.equal(after.status, 'ready', 'claim state untouched');
});

test('governed completion without worker binding fails (SESSION_NOT_BOUND, no mutation)', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({ title: 'g', description: 'd', status: 'ready', workspace: dir, worker_profile: 'worker', acceptance_criteria: [] });
  await ctx.taskChangeControl.bootstrapTask(task.id);
  const claim = await taskStore.claim(task.id, 'w:1', { lease_seconds: 300 });
  assert.ok(claim.claimed);
  await taskStore.start(task.id, 'w:1', {});
  await assert.rejects(
    ctx.taskChangeControl.completeGovernedTask(task.id, { sessionId: 'unknown-session', worker: 'w:1', proof: { summary: 'x' } }),
    (e) => e && e.code === 'SESSION_NOT_BOUND',
  );
  const c2 = await taskStore.get(task.id);
  assert.equal(c2.status, 'running');
});

test('happy path: proof recorded, task → in_review, Change → PREFLIGHT; idempotent second call', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await runningGovernedTask(ctx, taskStore, dir);
  const proof = {
    beforeRevision: 'main@abc',
    afterRevision: 'abc123',
    commit_sha: 'abc123',
    files_changed: ['src/x.js'],
    tests_run: ['x.test'],
    remaining_blockers: [],
    criteria: [{ id: 'ship', satisfied: true }],
    deviations: [],
    workerChecks: ['tests green'],
    controllerPreflight: ['checked'],
    summary: 'implemented',
  };
  const res1 = await ctx.taskChangeControl.completeGovernedTask(task.id, { sessionId: 'sess-worker-1', worker: 'worker:run-c1', proof });
  assert.ok(res1.ok);
  const tAfter = await taskStore.get(task.id);
  assert.equal(tAfter.status, 'in_review');
  const s1 = await ctx.changeControl.status(change.id);
  assert.ok(s1.proof, 'proof recorded');
  assert.equal(await ctx.changeControl.get(change.id).then((c) => c.state), 'PREFLIGHT');
  assert.deepEqual(tAfter.commit_sha, 'abc123');
  assert.deepEqual(tAfter.files_changed, ['src/x.js']);

  // Idempotency: repeat call MUST be a no-op (no second proof, no duplicate events).
  const res2 = await ctx.taskChangeControl.completeGovernedTask(task.id, { sessionId: 'sess-worker-1', worker: 'worker:run-c1', proof });
  assert.ok(res2.ok);
  const s2 = await ctx.changeControl.status(change.id);
  assert.ok(s2.proof);
  const toPreflight = await ctx.changeControl.history(change.id).then((h) => h.filter((e) => e.to === 'PREFLIGHT'));
  assert.equal(toPreflight.length, 1, 'PREFLIGHT transition recorded exactly once across both calls');
  const proofs = await ctx.changeControl.status(change.id).then((s) => s.proof);
  assert.ok(proofs);
});

test('ungoverned task: raw task_complete path unchanged', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({ title: 'u', description: 'd', status: 'ready', workspace: dir });
  const claim = await taskStore.claim(task.id, 'w:ung', { lease_seconds: 60 });
  await taskStore.start(task.id, 'w:ung', {});
  await taskStore.complete(task.id, { result_summary: 'done' }, { worker: 'w:ung' });
  assert.equal((await taskStore.get(task.id)).status, 'in_review');
});

test('worker structured result aligns with the stored proof bundle', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await runningGovernedTask(ctx, taskStore, dir);
  const proof = {
    beforeRevision: 'main@def',
    afterRevision: 'def456',
    commit_sha: 'def456',
    files_changed: ['a.js', 'b.js'],
    tests_run: ['a.test.mjs'],
    remaining_blockers: [],
    criteria: [{ id: 'ship', satisfied: true }],
    deviations: [],
    workerChecks: ['aligned'],
    controllerPreflight: ['checked'],
    summary: 'aligned',
  };
  await ctx.taskChangeControl.completeGovernedTask(task.id, { sessionId: 'sess-worker-1', worker: 'worker:run-c1', proof });
  const [tAfter, status] = await Promise.all([taskStore.get(task.id), ctx.changeControl.status(change.id)]);
  assert.equal(tAfter.commit_sha, status.proof.commit_sha);
  assert.deepEqual(tAfter.files_changed, status.proof.files_changed);
  assert.deepEqual(tAfter.tests_run, status.proof.tests_run);
  assert.deepEqual(tAfter.remaining_blockers, status.proof.remaining_blockers);
});
