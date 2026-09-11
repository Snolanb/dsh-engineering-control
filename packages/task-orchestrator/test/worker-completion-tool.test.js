import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskTools } from '../src/tools.js'
import { buildWorkerCompletionEnvelope, validateWorkerCompletion, workerCompletionOutputSchema, WORKER_COMPLETION_PROTOCOL, WORKER_COMPLETION_TOOL } from '../src/dispatcher.js'
import { TaskStore } from '../src/store.js'

function workerCompleteTool() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-worker-complete-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  const tools = createTaskTools(store)
  const tool = tools.find(t => t.name === WORKER_COMPLETION_TOOL)
  store.close()
  rmSync(dir, { recursive: true, force: true })
  if (!tool) throw new Error('worker_complete tool is not registered in the production tools seam')
  return tool
}

function validArgs(overrides = {}) {
  return {
    commit_sha: 'abc123',
    beforeRevision: 'main@baseline',
    afterRevision: 'abc123',
    files_changed: ['src/x.js'],
    tests_run: ['test/x.test.mjs'],
    remaining_blockers: [],
    criteria: [{ id: 'ship', satisfied: true }],
    summary: 'governed implementation complete',
    ...overrides,
  }
}

test('the production tools seam registers a worker_complete tool with a presentationMeta carrier', () => {
  const tool = workerCompleteTool()
  assert.equal(tool.name, WORKER_COMPLETION_TOOL)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output?.render, 'function')
  assert.equal(typeof tool.output?.presentationMeta, 'function', 'producer must declare output.presentationMeta')
  // Output schema must be the strict 12-key envelope object schema.
  assert.equal(tool.output?.schema?.type, 'object')
  assert.equal(tool.output?.schema?.additionalProperties, false)
  for (const key of ['protocol', 'beforeRevision', 'afterRevision', 'commit_sha', 'files_changed', 'tests_run', 'remaining_blockers', 'criteria', 'deviations', 'workerChecks', 'controllerPreflight', 'summary']) {
    assert.ok(key in tool.output.schema.properties, 'output schema missing envelope field: ' + key)
  }
})

test('the registered worker_complete tool produces the canonical envelope via presentationMeta', async () => {
  const tool = workerCompleteTool()
  const args = validArgs()
  const value = await tool.execute(args, {})
  // protocol is injected by the tool, never trusted from the model.
  assert.equal(value.protocol, WORKER_COMPLETION_PROTOCOL)
  assert.equal(value.commit_sha, 'abc123')
  assert.equal(value.beforeRevision, 'main@baseline')
  assert.equal(value.afterRevision, 'abc123')
  assert.deepEqual(value.files_changed, ['src/x.js'])
  assert.deepEqual(value.tests_run, ['test/x.test.mjs'])
  assert.deepEqual(value.remaining_blockers, [])
  assert.deepEqual(value.criteria, [{ id: 'ship', satisfied: true }])
  assert.deepEqual(value.deviations, [])
  assert.deepEqual(value.workerChecks, [])
  assert.deepEqual(value.controllerPreflight, [])
  assert.equal(value.summary, 'governed implementation complete')
  // presentationMeta must carry the exact envelope the consumer extracts.
  const meta = tool.output.presentationMeta(args, value)
  assert.deepEqual(meta, value)
  // Prove the producer output round-trips through the consumer validator with
  // zero drift (this is the payload that becomes the durable tool/result.meta).
  assert.deepEqual(validateWorkerCompletion(meta), meta)
})

test('worker_complete fails closed on missing commit_sha', async () => {
  const tool = workerCompleteTool()
  const args = validArgs()
  delete args.commit_sha
  // Rejected by the parameter schema (required) — never returns an envelope.
  await assert.rejects(() => tool.execute(args, {}))
})

test('worker_complete fails closed on missing revisions', async () => {
  const tool = workerCompleteTool()
  for (const field of ['beforeRevision', 'afterRevision']) {
    const args = validArgs()
    delete args[field]
    await assert.rejects(() => tool.execute(args, {}))
  }
})

test('worker_complete fails closed on malformed field types', async () => {
  const tool = workerCompleteTool()
  await assert.rejects(() => tool.execute(validArgs({ files_changed: 'not-an-array' }), {}))
  await assert.rejects(() => tool.execute(validArgs({ criteria: [{ id: '', satisfied: 'yes' }] }), {}))
})

test('worker_complete fails closed on a partial result (missing summary)', async () => {
  const tool = workerCompleteTool()
  const args = validArgs()
  delete args.summary
  await assert.rejects(() => tool.execute(args, {}))
})

test('worker_complete semantic validator rejects empty revisions/commit ids (schema cannot)', async () => {
  const tool = workerCompleteTool()
  // The DSH string value schema has no minLength, so empty strings pass the
  // parameter schema; the semantic validator must still fail them closed with
  // the structured WORKER_COMPLETION_INVALID code.
  await assert.rejects(
    () => tool.execute(validArgs({ commit_sha: '' }), {}),
    (e) => e?.code === 'WORKER_COMPLETION_INVALID',
  )
  await assert.rejects(
    () => tool.execute(validArgs({ beforeRevision: '  ' }), {}),
    (e) => e?.code === 'WORKER_COMPLETION_INVALID',
  )
})

test('buildWorkerCompletionEnvelope and workerCompletionOutputSchema agree on the 12-key contract', () => {
  const envelope = buildWorkerCompletionEnvelope(validArgs())
  assert.equal(envelope.protocol, WORKER_COMPLETION_PROTOCOL)
  assert.deepEqual(Object.keys(envelope).sort(), ['afterRevision', 'beforeRevision', 'commit_sha', 'controllerPreflight', 'criteria', 'deviations', 'files_changed', 'protocol', 'remaining_blockers', 'summary', 'tests_run', 'workerChecks'].sort())
  const schema = workerCompletionOutputSchema()
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(envelope).sort())
})