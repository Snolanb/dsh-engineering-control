import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTeamsAdapter } from '../src/agent-teams-adapter.js';
import { createTaskChangeControlService } from '../src/service.js';

const WORK_ITEM_SYSTEM = 'dsh-task-orchestrator';

function makeLifecycle(teams = {}) {
  let listener = null;
  const subscribeCalls = [];
  const getTeamCalls = [];
  let unsubscribeCalls = 0;

  return {
    subscribe(next) {
      subscribeCalls.push(next);
      listener = next;
      return () => {
        unsubscribeCalls += 1;
        if (listener === next) listener = null;
      };
    },
    async getTeam(teamId) {
      getTeamCalls.push(teamId);
      return teams[teamId] ?? null;
    },
    async emit(event) {
      if (!listener) return undefined;
      return listener(event);
    },
    subscribeCalls,
    getTeamCalls,
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
  };
}

function makeChangeControl(changes = {}) {
  const findCalls = [];
  const bindCalls = [];
  const unbindCalls = [];
  const auditCalls = [];

  return {
    async findByWorkItem(system, taskId) {
      findCalls.push({ system, taskId });
      return changes[taskId] ?? null;
    },
    async bindRole(changeId, sessionId, role, options) {
      bindCalls.push({ changeId, sessionId, role, options: { ...options } });
      return { changeId, sessionId, role, ...options };
    },
    async unbindRole(changeId, sessionId, options) {
      unbindCalls.push({ changeId, sessionId, options: { ...options } });
      return { removed: true, changeId, sessionId };
    },
    async appendAudit(entry) {
      auditCalls.push({ ...entry });
    },
    findCalls,
    bindCalls,
    unbindCalls,
    auditCalls,
  };
}

async function emit(lifecycle, event) {
  await lifecycle.emit(event);
  await new Promise((resolve) => setImmediate(resolve));
}

function startedEvent(overrides = {}) {
  return {
    type: 'session.started',
    teamId: 'team-g3',
    agentTaskId: 'agent-task-1',
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    taskKind: 'implementation',
    role: 'worker',
    status: 'started',
    result: null,
    ...overrides,
  };
}

test('session starts bind generic workers and reviewers without model/provider coupling', async (t) => {
  const lifecycle = makeLifecycle({ 'team-g3': { taskId: 'task-governed' } });
  const changeControl = makeChangeControl({ 'task-governed': { id: 'change-g3' } });
  const adapter = createAgentTeamsAdapter({ agentTeamsLifecycle: lifecycle, changeControl });
  t.after(() => adapter.dispose());

  await emit(lifecycle, startedEvent({
    taskKind: 'test',
    role: 'test',
    attemptId: 'attempt-test',
    sessionId: 'session-test',
    provider: 'ollama',
    model: 'test-model-a',
  }));
  await emit(lifecycle, startedEvent({
    taskKind: 'implementation',
    role: 'implementation',
    attemptId: 'attempt-implementation',
    sessionId: 'session-implementation',
    provider: 'ark-code',
    model: 'implementation-model-b',
  }));
  await emit(lifecycle, startedEvent({
    taskKind: 'repair',
    role: 'repair',
    attemptId: 'attempt-repair',
    sessionId: 'session-repair',
    provider: 'nvidia',
    model: 'repair-model-c',
  }));
  await emit(lifecycle, startedEvent({
    taskKind: 'review',
    role: 'reviewer',
    attemptId: 'attempt-review',
    sessionId: 'session-review',
    provider: 'agnes',
    model: 'review-model-d',
  }));

  assert.deepEqual(changeControl.findCalls, [
    { system: WORK_ITEM_SYSTEM, taskId: 'task-governed' },
    { system: WORK_ITEM_SYSTEM, taskId: 'task-governed' },
    { system: WORK_ITEM_SYSTEM, taskId: 'task-governed' },
    { system: WORK_ITEM_SYSTEM, taskId: 'task-governed' },
  ]);
  assert.deepEqual(changeControl.bindCalls, [
    { changeId: 'change-g3', sessionId: 'session-test', role: 'worker', options: { worker: 'attempt-test' } },
    { changeId: 'change-g3', sessionId: 'session-implementation', role: 'worker', options: { worker: 'attempt-implementation' } },
    { changeId: 'change-g3', sessionId: 'session-repair', role: 'worker', options: { worker: 'attempt-repair' } },
    { changeId: 'change-g3', sessionId: 'session-review', role: 'reviewer', options: { worker: 'attempt-review' } },
  ]);
  assert.equal(
    changeControl.bindCalls.filter(({ sessionId, role }) => sessionId === 'session-review' && role === 'worker').length,
    0,
    'a reviewer session must never receive worker authority',
  );
});

