import test from 'node:test';
import assert from 'node:assert/strict';
import { createR2HandoffProducer } from '../src/r2-handoff-producer.js';

// Minimal harness: trusted host surfaces only. The producer must derive S
// exclusively from the trusted arm (which mirrors R1 exec.agent.id) and
// must never consult claimed_by / planner bindings / captain metadata /
// model payload for identity.
function harness({ task = {}, linked = true, changeStatus = null, resolveWorkerSpec = null } = {}) {
  const TASK_ID = 'r2-task';
  const current = {
    id: TASK_ID,
    status: 'ready',
    ready_to_run: true,
    claimed_by: null,
    claimed_at: null,
    lease_expires_at: null,
    worker_profile: 'worker',
    ...task,
  };
  const change = {
    id: 'change-r2',
    state: 'READY',
    acceptedPlan: { id: 'plan-r2' },
    workItem: { system: 'dsh-task-orchestrator', id: TASK_ID },
    ...changeStatus,
  };
  const state = { change };
  const calls = { get: [], find: [], status: [], list: [], subscribe: [], emit: [], release: [], claim: [], resolveWorkerSpec: [] };
  const taskOrchestrator = {
    get(id) {
      calls.get.push(id);
      return id === TASK_ID ? { ...current } : null;
    },
    async list() { calls.list.push(); return [{ id: TASK_ID }]; },
    subscribe() { calls.subscribe.push('task'); return () => {}; },
    update() { throw new Error('producer must not mutate task state'); },
    claim() { throw new Error('producer must not claim'); },
    release() { throw new Error('producer must not release'); },
    // Authoritative public registry resolver. 'worker' is a known, enabled spec;
    // unknown profiles throw (mirroring WorkerSpecRegistry.get behavior).
    resolveWorkerSpec(profile, workerModel) {
      calls.resolveWorkerSpec.push([profile, workerModel]);
      if (resolveWorkerSpec) return resolveWorkerSpec(profile, workerModel, current);
      if (profile === 'worker') {
        // Mirror normalizeModelSelection: worker_model is an optional string
        // that may encode "provider/model" or a bare model name.
        const model = {};
        if (typeof workerModel === 'string' && workerModel.trim() !== '') {
          const slash = workerModel.indexOf('/');
          if (slash < 1) model.model = workerModel;
          else { model.provider = workerModel.slice(0, slash); model.model = workerModel.slice(slash + 1); }
        }
        return { name: 'worker', enabled: true, mode: 'session', model };
      }
      throw new Error('unknown worker profile: ' + profile);
    },
  };
  const changeControl = {
    async findByWorkItem(system, id) {
      calls.find.push([system, id]);
      if (id === TASK_ID) return linked ? { id: state.change.id, workItem: { system, id } } : null;
      return null;
    },
    async status(id) { calls.status.push(id); return { state: state.change.state, acceptedPlan: state.change.acceptedPlan }; },
    async findCreatedForTask(id) { calls.find.push(['created', id]); return null; },
  };
  const listeners = new Map();
  const events = {
    emit(name, payload) {
      calls.emit.push([name, payload]);
      for (const fn of listeners.get(name) ?? []) fn(payload);
    },
    on(name, fn) {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
      return () => {};
    },
  };
  return { TASK_ID, current, state, calls, taskOrchestrator, changeControl, events, listeners };
}

const EVENT = 'task-change-control/handoff-requested';
const S = 'trusted-session-S';

test('trusted exec.agent.id arms producer and startup reconciliation emits exactly one handoff request', async () => {
  const h = harness();
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  assert.equal(h.calls.emit.length, 0);
  const arm = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(arm.emitted, 1);
  assert.equal(h.calls.emit.length, 1);
  assert.equal(h.calls.emit[0][0], EVENT);
  assert.deepEqual(h.calls.emit[0][1], {
    taskId: h.TASK_ID,
    runtimeContext: { authenticatedSessionId: S, workerProfile: 'worker' },
  });
  // No task/claim/release/dispatch mutation from the producer.
  assert.deepEqual(h.calls.release, []);
  assert.equal(h.calls.claim?.length ?? 0, 0);
});

