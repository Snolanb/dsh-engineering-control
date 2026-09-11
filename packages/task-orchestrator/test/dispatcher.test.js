import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStore } from '../src/store.js'
import { WorkerDispatcher, buildTaskPrompt, createSessionLauncher, createSessionRpcClient, createWorkerLauncher } from '../src/dispatcher.js'
import { createBindingLauncher } from '../../task-change-control/src/binding.js'
import { WorkerSpecRegistry } from '../src/worker-specs.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dispatcher-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  const registry = new WorkerSpecRegistry({
    worker: {
      mode: 'headless-profile', profile: 'worker-profile', provider: 'ollama', model: 'worker-model',
      workspacePolicy: 'any', timeoutMs: 1000, leaseSeconds: 30,
    },
  })
  return { dir, store, registry, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function readyTask(f, id = 'dispatch-task') {
  return f.store.create({
    id, title: 'Dispatch task', description: 'Do the bounded work.', status: 'ready', workspace: f.dir,
    worker_profile: 'worker', acceptance_criteria: ['change the file', 'run the tests'],
  })
}

test('dispatches a task through claim, start, lease ownership, and completion', async t => {
  const f = fixture(); t.after(() => f.cleanup())
  const task = readyTask(f)
  const launches = []
  const dispatcher = new WorkerDispatcher({
    store: f.store,
    registry: f.registry,
    idFactory: () => 'run-1',
    actor: 'test-dispatcher',
    preflight: async () => ({ ok: true, spec: f.registry.get('worker') }),
    launcher: { async launch(input) { launches.push(input); return { wait: async () => ({ exitCode: 0, stdout: 'worker completed', stderr: '' }), async terminate() {} } } },
  })
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' })
  assert.equal(result.status, 'in_review')
  assert.equal(result.task.status, 'in_review')
  assert.equal(result.task.attempts, 1)
  assert.equal(result.worker, 'worker:run-1')
  assert.equal(launches[0].task.id, task.id)
  assert.match(launches[0].runId, /^worker:run-1$/)
  assert.match(result.task.result_summary, /worker completed/)
  assert.ok(f.store.events(task.id).some(event => event.event_type === 'task_claimed'))
  assert.ok(f.store.events(task.id).some(event => event.event_type === 'task_started'))
})

test('does not consume an attempt when preflight fails', async t => {
  const f = fixture(); t.after(() => f.cleanup())
  const task = readyTask(f)
  const dispatcher = new WorkerDispatcher({
    store: f.store,
    registry: f.registry,
    preflight: async () => ({ ok: false, blockers: [{ code: 'MODEL_UNAVAILABLE', message: 'not loaded' }] }),
    launcher: { async launch() { throw new Error('must not launch') } },
  })
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' })
  assert.equal(result.reason, 'preflight_failed')
  assert.equal(result.task.id, task.id)
  assert.equal(f.store.get(task.id).status, 'ready')
  assert.equal(f.store.get(task.id).attempts, 0)
})

test('releases a claim when the worker cannot launch', async t => {
  const f = fixture(); t.after(() => f.cleanup())
  const task = readyTask(f)
  const dispatcher = new WorkerDispatcher({
    store: f.store,
    registry: f.registry,
    idFactory: () => 'run-launch-failure',
    preflight: async () => ({ ok: true, spec: f.registry.get('worker') }),
    launcher: { async launch() { throw new Error('profile failed to start') } },
  })
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' })
  assert.equal(result.reason, 'launch_failed')
  assert.match(result.error, /profile failed to start/)
  assert.equal(f.store.get(task.id).status, 'ready')
  assert.equal(f.store.get(task.id).claimed_by, null)
  assert.equal(f.store.get(task.id).attempts, 0)
})

test('fails a task when the worker exits unsuccessfully', async t => {
  const f = fixture(); t.after(() => f.cleanup())
  const task = readyTask(f)
  const dispatcher = new WorkerDispatcher({
    store: f.store,
    registry: f.registry,
    preflight: async () => ({ ok: true, spec: f.registry.get('worker') }),
    launcher: { async launch() { return { wait: async () => ({ exitCode: 7, stdout: '', stderr: 'tests failed' }), async terminate() {} } } },
  })
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' })
  assert.equal(result.status, 'failed')
  assert.equal(result.task.status, 'failed')
  assert.match(result.task.result_summary, /tests failed/)
  assert.deepEqual(result.task.remaining_blockers, ['worker exited unsuccessfully'])
})

test('builds a bounded task prompt from the persisted task record', () => {
  const prompt = buildTaskPrompt({
    id: 'task/one', title: 'Bounded change', description: 'Change one thing.', workspace: '/repo',
    acceptance_criteria: ['first', 'second'],
  }, { name: 'ornith-filemount' }, 'run-1')
  assert.match(prompt, /task\/one/)
  assert.match(prompt, /1\. first/)
  assert.match(prompt, /Do not modify unrelated files/)
})


test('session launcher selects the model before prompting and polls completion', async () => {
  const calls = []
  let historyCalls = 0
  const launcher = createSessionLauncher({
    pollIntervalMs: 0,
    rpc: {
      async call(method, payload) {
        calls.push({ method, payload })
        if (method === 'session.create') return { sessionId: 'session-1' }
        if (method === 'session.history') {
          historyCalls += 1
          if (historyCalls === 1) return { events: [] }
          return { events: [
            { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
            { event: { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'session completed' }] } } } },
            { event: { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } } },
          ] }
        }
        return { accepted: true }
      },
    },
  })
  const handle = await launcher.launch({
    task: { id: 'session-task', title: 'Session task', description: 'Do it.', workspace: '/repo', acceptance_criteria: [] },
    spec: { name: 'minimax-standard', mode: 'session', agentPreset: 'standard', model: { provider: 'minimax-cn', model: 'MiniMax-M3', reasoningEffort: 'high' } },
    runId: 'session-run-1',
  })
  const result = await handle.wait()
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'session completed')
  assert.deepEqual(calls.slice(0, 4).map(call => call.method), ['session.create', 'session.selectModel', 'session.history', 'session.prompt'])
  assert.deepEqual(calls[1].payload, { sessionId: 'session-1', provider: 'minimax-cn', model: 'MiniMax-M3', reasoningEffort: 'high' })
  assert.equal(calls[3].payload.sessionId, 'session-1')
})

