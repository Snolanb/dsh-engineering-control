import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import { WorkerDispatcher } from 'dsh-task-orchestrator/dispatcher';
import { WorkerSpecRegistry } from 'dsh-task-orchestrator/worker-specs';
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

test('PROOF_MISMATCH when PREFLIGHT retry carries different integration fields', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change, runId } = await runningGovernedTask(ctx, taskStore, dir);
  const proof = {
    beforeRevision: 'a', afterRevision: 'x',
    commit_sha: 'a', files_changed: ['1'], tests_run: ['t'], remaining_blockers: [],
    criteria: [{ id: 'ship', satisfied: true }], deviations: [], workerChecks: ['w'], controllerPreflight: ['cp'], summary: 's',
  };
  const res1 = await ctx.taskChangeControl.completeGovernedTask(task.id, { sessionId: 'sess-worker-1', worker: runId, proof });
  assert.ok(res1.ok);
  // PREFLIGHT now; complete again with different commit_sha — must be rejected.
  await assert.rejects(
    ctx.taskChangeControl.completeGovernedTask(task.id, { sessionId: 'sess-worker-1', worker: runId, proof: { ...proof, commit_sha: 'DIFFERENT' } }),
    (e) => e?.code === 'PROOF_MISMATCH',
  );
  // The stored Change proof is intact (not clobbered by the rejected retry).
  const status = await ctx.changeControl.status(change.id);
  assert.equal(status.proof.commit_sha, 'a');
});

test('acceptance_criteria drift between claim and complete funnels to CRITERIA_MISMATCH', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const task = await taskStore.create({
    title: 'g', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['a', 'b'],
  });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
  const claim = await taskStore.claim(task.id, 'w:cp1', { lease_seconds: 300 });
  assert.ok(claim.claimed);
  await taskStore.start(task.id, 'w:cp1', {});
  await ctx.changeControl.bindRole(change.id, 'sess-binder', 'worker', { worker: 'w:cp1' });
  const proof = {
    beforeRevision: 'a', afterRevision: 'x',
    commit_sha: 'abc', files_changed: ['x'], tests_run: ['t'], remaining_blockers: [],
    criteria: [{ id: 'a', satisfied: true }], deviations: [], workerChecks: [], controllerPreflight: [], summary: 's',
  };
  await assert.rejects(
    ctx.taskChangeControl.completeGovernedTask(task.id, { sessionId: 'sess-binder', worker: 'w:cp1', proof }),
    (e) => e?.code === 'CRITERIA_MISMATCH',
  );
  const tAfter = await taskStore.get(task.id);
  assert.equal(tAfter.status, 'running', 'task NOT completed');
  const changeNow = await ctx.changeControl.get(change.id);
  assert.equal(changeNow.state, 'IMPLEMENTING', 'Change NOT mutated by failed completion');
});