test('duplicate subscription/linkage/reconciliation wakeups coalesce to a single request', async () => {
  const h = harness();
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(h.calls.emit.length, 1, 'arm startup reconciliation emits exactly one request');
  // Duplicate wakeup for the same task (subscription hint + linkage-created +
  // reconciliation) is coalesced: no second emission for an already-emitted task.
  const sub = producer.wake(h.TASK_ID);
  const link = producer.wake(h.TASK_ID);
  await Promise.all([sub, link]);
  assert.equal(h.calls.emit.length, 1, 'duplicate wakeups coalesce to one request');
  // A later, distinct wakeup for the same task within the same activation
  // remains coalesced (deduplicated) rather than a second emission.
  await producer.wake(h.TASK_ID);
  assert.equal(h.calls.emit.length, 1);
});

test('missing trusted S fails closed: no emit, no mutation, no release/dispatch', async () => {
  const h = harness();
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const result = await producer.wake(h.TASK_ID);
  assert.equal(result.emitted, 0);
  assert.equal(result.reason, 'NO_TRUSTED_SESSION');
  assert.equal(h.calls.emit.length, 0);
  assert.deepEqual(h.calls.release, []);
});

test('restart after disarm clears S: wake fails closed until re-armed', async () => {
  const h = harness();
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(h.calls.emit.length, 1);
  producer.restart();
  const r = await producer.wake(h.TASK_ID);
  assert.equal(r.emitted, 0);
  assert.equal(r.reason, 'NO_TRUSTED_SESSION');
  assert.equal(h.calls.emit.length, 1, 'restart must not emit for a cleared S');
  // Re-arming re-establishes S (fresh activation) and a new eligible task
  // can emit again.
  await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(h.calls.emit.length, 2, 're-arm permits a fresh emission');
});

test('ambiguous or missing linkage fails closed without emit', async () => {
  const h = harness({ linked: false });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(h.calls.emit.length, 0);
});

test('non-READY Change fails closed without emit', async () => {
  const h = harness({ changeStatus: { state: 'REPAIR' } });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(h.calls.emit.length, 0);
});

test('absent accepted plan fails closed without emit', async () => {
  const h = harness({ changeStatus: { acceptedPlan: null } });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(h.calls.emit.length, 0);
});

test('non-resolvable worker profile fails closed without emit', async () => {
  const h = harness({ task: { worker_profile: '' } });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(h.calls.emit.length, 0);
});

test('task not ready or not ready-to-run fails closed without emit', async () => {
  for (const task of [{ status: 'running' }, { status: 'ready', ready_to_run: false }]) {
    const h = harness({ task });
    const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
    const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
    assert.equal(r.emitted, 0);
    assert.equal(h.calls.emit.length, 0);
  }
});

test('worker-owned execution (active claim) fails closed without emit', async () => {
  const h = harness({ task: { status: 'ready', claimed_by: 'other-worker', claimed_at: 1, lease_expires_at: 2 } });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(h.calls.emit.length, 0);
});

test('conflicting owner (claimed_by set to another S) fails closed', async () => {
  const h = harness({ task: { claimed_by: 'other-S' } });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(h.calls.emit.length, 0);
});

test('producer emits runtimeContext.authenticatedSessionId === S (trusted identity only)', async () => {
  const h = harness();
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  await producer.arm(S, { taskIds: [h.TASK_ID] });
  const [name, payload] = h.calls.emit[0];
  assert.equal(name, EVENT);
  assert.equal(payload.runtimeContext.authenticatedSessionId, S);
  assert.equal(payload.runtimeContext.workerProfile, 'worker');
  assert.equal(payload.taskId, h.TASK_ID);
});