test('session launcher classifies a terminal model error as failure', async () => {
  let historyCalls = 0
  const launcher = createSessionLauncher({
    pollIntervalMs: 0,
    rpc: { async call(method) {
      if (method === 'session.create') return { sessionId: 'session-error' }
      if (method === 'session.history') {
        historyCalls += 1
        return historyCalls === 1 ? { events: [] } : { events: [{ event: { seq: 1, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'provider failed' } } } } }] }
      }
      return { accepted: true }
    } },
  })
  const handle = await launcher.launch({
    task: { id: 'session-error-task', title: 'Error task', workspace: '/repo' },
    spec: { name: 'luna-max', mode: 'session', agentPreset: 'standard', model: { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' } },
    runId: 'session-error-run',
  })
  const result = await handle.wait()
  assert.equal(result.exitCode, 1)
  assert.match(result.stderr, /provider failed/)
})

// ─── Canonical worker-completion protocol (T-H9) ──────────────────────────

// The canonical DSH-native carrier: a worker-scoped ToolRuntime completion tool
// whose output.presentationMeta() carries the strict envelope below. DSH appends
// that meta verbatim to the durable `tool/result` SessionEvent, which the host
// session.history RPC returns as a raw event; the session launcher correlates
// `tool/call` (name + callId) with `tool/result` (toolCallId + meta) after its
// baseline sequence and surfaces the envelope on the wait() outcome — no
// assistant-prose parsing, no fabricated proof.
const WORKER_COMPLETION_PROTOCOL = 'dsh.worker-completion.v1'

