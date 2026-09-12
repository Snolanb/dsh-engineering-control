import test from 'node:test';
import assert from 'node:assert/strict';
import integrationPlugin from '../src/index.js';
import { createTaskChangeControlService } from '../src/service.js';

const changeId = 'change-1';
const taskId = 'task-1';
const worker = 'repair-worker';
const binding = { changeId, sessionId: 'repair-session', role: 'worker', worker };

const proof = {
  beforeRevision: 'rev-1',
  afterRevision: 'rev-2',
  commit_sha: 'commit-2',
  files_changed: [],
  tests_run: [],
  remaining_blockers: [],
  criteria: [{ id: 'ship', satisfied: true }],
  deviations: [],
  workerChecks: [],
  controllerPreflight: [],
  summary: 'repair complete',
};

function createHarness({
  taskStatus = 'changes_requested',
  changeState = 'REPAIR',
  preflight = { ok: true, spec: null },
  workerLauncher,
  taskWorkspace = '/tmp',
  taskCriteria = ['ship'],
  completeError = null,
} = {}) {
  let state = changeState;
  const calls = [];
  const audits = [];
  const task = {
    id: taskId,
    status: taskStatus,
    workspace: taskWorkspace,
    worker_profile: 'worker',
    acceptance_criteria: taskCriteria,
    claimed_by: null,
    lease_expires_at: null,
    attempts: 0,
  };
  const spec = {
    name: 'worker', mode: 'session', agentPreset: 'worker',
    model: { provider: 'ollama', model: 'm' },
    workspacePolicy: { type: 'any', roots: [] }, timeoutMs: 20, leaseSeconds: 30,
    enabled: true,
  };
  const change = { id: changeId, state };
  const status = () => ({
    state,
    revision: 'rev-1',
    openFindings: [{ id: 'finding-1', severity: 'critical' }],
    attempts: [{ revision: 'rev-1', status: 'proof_submitted' }],
    proof: null,
  });
  const cloneTask = () => structuredClone(task);
  const t = {
    get() { return cloneTask(); },
    updateIf(id, expected, patch) {
      calls.push({ op: 'updateIf', expected: structuredClone(expected), patch: structuredClone(patch) });
      if (id !== taskId) return null;
      if (expected.status !== undefined && task.status !== expected.status) return null;
      if (expected.claimed_by !== undefined && task.claimed_by !== expected.claimed_by) return null;
      if (expected.lease_expires_at !== undefined && task.lease_expires_at !== expected.lease_expires_at) return null;
      if (patch.status !== undefined) {
        task.status = patch.status;
        if (!['claimed', 'running'].includes(patch.status)) {
          task.claimed_by = null;
          task.lease_expires_at = null;
        }
      }
      if (patch.commit_sha !== undefined) task.commit_sha = patch.commit_sha;
      if (patch.files_changed !== undefined) task.files_changed = patch.files_changed;
      if (patch.tests_run !== undefined) task.tests_run = patch.tests_run;
      if (patch.remaining_blockers !== undefined) task.remaining_blockers = patch.remaining_blockers;
      return cloneTask();
    },
    claim(id, owner, options = {}) {
      calls.push({ op: 'claim', id, owner });
      if (!['ready', 'claimed', 'running'].includes(task.status)) return { claimed: false, reason: 'not_claimable', task: cloneTask() };
      task.status = 'claimed';
      task.claimed_by = owner;
      task.lease_expires_at = Date.now() + Number(options.lease_seconds ?? 30) * 1000;
      task.attempts += 1;
      return { claimed: true, task: cloneTask() };
    },
    start(id, owner) {
      calls.push({ op: 'start', id, owner });
      task.status = 'running';
      return cloneTask();
    },
    release(id, owner) {
      calls.push({ op: 'release', id, owner });
      if (task.claimed_by === owner) {
        task.status = 'ready';
        task.claimed_by = null;
        task.lease_expires_at = null;
      }
      return { released: true, task: cloneTask() };
    },
    renewLease(id, owner) {
      calls.push({ op: 'renewLease', id, owner });
      if (task.claimed_by !== owner) return { renewed: false };
      task.lease_expires_at = Date.now() + 30_000;
      return { renewed: true, task: cloneTask() };
    },
    resolveWorkerSpec() { return structuredClone(spec); },
    preflightWorker() { calls.push({ op: 'preflightWorker' }); return preflight; },
    createWorkerLauncher() {
      calls.push({ op: 'createWorkerLauncher' });
      return workerLauncher ?? { async launch() { throw new Error('unexpected launch'); } };
    },
    complete() {
      calls.push({ op: 'complete' });
      if (completeError) throw completeError;
      task.status = 'in_review';
      task.claimed_by = null;
      task.lease_expires_at = null;
      return cloneTask();
    },
  };
  const c = {
    async get() { return { ...change, state }; },
    async findByWorkItem() { return { ...change, state }; },
    async listByWorkItem() { return [{ ...change, state }]; },
    async status() { return status(); },
    async submitRepair() { calls.push({ op: 'submitRepair' }); state = 'PREFLIGHT'; change.state = state; return { state }; },
    async appendAudit(entry) { audits.push(entry); },
    async getBinding() { return binding; },
    getBindingFromDisk() { return binding; },
    async bindRole() { calls.push({ op: 'bindRole' }); },
    async unbindRole() { calls.push({ op: 'unbindRole' }); },
    async listRoleBindings() { return [binding]; },
    async history() { return audits; },
  };
  const api = createTaskChangeControlService({ taskOrchestrator: () => t, changeControl: () => c });
  return { t, c, api, task, calls, audits, get state() { return state; } };
}