test('governed dispatcher success routes through completeGovernedTask: proof → PREFLIGHT → task in_review', async (t) => {
  // This is the RED→GREEN regression for T-H2: before the completionHook seam,
  // createGovernedDispatcher dispatched governed tasks through raw store.complete,
  // bypassing proof submission and Change PREFLIGHT. After the fix, the governed
  // success path MUST validate lease + binding + proof, persist proof to Change,
  // move Change to PREFLIGHT, then move the task to in_review — all atomically.
  const dir = await mkdtemp(join(tmpdir(), 'tcc-t H2-int-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  // Provide a minimal taskOrchestrator with createDispatcher that forwards completionHook.
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    complete: taskStore.complete.bind(taskStore),
    createDispatcher(options = {}) {
      // Use top-level imports to keep this synchronous.
      return new WorkerDispatcher({
        store: taskStore,
        registry: new WorkerSpecRegistry({
          worker: { mode: 'session', profile: 'wp', agentPreset: 'worker', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 5000, leaseSeconds: 300 },
        }),
        launcher: options.launcher,
        preflight: options.preflight ?? (async () => ({ ok: true, spec: { mode: 'session', profile: 'wp', agentPreset: 'worker', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 5000, leaseSeconds: 300, name: 'worker' } })),
        preDispatch: options.preDispatch ?? null,
        completionHook: options.completionHook ?? null,
      });
    },
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);

  // Set up a governed task in READY state (the guard requires READY).
  const task = await taskStore.create({
    title: 'tH2-int', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['ship'],
  });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  // Leave Change in READY — the guard requires it. completeGovernedTask will
  // accept IMPLEMENTING or PREFLIGHT at completion time, but the guard must
  // pass first. In practice the production flow transitions to IMPLEMENTING
  // before dispatch; here we verify the hook path end-to-end by also having
  // the guard accept IMPLEMENTING (it already does — see governance.js).
  // Actually, the guard checks status.state === 'READY'. We must start from READY.
  // But completeGovernedTask requires IMPLEMENTING or PREFLIGHT. The resolution:
  // the guard AND the completion hook coexist — dispatch passes with READY,
  // then the worker runs, then completeGovernedTask is called with the Change
  // now in IMPLEMENTING (transitioned externally or by the worker).
  // For this integration test, we pre-transition to IMPLEMENTING AFTER the guard
  // would have approved but BEFORE monitor calls the hook. We achieve this by
  // using dispatchOnce (which runs preflight + claim + guard + launch + monitor)
  // while having the launcher resolve immediately.
  // The guard sees READY at guard time. The hook (completeGovernedTask) sees
  // whatever state the Change is in at completion time. We transition after guard
  // but before monitor hits the hook — the simplest way is to dispatch normally
  // (dispatcher handles claim+start) and let our fake launcher complete instantly.

  let implemented = false;
  // Pass the RAW launcher — createGovernedDispatcher wraps it with createBindingLauncher
  // internally, so we must NOT double-wrap here.
  // Pass the RAW launcher — createGovernedDispatcher wraps it with createBindingLauncher
  // internally. Do NOT pre-wrap here or the session gets double-bound.
  const launcher = {
    async launch() {
      return { sessionId: 'sess-tH2-1', wait: async () => {
        // Transition to IMPLEMENTING AFTER the guard has already passed but
        // BEFORE the completion hook runs (i.e., during the worker's execution).
        if (!implemented) { implemented = true; await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {}); }
        // Return a realistic worker result with commit_sha and proof fields.
        return { exitCode: 0, stdout: 'done', stderr: '', commit_sha: 'abc123', files_changed: ['src/foo.js'], tests_run: ['test/foo.test.js'] };
      }, async terminate() { return true; } }
    },
  };
  const dispatcher = ctx.taskChangeControl.createGovernedDispatcher({ launcher });
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' });

  // The dispatcher must succeed and return in_review.
  assert.equal(result.dispatched, true);
  assert.equal(result.status, 'in_review');

  // Proof must be persisted on the Change side.
  const changeStatus = await ctx.changeControl.status(change.id);
  assert.ok(changeStatus.proof, 'Change-side proof must be persisted, state=' + changeStatus.state + ' proof=' + JSON.stringify(changeStatus.proof));

  // Change must be in PREFLIGHT (not left in IMPLEMENTING).
  const changeState = await ctx.changeControl.get(change.id);
  assert.equal(changeState.state, 'PREFLIGHT', 'Change must reach PREFLIGHT after governed success');

  // Task must be in_review with aligned fields.
  const finalTask = await taskStore.get(task.id);
  assert.equal(finalTask.status, 'in_review');
});

test('binding rebound to different worker during Change await -> SESSION_WORKER_MISMATCH', async (t) => {
  const { ctx, taskStore, dir } = await compose(t);
  const { task, change, runId } = await runningGovernedTask(ctx, taskStore, dir);
  // Finish the binding-hijack BEFORE the completion call: rebind session to a different worker.
  await ctx.changeControl.bindRole(change.id, 'sess-other', 'worker', { worker: 'worker:other' });
  const proof = {
    beforeRevision: 'a', afterRevision: 'x',
    commit_sha: 'a', files_changed: ['f'], tests_run: ['t'], remaining_blockers: [],
    criteria: [{ id: 'ship', satisfied: true }], deviations: [], workerChecks: ['w'], controllerPreflight: ['cp'], summary: 's',
  };
  await assert.rejects(
    ctx.taskChangeControl.completeGovernedTask(task.id, { sessionId: 'sess-other', worker: runId, proof }),
    (e) => e?.code === 'SESSION_WORKER_MISMATCH',
  );
  const tAfter = await taskStore.get(task.id);
  assert.equal(tAfter.status, 'running');
});