function completionEnvelope(overrides = {}) {
  return {
    protocol: WORKER_COMPLETION_PROTOCOL,
    beforeRevision: 'main@baseline',
    afterRevision: 'abc123',
    commit_sha: 'abc123',
    files_changed: ['src/x.js'],
    tests_run: ['test/x.test.mjs'],
    remaining_blockers: [],
    criteria: [{ id: 'ship', satisfied: true }],
    deviations: [],
    workerChecks: ['tests green'],
    controllerPreflight: ['pass:build'],
    summary: 'governed implementation complete',
    ...overrides,
  }
}

function completionEvents(seqBase, meta, { callId = 'call-1', name = 'worker_complete' } = {}) {
  return [
    { event: { seq: seqBase + 1, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: seqBase + 2, type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: '{}' } } },
    { event: { seq: seqBase + 3, type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'done' }], isError: false }] }, meta } } },
    { event: { seq: seqBase + 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'session completed' }] } } } },
    { event: { seq: seqBase + 5, type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ]
}

function createCompletionRpc({ historyCalls, events }) {
  return {
    async call(method) {
      if (method === 'session.create') return { sessionId: 'session-1' }
      if (method === 'session.history') {
        historyCalls.push('history')
        return historyCalls.length === 1 ? { events: [] } : { events }
      }
      return { accepted: true }
    },
  }
}

async function launchCompletionSession(events) {
  const historyCalls = []
  const launcher = createSessionLauncher({
    pollIntervalMs: 0,
    rpc: createCompletionRpc({ historyCalls, events }),
  })
  const handle = await launcher.launch({
    task: { id: 'session-task', title: 'Session task', description: 'Do it.', workspace: '/repo', acceptance_criteria: ['ship'] },
    spec: { name: 'minimax-standard', mode: 'session', agentPreset: 'standard' },
    runId: 'session-run-1',
  })
  return { handle, historyCalls }
}

test('session launcher surfaces the canonical worker-completion envelope from tool/result meta', async () => {
  const { handle } = await launchCompletionSession(completionEvents(0, completionEnvelope()))
  const result = await handle.wait()
  assert.equal(result.exitCode, 0)
  assert.equal(result.commit_sha, 'abc123')
  assert.equal(result.beforeRevision, 'main@baseline')
  assert.equal(result.afterRevision, 'abc123')
  assert.deepEqual(result.files_changed, ['src/x.js'])
  assert.deepEqual(result.tests_run, ['test/x.test.mjs'])
  assert.deepEqual(result.remaining_blockers, [])
  assert.deepEqual(result.criteria, [{ id: 'ship', satisfied: true }])
  assert.deepEqual(result.deviations, [])
  assert.deepEqual(result.workerChecks, ['tests green'])
  assert.deepEqual(result.controllerPreflight, ['pass:build'])
  assert.equal(result.summary, 'governed implementation complete')
})

test('session launcher fails closed when the completion tool emits no valid result (missing structured result)', async () => {
  // The worker emitted the completion tool call but its result meta carries a
  // non-completion protocol — the structured completion never materialised.
  const events = completionEvents(0, completionEnvelope({ protocol: 'other.protocol' }))
  const { handle } = await launchCompletionSession(events)
  const result = await handle.wait()
  assert.notEqual(result.exitCode, 0)
  assert.match(result.error ?? result.stderr, /worker-completion|WORKER_COMPLETION/)
})

