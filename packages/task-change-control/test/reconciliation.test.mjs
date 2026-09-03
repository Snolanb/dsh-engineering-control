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

async function compose(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-reconcile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    updateIf: (id, expected, patch) => taskStore.updateIf(id, expected, patch),
    complete: taskStore.complete.bind(taskStore),
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);
  return { ctx, taskStore, dir };
}

function proofFor(commitSha) {
  return {
    beforeRevision: 'pre', afterRevision: commitSha,
    commit_sha: commitSha, files_changed: ['src/x.js'], tests_run: ['x.test'],
    remaining_blockers: [], criteria: [{ id: 'ship', satisfied: true }],
    deviations: [], workerChecks: ['ok'], controllerPreflight: ['yes'], summary: 's',
  };
}

async function governedRunning(ctx, taskStore, dir, { leaseSeconds = 300 } = {}) {
  const task = await taskStore.create({
    title: 'governed', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['ship'],
  });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
  const runId = 'worker:run-reconcile';
  assert.ok((await taskStore.claim(task.id, runId, { lease_seconds: leaseSeconds })).claimed);
  await taskStore.start(task.id, runId, {});
  await ctx.changeControl.bindRole(change.id, 'sess-recon', 'worker', { worker: runId });
  return { task, change, runId };
}

test('orphan binding after task terminal → auto-repaired with audit record', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change, runId } = await governedRunning(ctx, taskStore, dir);
  await ctx.taskChangeControl.completeGovernedTask(task.id, { sessionId: 'sess-recon', worker: runId, proof: proofFor('done-real') });
  // Binding remains — orphaned.
  const report = await ctx.taskChangeControl.reconcileTaskChange(task.id);
  assert.ok(Array.isArray(report.repairs));
  assert.ok(report.repairs.some((r) => r.kind === 'orphan_binding_unbound'));
  const remaining = await ctx.changeControl.listRoleBindings();
  assert.ok(!remaining.some((b) => b.sessionId === 'sess-recon'), 'binding removed');
  const audit = await ctx.changeControl.history(change.id);
  assert.ok(audit.some((e) => e.kind === 'reconciliation' || e.type === 'reconciliation'));
});

test('projection mismatch fields on completed task are re-aligned to Change proof with audit', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change, runId } = await governedRunning(ctx, taskStore, dir);
  const proof = proofFor('deadbeef');
  await ctx.changeControl.submitProof(change.id, proof, { sessionId: 'sess-recon', expectedWorker: runId });
  await taskStore.complete(task.id, { commit_sha: 'WRONG', files_changed: [], tests_run: [], remaining_blockers: [] }, { worker: runId });
  const report = await ctx.taskChangeControl.reconcileTaskChange(task.id);
  assert.ok(report.repairs.some((r) => r.kind === 'projection_mismatch'));
  const after = await taskStore.get(task.id);
  assert.equal(after.commit_sha, 'deadbeef');
  assert.ok(report.manualIntervention.length === 0);
});

test('half-completed governed completion (Change PREFLIGHT, task running, lease dead) converges task to in_review', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change, runId } = await governedRunning(ctx, taskStore, dir, { leaseSeconds: 1 });
  await ctx.changeControl.submitProof(change.id, proofFor('half1'), { sessionId: 'sess-recon', expectedWorker: runId });
  // Real lease expiry: 1s lease, sleep past it, then reconcile live.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const rr = await ctx.taskChangeControl.reconcileTaskChange(task.id);
  const after = await taskStore.get(task.id);
  assert.equal(after.status, 'in_review');
});

