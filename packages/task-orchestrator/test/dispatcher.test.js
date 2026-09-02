import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStore } from '../src/store.js'
import { WorkerDispatcher, buildTaskPrompt, createSessionLauncher, createSessionRpcClient } from '../src/dispatcher.js'
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
