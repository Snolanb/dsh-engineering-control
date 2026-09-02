import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { preflightWorker } from '../src/worker-preflight.js'
import { WorkerSpecRegistry } from '../src/worker-specs.js'

function llmFixture({ models = ['ornith-1.5:9b'], efforts = ['low'] } = {}) {
  return {
    listProviders() { return [{ id: 'ollama', name: 'Ollama' }] },
    async listModels(provider) { return provider === 'ollama' ? models.map(id => ({ provider, id, name: id })) : [] },
    async resolveModelInfo() { return { reasoning: { efforts: efforts.map(id => ({ id, name: id })) } } },
  }
}

function registry(workspacePolicy = 'project-only') {
  return new WorkerSpecRegistry({
    ornith: {
      mode: 'headless-profile', profile: 'ornith-filemount-worker', provider: 'ollama', model: 'ornith-1.5:9b', reasoningEffort: 'low',
      workspacePolicy,
    },
    standard: {
      mode: 'session', agentPreset: 'standard', provider: 'ollama', model: 'ornith-1.5:9b', reasoningEffort: 'low',
      workspacePolicy,
    },
  })
}

test('passes preflight when every worker dependency is available', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worker-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const result = await preflightWorker(registry({ type: 'project-only', roots: [root] }), {
    worker_profile: 'ornith', workspace: root,
  }, {
    workspaceRoots: [root],
    profileExists: new Set(['ornith-filemount-worker']),
    launcherExists: new Set(['dsh']),
    llm: llmFixture(),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.checks.map(check => check.name), ['worker_spec', 'workspace', 'profile', 'launcher', 'model'])
  assert.deepEqual(result.selection, { provider: 'ollama', model: 'ornith-1.5:9b', reasoningEffort: 'low' })
})

test('reports unavailable models and unsupported reasoning without throwing', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worker-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const result = await preflightWorker(registry({ type: 'project-only', roots: [root] }), {
    worker_profile: 'ornith', workspace: root,
  }, {
    workspaceRoots: [root],
    profileExists: new Set(['ornith-filemount-worker']),
    launcherExists: new Set(['dsh']),
    llm: llmFixture({ models: [], efforts: [] }),
  })
  assert.equal(result.ok, false)
  assert.ok(result.blockers.some(blocker => blocker.code === 'MODEL_UNAVAILABLE'))
})

test('rejects unsafe workspaces and missing composition resources', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worker-preflight-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'dsh-worker-preflight-outside-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
  const result = await preflightWorker(registry({ type: 'project-only', roots: [root] }), {
    worker_profile: 'ornith', workspace: outside,
  }, {
    workspaceRoots: [root],
    profileExists: new Set(),
    launcherExists: new Set(),
    llm: llmFixture(),
  })
  assert.equal(result.ok, false)
  assert.ok(result.blockers.some(blocker => blocker.code === 'WORKSPACE_OUTSIDE_ROOTS'))
  assert.ok(result.blockers.some(blocker => blocker.code === 'MISSING_PROFILE_UNAVAILABLE'))
  assert.ok(result.blockers.some(blocker => blocker.code === 'MISSING_LAUNCHER_UNAVAILABLE'))
})

test('preflights session workers against an agent preset', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worker-preflight-session-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const result = await preflightWorker(registry('any'), {
    worker_profile: 'standard', workspace: root,
  }, {
    presetExists: new Set(['standard']),
    llm: llmFixture(),
  })
  assert.equal(result.ok, true)
  assert.equal(result.checks.some(check => check.name === 'agent_preset' && check.ok), true)
})

test('returns a structured unknown-profile blocker', async () => {
  const result = await preflightWorker(registry(), { worker_profile: 'missing', workspace: '/tmp' }, { llm: llmFixture() })
  assert.equal(result.ok, false)
  assert.equal(result.blockers[0].code, 'UNKNOWN_WORKER_PROFILE')
})