test('producer never calls release/dispatch/claim directly (consumer-only dispatch)', async () => {
  const h = harness();
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  await producer.arm(S, { taskIds: [h.TASK_ID] });
  await producer.wake(h.TASK_ID);
  assert.deepEqual(h.calls.release, []);
  assert.equal(h.calls.claim?.length ?? 0, 0);
});

// ── R2-VER focused additions ───────────────────────────────────────────────

test('R2-VER-003: arm uses authoritative list-based discovery for candidate IDs', async () => {
  const h = harness();
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S);
  assert.equal(r.emitted, 1, 'arm discovers candidate via list and emits');
  assert.equal(h.calls.get.length, 1, 'each candidate is fresh-read');
});

test('R2-VER-003: arm with listFn option uses the provided list function', async () => {
  const h = harness();
  let listFnCalls = 0;
  const listFn = async () => { listFnCalls++; return [{ id: h.TASK_ID }]; };
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events, list: listFn });
  const r = await producer.arm(S);
  assert.equal(r.emitted, 1);
  assert.equal(listFnCalls, 1, 'listFn was used for discovery');
});

test('R2-VER-003: no-payload task notification falls back to authoritative list discovery', async () => {
  const h = harness();
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(h.calls.emit.length, 1);
  // Simulate a no-payload task notification: subscribe fires with no taskId.
  // The producer should discover candidates via authoritative list and skip
  // already-emitted tasks (no duplicate emit).
  const r = await producer.wake('');  // empty taskId → not a valid hint
  assert.equal(r.emitted, 0);
});

// Canonical task ID every authoritative linkage read must be keyed to.
// findByWorkItem returns a Change whose workItem.id must equal the caller's
// task id; any Change linked to a different task id is not this task's
// linkage and must fail closed (LINKAGE_TASK_MISMATCH).
const LINKED_TASK_ID = 'r2-task';

