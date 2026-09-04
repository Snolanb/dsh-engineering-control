// T10.1 — describeTaskGovernance projection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import changeControlPlugin from 'dsh-change-control';
import plugin from '../src/index.js';

async function compose(t) {
  const dir = mkdtempSync(join(tmpdir(), 't101-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, {});
  const ts = new TaskStore({ dbPath: join(dir, 't.db') });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: ts.get.bind(ts), update: ts.update.bind(ts),
    updateIf: (i, e, q) => ts.updateIf(i, e, q),
    complete: ts.complete.bind(ts),
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'c.json') });
  await ctx.plugin(plugin);
  return { ctx, dir, taskStore: ts };
}

test('ungoverned task → degraded projection { linked: false }', async (t) => {
  const { ctx, taskStore } = await compose(t);
  const task = await taskStore.create({ title: 'x', status: 'ready', workspace: '/tmp/x' });
  const out = await ctx.taskChangeControl.describeTaskGovernance(task.id);
  assert.equal(out.linked, false);
  assert.equal(out.changeId, null);
  assert.equal(out.state, null);
  assert.equal(out.risk, null);
  assert.equal(out.governanceMode, 'off');
});

test('governed task: projection surfaces changeId, state, risk, plan, preflight, openFindings, attempts', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({
    title: 'g', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'w', acceptance_criteria: ['ship it'],
  });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: [{ step: 's', rationale: 'r' }] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
  await taskStore.claim(task.id, 'w-pro', { lease_seconds: 300 });
  await taskStore.start(task.id, 'w-pro', {});
  await ctx.changeControl.bindRole(change.id, 'sess-w', 'worker', { worker: 'w-pro' });
  await ctx.changeControl.submitProof(change.id, {
    beforeRevision: 'b', afterRevision: 'a', commit_sha: 'cs', files_changed: ['f'], tests_run: ['t'],
    remaining_blockers: [], criteria: [{ id: 'ship it', satisfied: true }],
    deviations: [], workerChecks: ['ok'], controllerPreflight: ['pass: build'], summary: 'x',
  }, { sessionId: 'sess-w', expectedWorker: 'w-pro' });

  const out = await ctx.taskChangeControl.describeTaskGovernance(task.id);
  assert.equal(out.linked, true);
  assert.equal(out.changeId, change.id);
  assert.equal(out.state, 'PREFLIGHT');
  assert.ok(out.plan !== null);
  assert.equal(typeof out.openFindings, 'number');
  assert.equal(out.attempts.total, 1);
  assert.equal(out.attempts.repairs, 0);
  assert.equal(out.escalated, false);
});

test('unknown task: TASK_NOT_FOUND', async (t) => {
  const { ctx } = await compose(t);
  await assert.rejects(
    ctx.taskChangeControl.describeTaskGovernance('nope'),
    (e) => e.code === 'TASK_NOT_FOUND',
  );
});