test('session launcher leaves text-only outcome (exit 0) when no completion tool was called', async () => {
  // A worker/reviewer session that never calls the completion tool completes
  // with a text-only outcome and NO proof fields — the governed hook (not the
  // launcher) rejects the missing commit_sha fail-closed downstream.
  const historyCalls = []
  const launcher = createSessionLauncher({
    pollIntervalMs: 0,
    rpc: {
      async call(method) {
        if (method === 'session.create') return { sessionId: 'session-1' }
        if (method === 'session.history') {
          historyCalls.push('history')
          return historyCalls.length === 1 ? { events: [] } : { events: [
            { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
            { event: { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'plain done' }] } } } },
            { event: { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } } },
          ] }
        }
        return { accepted: true }
      },
    },
  })
  const handle = await launcher.launch({
    task: { id: 't', title: 't', workspace: '/repo' },
    spec: { name: 's', mode: 'session', agentPreset: 'standard' },
    runId: 'r',
  })
  const result = await handle.wait()
  assert.equal(result.exitCode, 0)
  assert.equal(result.commit_sha, undefined)
})

test('session launcher fails closed when commit_sha is missing', async () => {
  const meta = completionEnvelope()
  delete meta.commit_sha
  const { handle } = await launchCompletionSession(completionEvents(0, meta))
  const result = await handle.wait()
  assert.notEqual(result.exitCode, 0)
  assert.match(result.error ?? result.stderr, /commit_sha/)
})

test('session launcher fails closed on malformed field types', async () => {
  const { handle } = await launchCompletionSession(completionEvents(0, completionEnvelope({ files_changed: 'not-an-array' })))
  const result = await handle.wait()
  assert.notEqual(result.exitCode, 0)
})

test('session launcher fails closed on a partial result (missing required field)', async () => {
  const meta = completionEnvelope()
  delete meta.beforeRevision
  const { handle } = await launchCompletionSession(completionEvents(0, meta))
  const result = await handle.wait()
  assert.notEqual(result.exitCode, 0)
  assert.match(result.error ?? result.stderr, /beforeRevision/)
})

test('session launcher fails closed on duplicate/replayed completion results', async () => {
  const base = 0
  const events = [
    ...completionEvents(base, completionEnvelope()),
    ...completionEvents(base + 5, completionEnvelope({ afterRevision: 'def456', commit_sha: 'def456' }), { callId: 'call-2' }),
  ]
  const { handle } = await launchCompletionSession(events)
  const result = await handle.wait()
  assert.notEqual(result.exitCode, 0)
})

test('session launcher ignores stale completion results before the baseline sequence', async () => {
  // A completion tool/result from a PRIOR turn (seq <= baselineSeq) must not
  // be surfaced: the current completed turn carried no fresh completion call,
  // so the outcome is text-only (stale proof is never silently re-surfaced).
  const historyCalls = []
  const launcher = createSessionLauncher({
    pollIntervalMs: 0,
    rpc: {
      async call(method) {
        if (method === 'session.create') return { sessionId: 'session-1' }
        if (method === 'session.history') {
          historyCalls.push('history')
          // Baseline poll already carried a prior turn with a completion meta;
          // the subsequent poll yields only a fresh completed turn/end with no
          // completion tool call after the baseline.
          if (historyCalls.length === 1) {
            return { events: [
              { event: { seq: 1, type: 'tool/result', data: { turn: 0, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'stale-call', content: [], isError: false }] }, meta: completionEnvelope() } } },
            ] }
          }
          return { events: [
            { event: { seq: 2, type: 'turn/start', data: { turn: 1 } } },
            { event: { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'fresh turn done' }] } } } },
            { event: { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } } },
          ] }
        }
        return { accepted: true }
      },
    },
  })
  const handle = await launcher.launch({
    task: { id: 't', title: 't', workspace: '/repo' },
    spec: { name: 's', mode: 'session', agentPreset: 'standard' },
    runId: 'r',
  })
  const result = await handle.wait()
  assert.equal(result.exitCode, 0)
  assert.equal(result.commit_sha, undefined, 'stale pre-baseline completion is not surfaced')
})

test('session launcher fails closed on session identity mismatch (mismatched callId)', async () => {
  // The tool/result's toolCallId does not match any tool/call, so the result
  // cannot be attributed to this session's own completion call.
  const events = [
    { event: { seq: 1, type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'orphan-call', content: [], isError: false }] }, meta: completionEnvelope() } } },
    { event: { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ]
  const { handle } = await launchCompletionSession(events)
  const result = await handle.wait()
  assert.notEqual(result.exitCode, 0)
})

