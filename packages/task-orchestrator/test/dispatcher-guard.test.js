import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStore } from '../src/store.js'
import { WorkerDispatcher } from '../src/dispatcher.js'
import { WorkerSpecRegistry } from '../src/worker-specs.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dispatcher-guard-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  const registry = new WorkerSpecRegistry({
    worker: {
      mode: 'headless-profile', profile: 'worker-profile', provider: 'ollama', model: 'worker-model',
      workspacePolicy: 'any', timeoutMs: 1000, leaseSeconds: 30,
    },
  })
  return { dir, store, registry, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function readyTask(f, id = 'guard-task') {
  return f.store.create({
    id, title: 'Guard task', description: 'Do the bounded work.', status: 'ready', workspace: f.dir,
    worker_profile: 'worker', acceptance_criteria: ['ship it'],
  })
}

test('no preDispatch guard: default no-op preserves dispatch byte-for-byte', async t => {
  const f = fixture(); t.after(() => f.cleanup())
  const task = readyTask(f)
  const launched = []
  const dispatcher = new WorkerDispatcher({
    store: f.store,
    registry: f.registry,
    idFactory: () => 'run-g1',
    preflight: async () => ({ ok: true, spec: f.registry.get('worker') }),
    launcher: { async launch(input) { launched.push(input); return { wait: async () => ({ exitCode: 0, stdout: 'done', stderr: '' }) } } },
  })
  const result = await dispatcher.dispatchTask(task)
  assert.equal(result.status, 'in_review')
  assert.equal(launched.length, 1)
})

test('rejected preDispatch guard aborts BEFORE launch, releases the claim, and carries the structured guard result', async t => {
  const f = fixture(); t.after(() => f.cleanup())
  const task = readyTask(f)
  const launched = []
  const verdict = { ok: false, code: 'DISPATCH_NOT_GOVERNED', preconditions: [{ name: 'linked_change', satisfied: false }] }
  const dispatcher = new WorkerDispatcher({
    store: f.store,
    registry: f.registry,
    idFactory: () => 'run-g2',
    preflight: async () => ({ ok: true, spec: f.registry.get('worker') }),
    launcher: { async launch(input) { launched.push(input); return { wait: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } } },
    preDispatch: async ({ task: t2, worker }) => {
      assert.equal(t2.id, task.id)
      assert.ok(worker) // claims happen before the guard: the valid claim is a precondition input
      return verdict
    },
  })
  const result = await dispatcher.dispatchTask(task)
  assert.equal(result.dispatched, false)
  assert.equal(result.reason, 'dispatch_not_governed')
  assert.deepEqual(result.predispatch, verdict)
  assert.equal(launched.length, 0, 'guard rejection must precede launch')
  const after = f.store.get(task.id)
  assert.equal(after.status, 'ready', 'claim released back to ready')
  assert.equal(after.claimed_by, null)
})

test('approving preDispatch guard dispatches normally', async t => {
  const f = fixture(); t.after(() => f.cleanup())
  const task = readyTask(f)
  const dispatcher = new WorkerDispatcher({
    store: f.store,
    registry: f.registry,
    idFactory: () => 'run-g3',
    preflight: async () => ({ ok: true, spec: f.registry.get('worker') }),
    launcher: { async launch() { return { wait: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) } } },
    preDispatch: async () => ({ ok: true }),
  })
  const result = await dispatcher.dispatchTask(task)
  assert.equal(result.dispatched, true)
  assert.equal(result.status, 'in_review')
})