test('R2-VER-005: missing workItem object fails closed (MALFORMED_LINKAGE)', async () => {
  const h = harness();
  h.changeControl.findByWorkItem = async (system, id) => {
    h.calls.find.push([system, id]);
    if (id === h.TASK_ID) return { id: 'change-r2' }; // no workItem key at all
    return null;
  };
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(r.reasons.includes('MALFORMED_LINKAGE'), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-005: wrong workItem.id (linked to a different task) fails closed (LINKAGE_TASK_MISMATCH)', async () => {
  const h = harness();
  h.changeControl.findByWorkItem = async (system, id) => {
    h.calls.find.push([system, id]);
    // The Change is linked to a different task — not the candidate taskId.
    if (id === h.TASK_ID) return { id: 'change-r2', workItem: { system, id: 'some-other-task' } };
    return null;
  };
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(r.reasons.includes('LINKAGE_TASK_MISMATCH'), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-005: malformed linkage (wrong workItem system) fails closed', async () => {
  const h = harness();
  h.changeControl.findByWorkItem = async (system, id) => {
    h.calls.find.push([system, id]);
    if (id === h.TASK_ID) return { id: 'change-r2', workItem: { system: 'other-system', id: h.TASK_ID } };
    return null;
  };
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(r.reasons.includes('LINKAGE_SYSTEM_MISMATCH'), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-005: blank Change ID fails closed', async () => {
  const h = harness();
  h.changeControl.findByWorkItem = async (system, id) => {
    h.calls.find.push([system, id]);
    if (id === h.TASK_ID) return { id: '', workItem: { system, id } };
    return null;
  };
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(r.reasons.includes('MALFORMED_CHANGE_ID'), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-005: orch.get exception fails closed without emit', async () => {
  const h = harness();
  h.taskOrchestrator.get = () => { throw new Error('orch.get unavailable'); };
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-005: cc.findByWorkItem exception fails closed without emit', async () => {
  const h = harness();
  h.changeControl.findByWorkItem = async () => { throw new Error('findByWorkItem unavailable'); };
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(r.reasons.includes('MISSING_LINKAGE'), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-005: cc.status exception fails closed without emit', async () => {
  const h = harness();
  h.changeControl.status = async () => { throw new Error('status unavailable'); };
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(r.reasons.includes('MISSING_CHANGE_STATUS'), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-005: malformed task shape (missing status/ready_to_run) fails closed', async () => {
  const h = harness({ task: {} });
  h.taskOrchestrator.get = (id) => id === h.TASK_ID ? { id } : null; // malformed: no status
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(r.reasons.includes('MALFORMED_TASK'), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-005/006: unknown nonblank worker_profile fails closed — resolver error → NON_RESOLVABLE_PROFILE', async () => {
  // An arbitrary nonblank string that is not a known/resolvable profile must
  // fail closed via the authoritative resolver. The harness resolver throws
  // for any profile other than 'worker', so 'unknown-profile' triggers
  // NON_RESOLVABLE_PROFILE with zero emission.
  const h = harness({ task: { worker_profile: 'unknown-profile' } });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0, 'unknown nonblank profile fails closed');
  assert.equal(r.reasons.includes('NON_RESOLVABLE_PROFILE'), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-006: disabled spec (enabled === false) fails closed — NON_RESOLVABLE_PROFILE', async () => {
  const h = harness({
    task: { worker_profile: 'disabled-profile' },
    resolveWorkerSpec: (profile) => (profile === 'disabled-profile' ? { name: 'disabled-profile', enabled: false } : { name: profile, enabled: true }),
  });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0, 'disabled spec fails closed');
  assert.equal(r.reasons.includes('NON_RESOLVABLE_PROFILE'), true);
});

test('R2-VER-006: resolver exception fails closed — NON_RESOLVABLE_PROFILE', async () => {
  const h = harness({
    task: { worker_profile: 'error-profile' },
    resolveWorkerSpec: () => { throw new Error('registry unavailable'); },
  });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0, 'resolver exception fails closed');
  assert.equal(r.reasons.includes('NON_RESOLVABLE_PROFILE'), true);
});

test('R2-VER-006: resolver returns null fails closed — NON_RESOLVABLE_PROFILE', async () => {
  const h = harness({
    task: { worker_profile: 'null-profile' },
    resolveWorkerSpec: () => null,
  });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0, 'null resolver result fails closed');
  assert.equal(r.reasons.includes('NON_RESOLVABLE_PROFILE'), true);
});

test('R2-VER-006: no resolveWorkerSpec on orchestrator fails closed — arbitrary string never emitted', async () => {
  // When the orchestrator does not expose a public resolver, the producer
  // must fail closed — an arbitrary nonblank string must not be emitted.
  const h = harness();
  delete h.taskOrchestrator.resolveWorkerSpec;
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0, 'arbitrary string is not emitted when no resolver is available');
  assert.equal(r.reasons.includes('NON_RESOLVABLE_PROFILE'), true);
});

test('R2-VER-006: known resolver-confirmed profile emits through the consumer seam', async () => {
  const h = harness(); // default: worker is a known enabled spec
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 1, 'resolver-confirmed profile emits');
  assert.equal(h.calls.emit.length, 1);
  assert.equal(h.calls.resolveWorkerSpec.length, 1, 'resolver was called once');
});

test('R2-VER-007: resolver name mismatch (alias substitution) fails closed — NON_RESOLVABLE_PROFILE', async () => {
  const h = harness({
    task: { worker_profile: 'worker' },
    resolveWorkerSpec: () => ({ name: 'other-profile', enabled: true, mode: 'session' }),
  });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0, 'resolver returning a different name fails closed');
  assert.equal(r.reasons.includes('NON_RESOLVABLE_PROFILE'), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-007: model mismatch (resolver substitutes provider/model) fails closed — NON_RESOLVABLE_PROFILE', async () => {
  const h = harness({
    task: { worker_profile: 'worker', worker_model: 'openai/gpt-4' },
    resolveWorkerSpec: () => ({ name: 'worker', enabled: true, mode: 'session', model: { provider: 'anthropic', model: 'claude-3' } }),
  });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0, 'resolver substituting a different provider/model fails closed');
  assert.equal(r.reasons.includes('NON_RESOLVABLE_PROFILE'), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-007: bare model name mismatch fails closed — NON_RESOLVABLE_PROFILE', async () => {
  const h = harness({
    task: { worker_profile: 'worker', worker_model: 'gpt-4' },
    resolveWorkerSpec: () => ({ name: 'worker', enabled: true, mode: 'session', model: { model: 'gpt-3.5' } }),
  });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0, 'bare model mismatch fails closed');
  assert.equal(r.reasons.includes('NON_RESOLVABLE_PROFILE'), true);
});

test('R2-VER-007: task requested model but resolver returns no model fails closed — NON_RESOLVABLE_PROFILE', async () => {
  const h = harness({
    task: { worker_profile: 'worker', worker_model: 'openai/gpt-4' },
    resolveWorkerSpec: () => ({ name: 'worker', enabled: true, mode: 'session' }),
  });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0, 'missing model field fails closed when task requested a model');
  assert.equal(r.reasons.includes('NON_RESOLVABLE_PROFILE'), true);
});

