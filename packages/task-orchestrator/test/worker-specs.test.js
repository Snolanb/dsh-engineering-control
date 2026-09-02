import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkerSpecError, WorkerSpecRegistry, mergeModelSelection, normalizeModelSelection, normalizeWorkerSpec } from '../src/worker-specs.js'

test('normalizes named worker specs and resolves model overrides', () => {
  const registry = new WorkerSpecRegistry({
    ornith: {
      mode: 'headless-profile',
      profile: 'ornith-filemount-worker',
      provider: 'ollama',
      model: 'ornith-1.5:9b',
      reasoningEffort: 'low',
      plugins: ['dsh-small-model-guard', 'dsh-file-mount'],
      workspacePolicy: { type: 'project-only', roots: ['/workspace'] },
    },
    minimax: {
      mode: 'session',
      agentPreset: 'standard',
      provider: 'minimax-cn',
      model: 'MiniMax-M3',
      reasoningEffort: 'high',
    },
  })

  assert.deepEqual(registry.list().map(spec => spec.name), ['ornith', 'minimax'])
  assert.deepEqual(registry.get('ornith').plugins, ['dsh-file-mount', 'dsh-small-model-guard'])
  assert.deepEqual(registry.resolve('minimax').model, {
    provider: 'minimax-cn', model: 'MiniMax-M3', reasoningEffort: 'high',
  })
  assert.deepEqual(registry.resolve('minimax', 'openai-codex/gpt-5.6-luna').model, {
    provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'high',
  })
  assert.deepEqual(registry.resolve('minimax', { reasoningEffort: 'medium' }).model, {
    provider: 'minimax-cn', model: 'MiniMax-M3', reasoningEffort: 'medium',
  })
})

test('normalizes model strings and rejects invalid worker specs', () => {
  assert.deepEqual(normalizeModelSelection('ollama/ornith-1.5:9b'), { provider: 'ollama', model: 'ornith-1.5:9b' })
  assert.deepEqual(mergeModelSelection({ provider: 'ollama', model: 'ornith' }, 'ornith-1.5:9b'), { provider: 'ollama', model: 'ornith-1.5:9b' })
  assert.throws(() => normalizeWorkerSpec('missing-profile', { mode: 'headless-profile', provider: 'ollama', model: 'ornith' }), WorkerSpecError)
  assert.throws(() => normalizeWorkerSpec('missing-preset', { mode: 'session', provider: 'minimax-cn', model: 'MiniMax-M3' }), error => error.code === 'INVALID_WORKER_SPEC')
  assert.throws(() => new WorkerSpecRegistry({ duplicate: null }), error => error.code === 'INVALID_WORKER_SPEC')
})

test('returns immutable normalized specs', () => {
  const spec = normalizeWorkerSpec('worker', {
    mode: 'session', agentPreset: 'standard', provider: 'openai-codex', model: 'gpt-5.6-luna',
  })
  assert.equal(Object.isFrozen(spec), true)
  assert.equal(Object.isFrozen(spec.model), true)
  assert.equal(Object.isFrozen(spec.workspacePolicy), true)
})