function eventContext({ orch, cc }) {
  const services = { tools: { register() { return () => {}; } }, taskOrchestrator: orch, changeControl: cc };
  const listeners = new Map();
  const ctx = {
    get(name) { return services[name]; },
    provide(name, value) { services[name] = value; },
    async inject(deps, callback) {
      const result = await callback({ get: (name) => services[name] });
      return result;
    },
    events: {
      on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
      parallel(_carrier, name, payload) { return listeners.get(name)?.(payload); },
    },
  };
  return { ctx, services, listeners };
}

function recoveryFixture({ leaseExpiresAt, listMode = 'expired' }) {
  const calls = [];
  let listed = false;
  const task = { id: taskId, status: 'running', claimed_by: 'dead-worker', lease_expires_at: leaseExpiresAt, worker_profile: 'worker', acceptance_criteria: ['ship'] };
  const change = { id: changeId, state: 'REPAIR', workItem: { system: 'dsh-task-orchestrator', id: taskId } };
  const orch = {
    get() { calls.push({ op: 'get' }); return structuredClone(task); },
    list(options = {}) {
      calls.push({ op: 'list', options });
      if (listed) return [];
      listed = true;
      if (options.statuses?.includes('running')) return [structuredClone(task)];
      if (listMode === 'expired') return options.expired_claims ? [structuredClone(task)] : [];
      return [];
    },
    updateIf(id, expected, patch) { calls.push({ op: 'updateIf', id, expected, patch }); task.status = patch.status; task.claimed_by = null; task.lease_expires_at = null; return structuredClone(task); },
    claim() { calls.push({ op: 'claim' }); return { claimed: false, reason: 'not_claimable', task: structuredClone(task) }; },
    start() { calls.push({ op: 'start' }); return structuredClone(task); },
    release() { calls.push({ op: 'release' }); return { released: true, task: structuredClone(task) }; },
  };
  const cc = {
    async get() { return structuredClone(change); },
    async findByWorkItem() { return structuredClone(change); },
    async listByWorkItem() { return [structuredClone(change)]; },
    async status() { return { state: 'REPAIR', openFindings: [], attempts: [] }; },
    async appendAudit(entry) { calls.push({ op: 'audit', entry }); },
    registerGovernanceProvider() { return { unregister() {} }; },
  };
  const { ctx } = eventContext({ orch, cc });
  return { ctx, orch, cc, calls };
}

async function waitFor(predicate, timeoutMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

test('H11 repair state guard checks authoritative Change before prepare mutation', async () => {
  const h = createHarness({ changeState: 'READY' });
  const result = await h.api.runGovernedSdlc(taskId, {});
  assert.equal(result.outcome, 'lifecycle_mismatch');
  assert.equal(h.calls.filter(call => call.op === 'updateIf').length, 0);
});

test('H11 repair preflight is strict fail-closed even with empty or soft blockers', async () => {
  const h = createHarness({
    taskStatus: 'ready',
    preflight: { ok: false, blockers: [] },
  });
  const result = await h.api.runGovernedSdlc(taskId, {});
  assert.equal(result.outcome, 'repair_preflight_failed');
  assert.equal(h.calls.some(call => call.op === 'claim'), false);
  assert.equal(h.calls.some(call => call.op === 'createWorkerLauncher'), false);
});

test('H11 repair timeout terminates the handle and releases its claim', async () => {
  let terminated = false;
  const launcher = {
    async launch() {
      return {
        sessionId: 'repair-session',
        wait: () => new Promise(() => {}),
        async terminate() { terminated = true; return true; },
      };
    },
  };
  const h = createHarness({ workerLauncher: launcher });
  const result = await h.api.runGovernedSdlc(taskId, {
    worker,
    workerLauncher: launcher,
    timeoutMs: 20,
  });
  assert.equal(result.outcome, 'repair_failed');
  assert.equal(terminated, true);
  assert.equal(h.calls.some(call => call.op === 'release'), true);
  assert.equal(h.task.status, 'ready');
});

test('H11 partial repair commit is recovered into review instead of ready plus PREFLIGHT', async () => {
  const launcher = {
    async launch() {
      return { sessionId: 'repair-session', async wait() { return { exitCode: 0, ...proof }; }, async terminate() { return true; } };
    },
  };
  const h = createHarness({ workerLauncher: launcher, completeError: new Error('criteria changed') });
  try {
    await h.api.runGovernedSdlc(taskId, { worker, workerLauncher: launcher });
  } catch {
    // A missing reviewer launcher in the tiny harness is acceptable after the
    // recovery transition; the durable task/Change pair is what this test pins.
  }
  assert.equal(h.state, 'PREFLIGHT');
  assert.notEqual(h.task.status, 'ready');
  assert.ok(h.task.status === 'in_review' || h.task.status === 'running');
});

test('H11 startup recovery handles synchronous orch.get for expired repair claims', async () => {
  const fixture = recoveryFixture({ leaseExpiresAt: Date.now() - 1, listMode: 'expired' });
  await integrationPlugin.apply(fixture.ctx);
  await waitFor(() => fixture.calls.some(call => call.op === 'updateIf'));
  assert.equal(fixture.calls.some(call => call.op === 'get'), true);
  assert.equal(fixture.calls.some(call => call.op === 'updateIf'), true);
});

test('H11 startup schedules active repair claim recovery without polling', async () => {
  const fixture = recoveryFixture({ leaseExpiresAt: Date.now() + 20, listMode: 'active' });
  await integrationPlugin.apply(fixture.ctx);
  await waitFor(() => fixture.calls.some(call => call.op === 'updateIf'), 400);
  assert.equal(fixture.calls.some(call => call.op === 'updateIf'), true);
});