test('R2-VER-007: valid known profile + matching model emits through the consumer seam', async () => {
  const h = harness({
    task: { worker_profile: 'worker', worker_model: 'openai/gpt-4' },
    resolveWorkerSpec: () => ({ name: 'worker', enabled: true, mode: 'session', model: { provider: 'openai', model: 'gpt-4' } }),
  });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 1, 'valid profile + matching model emits');
  assert.equal(h.calls.emit.length, 1);
  const [, payload] = h.calls.emit[0];
  assert.equal(payload.runtimeContext.workerProfile, 'worker', 'emitted workerProfile is the authoritative resolved name');
});

test('R2-VER-005: non-string worker_profile is not accepted (NON_RESOLVABLE_PROFILE)', async () => {
  const h = harness({ task: { worker_profile: 12345 } });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0);
  assert.equal(r.reasons.includes('NON_RESOLVABLE_PROFILE'), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-004: dispose invokes callable subscribe dispofer and clears state', async () => {
  let disposeCalled = 0;
  const h = harness();
  h.taskOrchestrator.subscribe = () => { disposeCalled++; return () => { disposeCalled += 10; }; };
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(disposeCalled, 1, 'subscribed once');
  producer.dispose();
  assert.equal(disposeCalled, 11, 'disposer invoked on dispose');
});

test('R2-VER-004: re-arm after restart does not double-subscribe', async () => {
  let subCount = 0;
  const h = harness();
  h.taskOrchestrator.subscribe = () => { subCount++; return () => {}; };
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(subCount, 1);
  producer.restart();
  const r2 = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(subCount, 2, 're-subscribes after restart');
  assert.equal(r2.emitted, 1, 're-arm re-establishes S and emits for a fresh eligible task');
});

test('R2-VER-004: second arm within same activation does not re-subscribe', async () => {
  let subCount = 0;
  const h = harness();
  h.taskOrchestrator.subscribe = () => { subCount++; return () => {}; };
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(subCount, 1);
  const r2 = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(subCount, 1, 'no double-subscribe on re-arm without restart');
  assert.equal(r2.reasons.includes('ALREADY_ARMED'), true);
});

test('R2-VER-004: async subscribe disposer is collected and disposed', async () => {
  let disposed = 0;
  const h = harness();
  h.taskOrchestrator.subscribe = () => Promise.resolve(() => { disposed++; });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  await producer.arm(S, { taskIds: [h.TASK_ID] });
  await new Promise((resolve) => setImmediate(resolve)); // let async disposer collect
  producer.dispose();
  assert.equal(disposed, 1, 'async disposer invoked on dispose');
});