test('duplicate starts and both settlement events release each binding exactly once', async (t) => {
  const lifecycle = makeLifecycle({ 'team-g3': { taskId: 'task-governed' } });
  const changeControl = makeChangeControl({ 'task-governed': { id: 'change-g3' } });
  const adapter = createAgentTeamsAdapter({ agentTeamsLifecycle: lifecycle, changeControl });
  t.after(() => adapter.dispose());

  const settledSession = startedEvent({ attemptId: 'attempt-settled', sessionId: 'session-settled' });
  await emit(lifecycle, settledSession);
  await emit(lifecycle, settledSession);
  await emit(lifecycle, { ...settledSession, type: 'session.settled', status: 'settled' });
  await emit(lifecycle, { ...settledSession, type: 'session.settled', status: 'settled' });
  await emit(lifecycle, { ...settledSession, type: 'session.removed', status: 'removed' });

  const removedSession = startedEvent({ attemptId: 'attempt-removed', sessionId: 'session-removed' });
  await emit(lifecycle, removedSession);
  await emit(lifecycle, { ...removedSession, type: 'session.removed', status: 'removed' });
  await emit(lifecycle, { ...removedSession, type: 'session.removed', status: 'removed' });

  assert.equal(changeControl.bindCalls.length, 2, 'duplicate session.started events bind once per session');
  assert.deepEqual(changeControl.unbindCalls, [
    { changeId: 'change-g3', sessionId: 'session-settled', options: {} },
    { changeId: 'change-g3', sessionId: 'session-removed', options: {} },
  ]);
});

test('unknown lifecycle roles are ignored without Change lookups or bindings', async (t) => {
  const lifecycle = makeLifecycle({ 'team-g3': { taskId: 'task-governed' } });
  const changeControl = makeChangeControl({ 'task-governed': { id: 'change-g3' } });
  const adapter = createAgentTeamsAdapter({ agentTeamsLifecycle: lifecycle, changeControl });
  t.after(() => adapter.dispose());

  const unknown = startedEvent({ taskKind: 'maintenance', role: 'observer', sessionId: 'session-unknown' });
  await emit(lifecycle, unknown);
  await emit(lifecycle, { ...unknown, type: 'session.settled', status: 'settled' });
  await emit(lifecycle, { ...unknown, type: 'session.removed', status: 'removed' });

  assert.deepEqual(changeControl.findCalls, []);
  assert.deepEqual(changeControl.bindCalls, []);
  assert.deepEqual(changeControl.unbindCalls, []);
});

test('task completion forwards stable lifecycle evidence and outcome without scheduling work', async (t) => {
  const lifecycle = makeLifecycle({ 'team-g3': { taskId: 'task-governed' } });
  const changeControl = makeChangeControl({ 'task-governed': { id: 'change-g3' } });
  const adapter = createAgentTeamsAdapter({ agentTeamsLifecycle: lifecycle, changeControl });
  t.after(() => adapter.dispose());

  const result = {
    commit_sha: 'commit-g3',
    files_changed: ['packages/task-change-control/src/agent-teams-adapter.js'],
    tests_run: ['agent-teams-adapter.test.mjs'],
  };
  const completed = {
    type: 'task.completed',
    teamId: 'team-g3',
    agentTaskId: 'agent-task-1',
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    taskKind: 'implementation',
    role: 'worker',
    status: 'completed',
    result,
  };

  await emit(lifecycle, completed);

  assert.equal(changeControl.auditCalls.length, 1);
  const [audit] = changeControl.auditCalls;
  assert.equal(audit.type, 'task.completed');
  assert.equal(audit.teamId, completed.teamId);
  assert.equal(audit.agentTaskId, completed.agentTaskId);
  assert.equal(audit.attemptId, completed.attemptId);
  assert.equal(audit.sessionId, completed.sessionId);
  assert.equal(audit.status, completed.status);
  assert.deepEqual(audit.result, result);
  assert.deepEqual(changeControl.bindCalls, []);
  assert.deepEqual(changeControl.unbindCalls, []);
});

test('missing AgentTeams lifecycle is a no-op and leaves ordinary task-change-control usable', async () => {
  const findCalls = [];
  const changeControl = {
    async findByWorkItem(system, taskId) {
      findCalls.push({ system, taskId });
      return null;
    },
  };

  const adapter = createAgentTeamsAdapter({ changeControl });
  assert.equal(typeof adapter.dispose, 'function');
  await assert.doesNotReject(() => Promise.resolve(adapter.dispose()));
  await assert.doesNotReject(() => Promise.resolve(adapter.dispose()));

  const service = createTaskChangeControlService({
    taskOrchestrator: () => ({}),
    changeControl: () => changeControl,
  });
  assert.equal(await service.getChangeForTask('standalone-task'), null);
  assert.deepEqual(findCalls, [{ system: WORK_ITEM_SYSTEM, taskId: 'standalone-task' }]);
});

test('disposing the adapter unsubscribes once and ignores later lifecycle events', async () => {
  const lifecycle = makeLifecycle({ 'team-g3': { taskId: 'task-governed' } });
  const changeControl = makeChangeControl({ 'task-governed': { id: 'change-g3' } });
  const adapter = createAgentTeamsAdapter({ agentTeamsLifecycle: lifecycle, changeControl });

  await adapter.dispose();
  await adapter.dispose();
  await emit(lifecycle, startedEvent());

  assert.equal(lifecycle.subscribeCalls.length, 1);
  assert.equal(lifecycle.unsubscribeCalls, 1);
  assert.deepEqual(changeControl.findCalls, []);
  assert.deepEqual(changeControl.bindCalls, []);
});