test('two nonterminal Changes on the same task → manual intervention, zero mutations', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({ title: 'u', description: 'd', status: 'ready', workspace: dir });
  const { change: legit } = await ctx.taskChangeControl.bootstrapTask(task.id);
  // Directly duplicate the persisted change record with a new id — this
  // simulates A SECOND store instance writing against the same JSON file
  // without going through findOrCreateForWorkItem.
  const file = join(dir, 'changes.json');
  const { readFile, writeFile } = await import('node:fs/promises');
  const data = JSON.parse(await readFile(file, 'utf8'));
  const rogue = structuredClone(data.changes.find((c) => c.workItem?.id === task.id));
  assert.ok(rogue, 'legit change present on disk');
  rogue.id = crypto.randomUUID();
  rogue.title = 'rogue';
  rogue.revision = null; // derive itself
  data.changes.push(rogue);
  await writeFile(file, JSON.stringify(data));
  const report = await ctx.taskChangeControl.reconcileTaskChange(task.id);
  assert.ok(report.manualIntervention.some((m) => m.issue === 'MULTIPLE_CHANGES'));
  assert.ok(report.repairs.length === 0);
  assert.equal((await taskStore.get(task.id)).status, 'ready', 'no mutation');
  assert.ok((await ctx.changeControl.get(legit.id))?.state === 'DRAFT', 'legit change unmodified');
});

test('reconciliation is idempotent', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change, runId } = await governedRunning(ctx, taskStore, dir);
  await ctx.changeControl.submitProof(change.id, proofFor('defer'), { sessionId: 'sess-recon', expectedWorker: runId });
  await taskStore.update(task.id, { acceptance_criteria: ['ship'] });
  await taskStore.complete(task.id, { commit_sha: 'BADVAL' }, { worker: runId });
  await ctx.taskChangeControl.reconcileTaskChange(task.id); // repair happens
  const r2 = await ctx.taskChangeControl.reconcileTaskChange(task.id);
  assert.ok(r2.repairs.length === 0, 'second run finds nothing to repair');
});

test('reclaimer race: a reclaim after initial read must not be clobbered by convergence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    updateIf: (id, expected, patch) => taskStore.updateIf(id, expected, patch),
    complete: taskStore.complete.bind(taskStore),
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);

  const task = await taskStore.create({ title: 'g', description: 'd', status: 'ready', workspace: dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});

  // First claim is BRIEF (1s).
  assert.ok((await taskStore.claim(task.id, 'w1', { lease_seconds: 1 })).claimed);
  await taskStore.start(task.id, 'w1', {});
  await ctx.changeControl.bindRole(change.id, 'sess-w1', 'worker', { worker: 'w1' });
  await ctx.changeControl.submitProof(change.id, {
    beforeRevision: 'b', afterRevision: 'x', commit_sha: 'c', files_changed: [], tests_run: [], remaining_blockers: [],
    criteria: [{ id: 'ship', satisfied: true }], deviations: [], workerChecks: [], controllerPreflight: [], summary: 's',
  }, { sessionId: 'sess-w1', expectedWorker: 'w1' });

  // Wait for the lease to expire, then reclaim as a different worker.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const reclaim = await taskStore.claim(task.id, 'w2', { lease_seconds: 300 });
  assert.ok(reclaim.claimed, 'reclaim succeeds once the first lease has passed');
  await taskStore.start(task.id, 'w2', {});

  const report = await ctx.taskChangeControl.reconcileTaskChange(task.id);
  assert.equal(report.repairs.length, 0, 'no repair on a reclaimed task (fresh live lease)');
  const finalTask = await taskStore.get(task.id);
  assert.equal(finalTask.status, 'running');
  assert.equal(finalTask.claimed_by, 'w2');
});

