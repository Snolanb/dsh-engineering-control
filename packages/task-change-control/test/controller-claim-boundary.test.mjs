import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskChangeControlService } from '../src/service.js';

const TASK_ID = 'task-controller-1';
const CHANGE_ID = 'change-controller-1';
const SESSION_ID = 'session-controller-1';

function harness({ task = {}, binding = null, claimResponse = null } = {}) {
  const calls = {
    get: [],
    claim: [],
    find: [],
    getBinding: [],
    bind: [],
    audit: [],
    planning: [],
  };
  let currentTask = {
    id: TASK_ID,
    title: 'controller task',
    status: 'ready',
    claimed_by: null,
    ...task,
  };
  let currentBinding = binding;
  const change = {
    id: CHANGE_ID,
    state: 'DRAFT',
    workItem: { system: 'dsh-task-orchestrator', id: TASK_ID },
  };
  const taskOrchestrator = {
    get(id) {
      calls.get.push(id);
      return id === TASK_ID ? currentTask : null;
    },
    claim(id, worker, options) {
      calls.claim.push([id, worker, options]);
      if (claimResponse !== null) {
        const response = typeof claimResponse === 'function'
          ? claimResponse({ task: currentTask, worker })
          : claimResponse;
        if (response?.task) currentTask = response.task;
        return response;
      }
      if (id === TASK_ID) {
        currentTask = { ...currentTask, status: 'claimed', claimed_by: worker };
      }
      return { claimed: true, task: currentTask };
    },
    update() {},
    createDispatcher() { throw new Error('must not dispatch'); },
  };
  const changeControl = {
    async findByWorkItem(system, id) {
      calls.find.push([system, id]);
      return id === TASK_ID ? change : null;
    },
    async getBinding(changeId, sessionId) {
      calls.getBinding.push([changeId, sessionId]);
      return currentBinding?.sessionId === sessionId ? currentBinding : null;
    },
    async bindRole(changeId, sessionId, role, options) {
      calls.bind.push([changeId, sessionId, role, options]);
      currentBinding = { changeId, sessionId, role };
      return currentBinding;
    },
    async appendAudit(event) {
      calls.audit.push(event);
      return event;
    },
    async submitPlan() { throw new Error('must not plan'); },
    async acceptPlan() { throw new Error('must not approve'); },
  };
  const service = createTaskChangeControlService({
    taskOrchestrator: () => taskOrchestrator,
    changeControl: () => changeControl,
  });
  return { service, calls };
}

test('controller boundary derives S from exec.agent.id and passes the same S to planning', async () => {
  const { service, calls } = harness();
  const result = await service.startControllerOwnedPlanning(
    TASK_ID,
    { agent: { id: SESSION_ID } },
    { worker: 'captain', sessionId: 'spoof', claimed_by: 'spoof' },
  );

  assert.deepEqual(calls.claim[0].slice(0, 2), [TASK_ID, SESSION_ID]);
  assert.notEqual(calls.claim[0][1], 'captain');
  assert.deepEqual(calls.getBinding.at(-1), [CHANGE_ID, SESSION_ID]);
  assert.equal(result.sessionId, SESSION_ID);
});

test('missing exec.agent.id fails closed before lookup or mutation', async () => {
  const { service, calls } = harness();
  await assert.rejects(
    service.startControllerOwnedPlanning(TASK_ID, { agent: {} }, { worker: 'captain' }),
    (error) => error?.code === 'AUTHENTICATED_SESSION_REQUIRED',
  );
  assert.deepEqual(calls.get, []);
  assert.deepEqual(calls.claim, []);
  assert.deepEqual(calls.getBinding, []);
});

test('matching controller ownership is idempotent and conflicting ownership fails closed', async () => {
  const matching = harness();
  await matching.service.startControllerOwnedPlanning(TASK_ID, { agent: { id: SESSION_ID } });
  await matching.service.startControllerOwnedPlanning(TASK_ID, { agent: { id: SESSION_ID } });
  assert.equal(matching.calls.claim.length, 1);
  assert.ok(matching.calls.getBinding.length >= 2);

  const conflicting = harness({ task: { status: 'claimed', claimed_by: 'other-session' } });
  await assert.rejects(
    conflicting.service.startControllerOwnedPlanning(TASK_ID, { agent: { id: SESSION_ID } }),
    (error) => error?.code === 'CONTROLLER_CLAIM_CONFLICT',
  );
  assert.deepEqual(conflicting.calls.claim, []);
  assert.deepEqual(conflicting.calls.planning, []);
});

test('false claim results fail closed before planner binding', async () => {
  const conflicting = harness({
    claimResponse: {
      claimed: false,
      reason: 'already_claimed',
      task: { id: TASK_ID, status: 'claimed', claimed_by: 'other-session' },
    },
  });
  await assert.rejects(
    conflicting.service.startControllerOwnedPlanning(TASK_ID, { agent: { id: SESSION_ID } }),
    (error) => error?.code === 'CONTROLLER_CLAIM_CONFLICT',
  );
  assert.equal(conflicting.calls.getBinding.length, 0);
  assert.equal(conflicting.calls.bind.length, 0);
  assert.equal(conflicting.calls.audit.length, 0);

  const blocked = harness({
    claimResponse: {
      claimed: false,
      reason: 'blocked_by_dependencies',
      task: { id: TASK_ID, status: 'ready', claimed_by: null },
    },
  });
  await assert.rejects(
    blocked.service.startControllerOwnedPlanning(TASK_ID, { agent: { id: SESSION_ID } }),
    (error) => error?.code === 'CONTROLLER_CLAIM_FAILED',
  );
  assert.equal(blocked.calls.getBinding.length, 0);
  assert.equal(blocked.calls.bind.length, 0);
  assert.equal(blocked.calls.audit.length, 0);
});

test('same-owner replay from a false already-claimed result may continue', async () => {
  const raced = harness({
    claimResponse: ({ task, worker }) => ({
      claimed: false,
      reason: 'already_claimed',
      task: { ...task, status: 'claimed', claimed_by: worker },
    }),
  });
  const result = await raced.service.startControllerOwnedPlanning(TASK_ID, { agent: { id: SESSION_ID } });
  assert.equal(result.sessionId, SESSION_ID);
  assert.deepEqual(raced.calls.claim[0].slice(0, 2), [TASK_ID, SESSION_ID]);
  assert.equal(raced.calls.bind.length, 1);
});

test('captain remains an ordinary spoofable payload value, never an owner alias', async () => {
  const { service, calls } = harness();
  await service.startControllerOwnedPlanning(
    TASK_ID,
    { agent: { id: SESSION_ID } },
    { worker: 'captain', sessionId: 'captain', claimed_by: 'captain' },
  );
  assert.equal(calls.claim[0][1], SESSION_ID);
});