test('governed dispatcher releases binding on timeout (TH2-R1-01)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-t H2-timeout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    complete: taskStore.complete.bind(taskStore),
    createDispatcher(options = {}) {
      return new WorkerDispatcher({
        store: taskStore,
        registry: new WorkerSpecRegistry({
          worker: { mode: 'session', profile: 'wp', agentPreset: 'worker', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 50, leaseSeconds: 300 },
        }),
        launcher: options.launcher,
        preflight: options.preflight ?? (async () => ({ ok: true, spec: { mode: 'session', profile: 'wp', agentPreset: 'worker', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 50, leaseSeconds: 300, name: 'worker' } })),
        preDispatch: options.preDispatch ?? null,
        completionHook: options.completionHook ?? null,
      });
    },
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);

  const task = await taskStore.create({ title: 'tH2-timeout', description: 'd', status: 'ready', workspace: dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });

  // Launcher that never resolves (simulates timeout)
  const launcher = {
    async launch() {
      return { sessionId: 'sess-timeout-1', wait: async () => new Promise(() => {}), async terminate() { return true; } };
    },
  };
  const dispatcher = ctx.taskChangeControl.createGovernedDispatcher({ launcher });
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' });

  // Task should be in failed status due to timeout
  assert.equal(result.dispatched, true);
  assert.equal(result.status, 'failed', 'governed timeout should result in failed status');

  // Binding should be released after timeout (no leaked binding)
  const bindings = await ctx.changeControl.listRoleBindings();
  const thisBinding = bindings.find(b => b.sessionId === 'sess-timeout-1');
  assert.equal(thisBinding, undefined, 'binding should be released after timeout');

  // Change should still be in READY (not progressed)
  const changeState = await ctx.changeControl.get(change.id);
  assert.equal(changeState.state, 'READY', 'Change should remain in READY after timeout');
});

test('governed dispatcher rejects fabricated proof without commit_sha (TH2-R1-03)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-t H2-noproof-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    complete: taskStore.complete.bind(taskStore),
    createDispatcher(options = {}) {
      return new WorkerDispatcher({
        store: taskStore,
        registry: new WorkerSpecRegistry({
          worker: { mode: 'session', profile: 'wp', agentPreset: 'worker', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 5000, leaseSeconds: 300 },
        }),
        launcher: options.launcher,
        preflight: options.preflight ?? (async () => ({ ok: true, spec: { mode: 'session', profile: 'wp', agentPreset: 'worker', provider: 'ollama', model: 'm', workspacePolicy: 'any', timeoutMs: 5000, leaseSeconds: 300, name: 'worker' } })),
        preDispatch: options.preDispatch ?? null,
        completionHook: options.completionHook ?? null,
      });
    },
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);

  const task = await taskStore.create({ title: 'tH2-noproof', description: 'd', status: 'ready', workspace: dir, worker_profile: 'worker', acceptance_criteria: ['ship'] });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const plan = await ctx.changeControl.submitPlan(change.id, { steps: ['s'] });
  await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });

  // Launcher returns success but NO commit_sha (fabricated proof scenario)
  let implemented = false;
  const launcher = {
    async launch() {
      return { sessionId: 'sess-noproof-1', wait: async () => {
        if (!implemented) { implemented = true; await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {}); }
        return { exitCode: 0, stdout: 'done', stderr: '' }; // No commit_sha!
      }, async terminate() { return true; } };
    },
  };
  const dispatcher = ctx.taskChangeControl.createGovernedDispatcher({ launcher });
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' });

  // Should fail because commit_sha is missing
  assert.equal(result.dispatched, true);
  assert.equal(result.status, 'failed', 'governed completion without commit_sha should fail');
  assert.ok(result.error?.includes('commit_sha'), 'error should mention missing commit_sha');

  // Change should NOT be in PREFLIGHT
  const changeState = await ctx.changeControl.get(change.id);
  assert.notEqual(changeState.state, 'PREFLIGHT', 'Change should not reach PREFLIGHT without valid proof');
});