test('headless launcher does not fabricate structured proof (explicit proof-unavailable)', async () => {
  // The headless launcher only captures process text; it must NOT invent
  // commit_sha/files_changed/tests_run. Its wait() outcome is text-only,
  // which the governed completion hook rejects (never silent proof).
  const launcher = createWorkerLauncher()
  const headlessSpec = { name: 'headless-worker', mode: 'headless-profile', profile: 'p', command: process.execPath, timeoutMs: 1000, leaseSeconds: 30 }
  const launched = await launcher.launch({
    task: { id: 'h', title: 'h', description: '', workspace: '/repo', acceptance_criteria: [] },
    spec: headlessSpec,
    runId: 'h-run',
  })
  const result = await launched.wait()
  assert.deepEqual(result.commit_sha, undefined, 'headless outcome carries no commit_sha')
  assert.deepEqual(result.files_changed, undefined, 'headless outcome carries no files_changed')
  assert.deepEqual(result.tests_run, undefined, 'headless outcome carries no tests_run')
})

test('completionHook routes governed success through the hook instead of raw store.complete', async t => {
  const f = fixture(); t.after(() => f.cleanup())
  const task = readyTask(f)
  let hookCalled = false
  let hookTaskId = null
  let hookOpts = null
  const hook = async (taskId, result, opts = {}) => {
    hookCalled = true
    hookTaskId = taskId
    hookOpts = opts
    // Delegate to the store so the task reaches in_review
    return f.store.complete(taskId, result, { worker: opts.worker, actor: 'test-dispatcher' })
  }
  const launcherWithSession = {
    async launch() { return { sessionId: 'sess-123', wait: async () => ({ exitCode: 0, stdout: 'done', stderr: '' }), async terminate() {} } }
  }
  const dispatcher = new WorkerDispatcher({
    store: f.store,
    registry: f.registry,
    idFactory: () => 'run-hook',
    actor: 'test-dispatcher',
    preflight: async () => ({ ok: true, spec: f.registry.get('worker') }),
    launcher: launcherWithSession,
    completionHook: hook,
  })
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' })
  assert.equal(result.status, 'in_review')
  assert.equal(result.task.status, 'in_review')
  assert.equal(hookCalled, true, 'completionHook must be invoked on governed success')
  assert.equal(hookTaskId, task.id)
  assert.equal(hookOpts.sessionId, 'sess-123', 'sessionId must be threaded from launcher handle')
  assert.equal(hookOpts.worker, 'worker:run-hook')
})

test('raw store.complete is used when completionHook is absent (backwards compatibility)', async t => {
  const f = fixture(); t.after(() => f.cleanup())
  const task = readyTask(f)
  let rawCompleteCalled = false
  // Wrap the store so complete() tracks the call but delegates to the real store
  const store = {
    list: (...a) => f.store.list(...a),
    create: (...a) => f.store.create(...a),
    get: (...a) => f.store.get(...a),
    update: (...a) => f.store.update(...a),
    updateIf: (...a) => f.store.updateIf(...a),
    delete: (...a) => f.store.delete(...a),
    claim: (...a) => f.store.claim(...a),
    release: (...a) => f.store.release(...a),
    renewLease: (...a) => f.store.renewLease(...a),
    start: (...a) => f.store.start(...a),
    complete(id, result, opts) { rawCompleteCalled = true; return f.store.complete(id, result, opts); },
    fail: (...a) => f.store.fail(...a),
    block: (...a) => f.store.block(...a),
    unblock: (...a) => f.store.unblock(...a),
    requestChanges: (...a) => f.store.requestChanges(...a),
    addDependency: (...a) => f.store.addDependency(...a),
    removeDependency: (...a) => f.store.removeDependency(...a),
    addTaskLink: (...a) => f.store.addTaskLink(...a),
    removeTaskLink: (...a) => f.store.removeTaskLink(...a),
    listTaskLinks: (...a) => f.store.listTaskLinks(...a),
    setCriterionResults: (...a) => f.store.setCriterionResults(...a),
    addChild: (...a) => f.store.addChild(...a),
    listChildren: (...a) => f.store.listChildren(...a),
    listDescendants: (...a) => f.store.listDescendants(...a),
    readyToRun: (...a) => f.store.readyToRun(...a),
    blockedByDependencies: (...a) => f.store.blockedByDependencies(...a),
    events: (...a) => f.store.events(...a),
    subscribe: (...a) => f.store.subscribe(...a),
    close: () => f.store.close(),
  }
  const dispatcher = new WorkerDispatcher({
    store,
    registry: f.registry,
    idFactory: () => 'run-raw',
    actor: 'test-dispatcher',
    preflight: async () => ({ ok: true, spec: f.registry.get('worker') }),
    launcher: { async launch() { return { wait: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) } } },
  })
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' })
  assert.equal(result.status, 'in_review')
  assert.equal(rawCompleteCalled, true, 'raw store.complete is called when no hook is provided')
})

