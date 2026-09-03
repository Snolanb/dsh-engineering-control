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

async function compose(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tcc-t82-'));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, {});
  const taskStore = new TaskStore({ dbPath: join(dir, 't.db') });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    updateIf: (id, e, p) => taskStore.updateIf(id, e, p),
    complete: taskStore.complete.bind(taskStore),
    createReviewerLauncher: () => ({
      async launch() { return { sessionId: 'sess-review-x' }; },
    }),
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);
  return { ctx, taskStore, dir };
}

function proof(commit) {
  return {
    beforeRevision: 'b', afterRevision: 'a',
    commit_sha: commit, files_changed: ['f'], tests_run: ['t'], remaining_blockers: [],
    criteria: [{ id: 'ship', satisfied: true }],
    deviations: [], workerChecks: ['ok'], controllerPreflight: ['ok'],
    summary: 'done',
  };
}

async function governedToPreflight(ctx, taskStore, dir, worker = 'w-run') {
  const task = await taskStore.create({ title: 'g', description: 'd', status: 'ready', workspace: dir, worker_profile: worker, acceptance_criteria: ['ship'] });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
  await taskStore.claim(task.id, worker, { lease_seconds: 300 });
  await taskStore.start(task.id, worker, {});
  await ctx.changeControl.bindRole(change.id, 'sess-work', 'worker', { worker });
  await ctx.changeControl.submitProof(change.id, proof('commit1'), { sessionId: 'sess-work', expectedWorker: worker });
  return { task, change };
}

test('preflight pass → REVIEW + reviewer session bound (task untouched)', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await governedToPreflight(ctx, taskStore, dir);
  await taskStore.complete(task.id, { commit_sha: 'commit1', files_changed: ['f'], tests_run: ['t'], remaining_blockers: [] }, { worker: 'w-run' });
  const out = await ctx.taskChangeControl.runGovernedReview(task.id);
  assert.equal(out.outcome, 'review_started');
  const ch = await ctx.changeControl.get(change.id);
  assert.equal(ch.state, 'REVIEW');
  const b = (await ctx.changeControl.listRoleBindings()).find((bb) => bb.changeId === change.id && bb.sessionId === out.sessionId);
  assert.equal(b.role, 'reviewer');
});

test('exhausted preflight (missing controller pass) does NOT move Change to REVIEW', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await governedToPreflight(ctx, taskStore, dir);
  // corrrupt preflight
  await ctx.changeControl.unbindRole(change.id, 'sess-work');
  await taskStore.complete(task.id, { commit_sha: 'commit1', files_changed: [], tests_run: [], remaining_blockers: [] }, { worker: 'w-run' });
  const out = await ctx.taskChangeControl.runGovernedReview(task.id, { preflight: () => false });
  assert.equal(out.outcome, 'preflight_failed');
  const ch = await ctx.changeControl.get(change.id);
  assert.equal(ch.state, 'PREFLIGHT');
});

test('review pass → APPROVED + task done (atomic)', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await governedToPreflight(ctx, taskStore, dir);
  await taskStore.complete(task.id, { commit_sha: 'c1', files_changed: ['f'], tests_run: ['t'], remaining_blockers: [] }, { worker: 'w-run' });
  const rv = await ctx.taskChangeControl.runGovernedReview(task.id);
  assert.equal(rv.outcome, 'review_started');
  const finish = await ctx.taskChangeControl.applyReviewOutcome(task.id, {
    sessionId: rv.sessionId, verdict: 'pass', revision: 'a',
  });
  assert.equal(finish.outcome, 'approved');
  assert.equal((await taskStore.get(task.id)).status, 'done');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'APPROVED');
});

test('review fail → REPAIR + task changes_requested', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await governedToPreflight(ctx, taskStore, dir);
  await taskStore.complete(task.id, { commit_sha: 'c1', files_changed: ['f'], tests_run: ['t'], remaining_blockers: [] }, { worker: 'w-run' });
  const rv = await ctx.taskChangeControl.runGovernedReview(task.id);
  const finish = await ctx.taskChangeControl.applyReviewOutcome(task.id, {
    sessionId: rv.sessionId, verdict: 'fail',
    findings: [{ severity: 'critical', category: 'test', location: 'x', problem: 'broke', fix: 'fix', requiredOutcome: 'pass next round' }],
  });
  assert.equal(finish.outcome, 'repair');
  assert.equal((await taskStore.get(task.id)).status, 'changes_requested');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'REPAIR');
});

test('repair loop is bounded by escalation threshold', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change } = await governedToPreflight(ctx, taskStore, dir);
  await taskStore.complete(task.id, { commit_sha: 'c1', files_changed: ['f'], tests_run: ['t'], remaining_blockers: [] }, { worker: 'w-run' });
  let rv = await ctx.taskChangeControl.runGovernedReview(task.id);
  let finish = await ctx.taskChangeControl.applyReviewOutcome(task.id, {
    sessionId: rv.sessionId, verdict: 'fail',
    findings: [{ severity: 'critical', category: 't', location: 'x', problem: 'broke', fix: 'fix', requiredOutcome: 'pass next round' }],
  });
  assert.equal(finish.outcome, 'repair');
  const repair = await ctx.taskChangeControl.prepareRepairAttempt(task.id);
  assert.equal(repair.status, 'ready');

  // Second governed sub-run on the SAME task+Change identities with a fresh
  // attempt recorded. Escalation threshold 1: a SECOND fail must escalate.
  const { task: task2, change: change2 } = await governedToPreflight(ctx, taskStore, dir, 'w-run-2');
  await taskStore.complete(task2.id, { commit_sha: 'c2', files_changed: ['f'], tests_run: ['t'], remaining_blockers: [] }, { worker: 'w-run-2' });
  const rv2 = await ctx.taskChangeControl.runGovernedReview(task2.id);
  const escalated = await ctx.taskChangeControl.applyReviewOutcome(task2.id, {
    sessionId: rv2.sessionId, verdict: 'fail', maxRepairRounds: 1,
    findings: [{ severity: 'critical', category: 't', location: 'x', problem: 'broke', fix: 'fix', requiredOutcome: 'pass' }],
  });
  assert.equal(escalated.outcome, 'escalated');
  assert.equal((await taskStore.get(task2.id)).status, 'failed');
  assert.ok(['REPAIR', 'REJECTED'].includes((await ctx.changeControl.get(change2.id)).state));
});