test('R2-VER-005: list-vs-get race — task eligible in list but not in fresh get fails closed', async () => {
  const h = harness();
  // list returns a row, but get returns a task that is no longer ready
  h.taskOrchestrator.get = (id) => id === h.TASK_ID
    ? { id, status: 'running', ready_to_run: false, claimed_by: 'worker', claimed_at: 1, lease_expires_at: 999, worker_profile: 'worker' }
    : null;
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S);
  assert.equal(r.emitted, 0, 'fresh get overrides stale list row');
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-005: Change state READY in list but REPAIR in fresh status fails closed', async () => {
  const h = harness();
  // findByWorkItem returns a READY-looking change, but cc.status shows REPAIR
  h.changeControl.status = async () => ({ state: 'REPAIR', acceptedPlan: { id: 'plan-r2' } });
  const producer = createR2HandoffProducer({ taskOrchestrator: h.taskOrchestrator, changeControl: h.changeControl, events: h.events });
  const r = await producer.arm(S, { taskIds: [h.TASK_ID] });
  assert.equal(r.emitted, 0, 'fresh status read takes authority');
  assert.equal(r.reasons.some((x) => x.startsWith('CHANGE_NOT_READY')), true);
  assert.equal(h.calls.emit.length, 0);
});

test('R2-VER-001/005: integrated consumer dispatch — emitted event triggers handoffGovernedDispatch', async () => {
  // End-to-end: producer emits handoff-requested; the existing PR #35 consumer
  // in index.js receives it and calls service.handoffGovernedDispatch.
  const { default: integrationPlugin } = await import('../src/index.js');
  const { Context } = await import('@deepseek-ai/cordis');
  const CTX_TASK_ID = 'integrated-task';
  const ctx = new Context();
  const dispatchCalls = [];
  const releaseCalls = [];
  const taskOrchestrator = {
    get: (id) => ({ id, status: 'running', claimed_by: 'captain-session', worker_profile: 'worker' }),
    release: (id, worker) => { releaseCalls.push([id, worker]); return { released: true }; },
    list: async () => [{ id: CTX_TASK_ID }],
    subscribe: () => () => {},
    createWorkerLauncher: () => ({ async launch() { return { launched: true }; } }),
    createDispatcher: () => ({
      dispatchOnce: async (input) => { dispatchCalls.push(input); return { dispatched: true }; },
    }),
    registerLifecycleGuard: () => () => {},
    updateIf: () => null,
    complete: () => null,
    // Authoritative resolver: 'worker' is a known enabled spec (service.js
    // handoffGovernedDispatch also calls this on the autonomous path).
    resolveWorkerSpec: () => ({ name: 'worker', enabled: true, mode: 'session' }),
  };
  const changeControl = {
    findByWorkItem: async () => ({ id: 'change-1', workItem: { system: 'dsh-task-orchestrator', id: CTX_TASK_ID } }),
    status: async () => ({ state: 'READY', acceptedPlan: { id: 'plan-1' } }),
    getGovernanceMode: () => 'on',
    listByWorkItem: async () => [],
    get: async () => null,
    appendAudit: async () => {},
  };
  ctx.provide('taskOrchestrator', taskOrchestrator);
  ctx.provide('changeControl', changeControl);
  ctx.provide('tools', { register: () => () => {} });
  await ctx.plugin(integrationPlugin);

  // Emit the handoff-requested event that the producer would emit;
  // the consumer in index.js should call handoffGovernedDispatch.
  ctx.events.emit('task-change-control/handoff-requested', {
    taskId: CTX_TASK_ID,
    runtimeContext: { authenticatedSessionId: 'captain-session', workerProfile: 'worker' },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(releaseCalls.length, 1, 'consumer released the controller claim');
  assert.equal(dispatchCalls.length, 1, 'consumer dispatched via governed dispatcher');
  ctx.dispose?.();
});
