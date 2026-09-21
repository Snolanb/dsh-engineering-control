import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskChangeControlService } from '../src/service.js';

const TASK_ID = 'task-1';
const CHANGE_ID = 'change-1';

function harness({ linked = true, binding = null, bindError = null } = {}) {
  const calls = { get: [], find: [], getBinding: [], bind: [], audit: [], submitPlan: 0, acceptPlan: 0, dispatch: 0 };
  const task = { id: TASK_ID, title: 'governed task' };
  const change = { id: CHANGE_ID, state: 'DRAFT', workItem: { system: 'dsh-task-orchestrator', id: TASK_ID } };
  let currentBinding = binding;
  const taskOrchestrator = {
    get(id) { calls.get.push(id); return id === TASK_ID ? task : null; },
    update() {},
    createDispatcher() { calls.dispatch++; throw new Error('must not dispatch'); },
  };
  const changeControl = {
    async findByWorkItem(system, id) { calls.find.push([system, id]); return linked && id === TASK_ID ? change : null; },
    async getBinding(changeId, sessionId) { calls.getBinding.push([changeId, sessionId]); return currentBinding?.sessionId === sessionId ? currentBinding : null; },
    async bindRole(changeId, sessionId, role, opts) {
      calls.bind.push([changeId, sessionId, role, opts]);
      if (bindError) throw bindError;
      currentBinding = { changeId, sessionId, role };
      return currentBinding;
    },
    async appendAudit(event) { calls.audit.push(event); return event; },
    async submitPlan() { calls.submitPlan++; throw new Error('must not plan'); },
    async acceptPlan() { calls.acceptPlan++; throw new Error('must not approve'); },
  };
  const service = createTaskChangeControlService({ taskOrchestrator: () => taskOrchestrator, changeControl: () => changeControl });
  return { service, calls, changeControl };
}

function assertNoDownstream(calls) {
  assert.equal(calls.submitPlan, 0);
  assert.equal(calls.acceptPlan, 0);
  assert.equal(calls.dispatch, 0);
}

test('controller startup binds the exact authenticated session as planner and audits authoritative identity', async () => {
  const { service, calls } = harness();
  const result = await service.startGovernedPlanning(TASK_ID, {
    authenticatedSessionId: 'host-session', actor: 'controller-user', sessionId: 'model-spoof',
  });
  assert.deepEqual(calls.get, [TASK_ID]);
  assert.deepEqual(calls.find, [['dsh-task-orchestrator', TASK_ID]]);
  assert.equal(calls.bind.length, 1);
  assert.deepEqual(calls.bind[0].slice(0, 3), [CHANGE_ID, 'host-session', 'planner']);
  assert.equal(calls.bind[0][3]?.actor, 'controller-user');
  assert.ok(calls.audit.some((e) => e.changeId === CHANGE_ID && e.sessionId === 'host-session' && e.actor === 'controller-user'));
  assert.deepEqual(result, { ok: true, taskId: TASK_ID, changeId: CHANGE_ID, sessionId: 'host-session', reused: false });
  assertNoDownstream(calls);
});

test('an existing planner binding is reused idempotently without duplicate bind', async () => {
  const { service, calls } = harness({ binding: { changeId: CHANGE_ID, sessionId: 'host-session', role: 'planner' } });
  const result = await service.startGovernedPlanning(TASK_ID, { authenticatedSessionId: 'host-session' });
  assert.equal(calls.bind.length, 0);
  assert.deepEqual(result, { ok: true, taskId: TASK_ID, changeId: CHANGE_ID, sessionId: 'host-session', reused: true });
});

test('model-provided sessionId cannot select or gain planner authority', async () => {
  const { service, calls } = harness();
  const result = await service.startGovernedPlanning(TASK_ID, { authenticatedSessionId: 'trusted', sessionId: 'hostile' });
  assert.equal(result.sessionId, 'trusted');
  assert.deepEqual(calls.bind.map((args) => args[1]), ['trusted']);
  assert.equal(calls.getBinding.some((args) => args[1] === 'hostile'), false);
});

test('incompatible existing binding fails closed without overwrite or downstream action', async () => {
  const { service, calls } = harness({ binding: { changeId: CHANGE_ID, sessionId: 'host-session', role: 'worker' } });
  await assert.rejects(
    service.startGovernedPlanning(TASK_ID, { authenticatedSessionId: 'host-session' }),
    (error) => error?.code === 'PLANNER_BINDING_CONFLICT' && error?.taskId === TASK_ID && error?.changeId === CHANGE_ID,
  );
  assert.equal(calls.bind.length, 0);
  assertNoDownstream(calls);
});

test('bind authorization failure preserves its machine-readable code and stops', async () => {
  const denial = Object.assign(new Error('not authorized'), { code: 'ROLE_BIND_DENIED' });
  const { service, calls } = harness({ bindError: denial });
  await assert.rejects(
    service.startGovernedPlanning(TASK_ID, { authenticatedSessionId: 'host-session' }),
    (error) => error?.code === 'ROLE_BIND_DENIED',
  );
  assert.equal(calls.audit.length, 0, 'failed startup must not audit success');
  assertNoDownstream(calls);
});

test('missing authenticated identity fails closed before task/change lookup', async () => {
  for (const runtimeContext of [{}, { authenticatedSessionId: '' }, { authenticatedSessionId: '  ' }, { sessionId: 'model-only' }]) {
    const { service, calls } = harness();
    await assert.rejects(
      service.startGovernedPlanning(TASK_ID, runtimeContext),
      (error) => error?.code === 'AUTHENTICATED_SESSION_REQUIRED',
    );
    assert.deepEqual(calls.get, []);
    assert.deepEqual(calls.find, []);
    assert.equal(calls.bind.length, 0);
  }
});

test('missing canonical Change link fails closed without binding or downstream action', async () => {
  const { service, calls } = harness({ linked: false });
  await assert.rejects(
    service.startGovernedPlanning(TASK_ID, { authenticatedSessionId: 'host-session' }),
    (error) => error?.code === 'TASK_NOT_LINKED' && error?.taskId === TASK_ID,
  );
  assert.equal(calls.bind.length, 0);
  assertNoDownstream(calls);
});

test('a manually-created planner binding remains compatible', async () => {
  const { service, calls, changeControl } = harness();
  await changeControl.bindRole(CHANGE_ID, 'manual-session', 'planner', { actor: 'human-command' });
  calls.bind.length = 0;
  const result = await service.startGovernedPlanning(TASK_ID, { authenticatedSessionId: 'manual-session', actor: 'controller' });
  assert.equal(result.reused, true);
  assert.equal(calls.bind.length, 0);
});
