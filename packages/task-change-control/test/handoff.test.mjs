import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import integrationPlugin from '../src/index.js';
import { createTaskChangeControlService } from '../src/service.js';

const TASK_ID = 'handoff-task';
const SYSTEM = 'dsh-task-orchestrator';

function harness({ task = {}, linked = false, dispatcher = { dispatched: true } } = {}) {
  const current = {
    id: TASK_ID,
    status: 'running',
    claimed_by: 'captain-session',
    worker_profile: 'worker',
    ...task,
  };
  const calls = { get: [], release: [], dispatch: [], createDispatcher: 0, find: [], status: [] };
  const taskOrchestrator = {
    get(id) { calls.get.push(id); return id === TASK_ID ? { ...current } : null; },
    release(id, worker, options) {
      calls.release.push([id, worker, options]);
      current.status = 'ready';
      current.claimed_by = null;
      return { released: true, task: { ...current } };
    },
    createWorkerLauncher() { return { async launch() { throw new Error('launcher must not run in handoff test'); } }; },
    createDispatcher(options) {
      calls.createDispatcher += 1;
      return {
        async dispatchOnce(input) {
          calls.dispatch.push(input);
          return typeof dispatcher === 'function' ? dispatcher(input) : dispatcher;
        },
        options,
      };
    },
  };
  const changeControl = {
    async findByWorkItem(system, id) {
      calls.find.push([system, id]);
      return linked ? { id: 'change-1', workItem: { system, id } } : null;
    },
    async status(id) { calls.status.push(id); return { state: 'READY', acceptedPlan: { id: 'plan-1' } }; },
  };
  const service = createTaskChangeControlService({
    taskOrchestrator: () => taskOrchestrator,
    changeControl: () => changeControl,
  });
  return { service, taskOrchestrator, changeControl, calls, current };
}

test('controller handoff releases only the exact owner then invokes governed dispatch once', async () => {
  const { service, calls } = harness();
  const result = await service.handoffGovernedDispatch(TASK_ID, {
    authenticatedSessionId: 'captain-session', workerProfile: 'worker', actor: 'captain-audit', sessionId: 'model-spoof',
  });
  assert.equal(calls.release.length, 1);
  assert.deepEqual(calls.release[0], [TASK_ID, 'captain-session', { actor: 'captain-audit' }]);
  assert.deepEqual(calls.dispatch, [{ workerProfile: 'worker', limit: 1 }]);
  assert.equal(result.ok, true);
});

test('handoff replay is idempotent and does not release or dispatch twice', async () => {
  const { service, calls } = harness();
  const context = { authenticatedSessionId: 'captain-session', workerProfile: 'worker' };
  await service.handoffGovernedDispatch(TASK_ID, context);
  const replay = await service.handoffGovernedDispatch(TASK_ID, context);
  assert.equal(replay.replay, true);
  assert.equal(calls.release.length, 1);
  assert.equal(calls.dispatch.length, 1);
  await assert.rejects(
    service.handoffGovernedDispatch(TASK_ID, { authenticatedSessionId: 'other-controller', workerProfile: 'worker' }),
    (error) => error?.code === 'CONTROLLER_CLAIM_CONFLICT',
  );
  assert.equal(calls.release.length, 1);
  assert.equal(calls.dispatch.length, 1);
});

test('conflicting controller claim fails closed before release or dispatch', async () => {
  const { service, calls } = harness({ task: { claimed_by: 'other-controller' } });
  await assert.rejects(
    service.handoffGovernedDispatch(TASK_ID, { authenticatedSessionId: 'captain-session', workerProfile: 'worker' }),
    (error) => error?.code === 'CONTROLLER_CLAIM_CONFLICT',
  );
  assert.equal(calls.release.length, 0);
  assert.equal(calls.dispatch.length, 0);
});

test('missing runtime identity/profile fails before authoritative lookup', async () => {
  const { service, calls } = harness();
  await assert.rejects(
    service.handoffGovernedDispatch(TASK_ID, { sessionId: 'model-session', workerProfile: 'worker' }),
    (error) => error?.code === 'AUTHENTICATED_SESSION_REQUIRED',
  );
  await assert.rejects(
    service.handoffGovernedDispatch(TASK_ID, { authenticatedSessionId: 'captain-session' }),
    (error) => error?.code === 'WORKER_PROFILE_REQUIRED',
  );
  assert.deepEqual(calls.get, []);
});