test('terminal-task + terminal Change with orphan worker binding → audited cleanup', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change, runId } = await governedRunning(ctx, taskStore, dir);
  await ctx.changeControl.submitProof(change.id, proofFor('approved-ready'), { sessionId: 'sess-recon', expectedWorker: runId });
  // Drive PREFLIGHT → REVIEW → APPROVED via transitions and the review
  // record. (Policy-only gate `runPreflight` needs an external policy.)
  await ctx.changeControl.transition(change.id, 'REVIEW', {});
  await ctx.changeControl.transition(change.id, 'APPROVED', {});
  await taskStore.complete(task.id, { commit_sha: 'approved-ready' }, { worker: runId });
  const report = await ctx.taskChangeControl.reconcileTaskChange(task.id);
  assert.ok(report.repairs.length > 0, 'orphan worker bindings on terminal changes STILL get cleaned');
  const bindings = await ctx.changeControl.listRoleBindings();
  assert.ok(!bindings.some((b) => b.changeId === change.id && b.role === 'worker'));
});

test('reviewer bindings on in_review tasks survive reconciliation', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change, runId } = await governedRunning(ctx, taskStore, dir);
  await ctx.changeControl.bindRole(change.id, 'sess-host', 'reviewer');
  await ctx.taskChangeControl.completeGovernedTask(task.id, { sessionId: 'sess-recon', worker: runId, proof: proofFor('ok-real') });
  const report = await ctx.taskChangeControl.reconcileTaskChange(task.id);
  // The reviewer binding stays.
  const bindings = await ctx.changeControl.listRoleBindings();
  assert.ok(bindings.some((b) => b.sessionId === 'sess-host'), 'reviewer binding is retained');
  const workerBindings = bindings.filter((b) => b.changeId === change.id && b.role === 'worker');
  assert.equal(workerBindings.length, 0, 'worker binding cleanups happen even without a thrown error');
});

test('running task + Change still in DRAFT → lifecycle mismatch recorded, no mutation', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({ title: 'g', description: 'd', status: 'ready', workspace: dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  await taskStore.claim(task.id, 'w-run', { lease_seconds: 300 });
  await taskStore.start(task.id, 'w-run', {});
  const report = await ctx.taskChangeControl.reconcileTaskChange(task.id);
  assert.ok(report.manualIntervention.some((m) => m.issue === 'LIFECYCLE_MISMATCH'));
  assert.ok(report.repairs.length === 0);
  assert.equal((await taskStore.get(task.id)).status, 'running');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'DRAFT');
});

test('in_review task with structured result while Change shows no proof → manual entry', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({ title: 'u', description: 'd', status: 'ready', workspace: dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  await ctx.taskChangeControl.bootstrapTask(task.id);
  await taskStore.claim(task.id, 'w', { lease_seconds: 300 });
  await taskStore.start(task.id, 'w', {});
  await taskStore.complete(task.id, { commit_sha: 'direct-results', files_changed: ['x'], tests_run: [], remaining_blockers: [] }, { worker: 'w' });
  const report = await ctx.taskChangeControl.reconcileTaskChange(task.id);
  assert.ok(report.manualIntervention.some((m) => m.issue === 'TASK_RESULT_WITHOUT_PROOF'));
  assert.ok(report.repairs.length === 0);
});

test('proof without alignment fields sits in manual Intervention (not reconciled)', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({ title: 'g', description: 'd', status: 'ready', workspace: dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
  assert.ok((await taskStore.claim(task.id, 'w-m', { lease_seconds: 1 })).claimed);
  await taskStore.start(task.id, 'w-m', {});
  await ctx.changeControl.bindRole(change.id, 'sess-m', 'worker', { worker: 'w-m' });
  await ctx.changeControl.submitProof(change.id, {
    beforeRevision: 'b', afterRevision: 'a',
    // commit_sha etc deliberately missing
    criteria: [{ id: 'ship', satisfied: true }],
    deviations: [], workerChecks: [], controllerPreflight: [], summary: 'plain',
  }, { sessionId: 'sess-m', expectedWorker: 'w-m' });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const report = await ctx.taskChangeControl.reconcileTaskChange(task.id);
  assert.ok(report.manualIntervention.some((m) => m.issue === 'PROOF_ALIGNMENT_INCOMPLETE'));
  assert.ok(report.repairs.length === 0);
  assert.equal((await taskStore.get(task.id)).status, 'running');
});