test('governed completion observes the bound session before cleanup', async t => {
  const f = fixture(); t.after(() => f.cleanup())
  const task = readyTask(f, 'dispatch-governed-lifetime')
  const registry = new WorkerSpecRegistry({
    worker: {
      name: 'session-worker', mode: 'session', profile: 'worker-profile', agentPreset: 'worker', provider: 'ollama', model: 'worker-model',
      workspacePolicy: 'any', timeoutMs: 1000, leaseSeconds: 30,
    },
  })
  const events = []
  const changeControl = {
    async findByWorkItem() { return { id: 'change-lifetime' } },
    async bindRole() { events.push('bind') },
    getBindingSync() { return { changeId: 'change-lifetime', sessionId: 'session-lifetime', role: 'worker', worker: 'worker:run-lifetime' } },
    async unbindRole() { events.push('unbind') },
  }
  const rawLauncher = {
    async launch() {
      return {
        sessionId: 'session-lifetime',
        wait: async () => { events.push('wait'); return { exitCode: 0, stdout: 'done', stderr: '' } },
        async terminate() { return true },
      }
    },
  }
  const dispatcher = new WorkerDispatcher({
    store: f.store,
    registry,
    idFactory: () => 'run-lifetime',
    preflight: async () => ({ ok: true, spec: registry.get('worker') }),
    launcher: createBindingLauncher(rawLauncher, changeControl, 'dsh-task-orchestrator'),
    completionHook: async (taskId, result, options) => {
      assert.equal(options.sessionId, 'session-lifetime')
      assert.equal(changeControl.getBindingSync('change-lifetime', options.sessionId).worker, options.worker)
      const completed = f.store.complete(taskId, result, { worker: options.worker, actor: 'test-dispatcher' })
      events.push('completion')
      return completed
    },
  })
  const result = await dispatcher.dispatchOnce({ workerProfile: 'worker' })
  assert.equal(result.status, 'in_review')
  assert.deepEqual(events, ['bind', 'wait', 'completion', 'unbind'])
})

test('session RPC client sends DSH envelopes and surfaces structured errors', async () => {
  const requests = []
  const rpc = createSessionRpcClient({
    baseUrl: 'http://127.0.0.1:3080/api/',
    idFactory: () => 'rpc-1',
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return { ok: true, status: 200, async json() { return { result: { ok: true, value: { accepted: true } } } } }
    },
  })
  assert.deepEqual(await rpc.call('session.prompt', { sessionId: 's1' }), { accepted: true })
  assert.equal(requests[0].url, 'http://127.0.0.1:3080/api/session.prompt')
  assert.equal(JSON.parse(requests[0].init.body).rpcId, 'task-dispatch-rpc-1')
})