test('ready and unclaimed tasks skip controller release and use governed dispatch', async () => {
  const { service, calls } = harness({ task: { status: 'ready', claimed_by: null } });
  await service.handoffGovernedDispatch(TASK_ID, { authenticatedSessionId: 'captain-session', workerProfile: 'worker' });
  assert.equal(calls.release.length, 0);
  assert.deepEqual(calls.dispatch, [{ workerProfile: 'worker', limit: 1 }]);
});

test('missing governed dispatcher capability preserves the controller claim', async () => {
  const { service, taskOrchestrator, calls } = harness();
  delete taskOrchestrator.createDispatcher;
  await assert.rejects(
    service.handoffGovernedDispatch(TASK_ID, { authenticatedSessionId: 'captain-session', workerProfile: 'worker' }),
    (error) => error?.code === 'LINKAGE_UNAVAILABLE',
  );
  assert.equal(calls.release.length, 0);
  assert.equal(calls.dispatch.length, 0);
});

test('governance mode off does not route linked work to an ungoverned fallback', async () => {
  const { service, calls, changeControl } = harness({ linked: true });
  changeControl.getGovernanceMode = () => 'off';
  await service.handoffGovernedDispatch(TASK_ID, { authenticatedSessionId: 'captain-session', workerProfile: 'worker' });
  assert.equal(calls.createDispatcher, 1);
  assert.deepEqual(calls.dispatch, [{ workerProfile: 'worker', limit: 1 }]);
});

test('linked Change must be READY with an accepted current plan before release', async () => {
  const { service, calls, changeControl } = harness({ linked: true });
  changeControl.status = async () => ({ state: 'IMPLEMENTING', acceptedPlan: null });
  await assert.rejects(
    service.handoffGovernedDispatch(TASK_ID, { authenticatedSessionId: 'captain-session', workerProfile: 'worker' }),
    (error) => error?.code === 'DISPATCH_NOT_GOVERNED',
  );
  assert.equal(calls.release.length, 0);
  assert.equal(calls.dispatch.length, 0);
});

test('apply host event scans authoritative candidates and replay stays idempotent', async (t) => {
  const { taskOrchestrator, changeControl, calls, current } = harness();
  const rows = [current];
  const listeners = new Set();
  const originalGet = taskOrchestrator.get;
  taskOrchestrator.list = () => rows.map((row) => ({ ...row }));
  taskOrchestrator.get = (id) => originalGet(id);
  taskOrchestrator.subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  taskOrchestrator.registerLifecycleGuard = () => () => {};
  taskOrchestrator.updateIf = () => null;
  taskOrchestrator.complete = () => null;
  changeControl.listByWorkItem = async () => [];
  changeControl.get = async () => null;
  changeControl.appendAudit = async () => {};

  const ctx = new Context();
  t.after(() => ctx.dispose?.());
  ctx.provide('taskOrchestrator', taskOrchestrator);
  ctx.provide('changeControl', changeControl);
  ctx.provide('tools', { register() { return () => {}; } });
  await ctx.plugin(integrationPlugin);

  ctx.events.emit('task-change-control/handoff-requested', {
    runtimeContext: { authenticatedSessionId: 'captain-session' },
  });
  // Cordis event listeners are intentionally fire-and-forget; allow the
  // request and its reconciliation to settle before asserting the seam.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.release.length, 1);
  assert.equal(calls.dispatch.length, 1);
  assert.deepEqual(calls.dispatch[0], { workerProfile: 'worker', limit: 1 });

  ctx.events.emit('task-change-control/handoff-requested', {
    runtimeContext: { authenticatedSessionId: 'captain-session' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.release.length, 1);
  assert.equal(calls.dispatch.length, 1);
  assert.ok(listeners.size >= 1);
  assert.equal(calls.createDispatcher, 1);
});
