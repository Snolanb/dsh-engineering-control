import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as taskOrchestrator from '../src/index.js'
import { apply } from '../src/index.js'

test('registers the task service, DSH tools, and HTTP route', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-plugin-'))
  const routes = []
  const registeredTools = []
  const services = new Map()
  const cleanups = []
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {} } },
    tools: { register(tool) { registeredTools.push(tool); return () => {} } },
    provide(name, value) { services.set(name, value); return () => services.delete(name) },
    effect(factory) { const cleanup = factory(); cleanups.push(cleanup); return cleanup },
  }
  t.after(() => { for (const cleanup of cleanups) cleanup(); rmSync(dir, { recursive: true, force: true }) })

  apply(ctx, {
    dbPath: join(dir, 'tasks.db'),
    defaultLeaseSeconds: 30,
    workspaceRoots: [dir],
    workerSpecs: { ornith: { mode: 'headless-profile', profile: 'ornith-filemount-worker', provider: 'ollama', model: 'ornith-1.5:9b' } },
  })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/api/task-orchestrator')
  assert.ok(registeredTools.length >= 30)
  for (const name of ['task_create', 'task_claim', 'task_add_dependency', 'task_add_link', 'task_set_criterion_results', 'project_create', 'project_update', 'project_delete', 'milestone_create', 'milestone_update', 'milestone_delete', 'plan_import_preview', 'plan_import_apply']) {
    assert.ok(registeredTools.some(tool => tool.name === name), `missing tool: ${name}`)
  }
  const api = services.get('taskOrchestrator')
  assert.ok(api)
  assert.equal(api.workerSpecs().length, 1)
  assert.equal(api.getWorkerSpec('ornith').profile, 'ornith-filemount-worker')
  const task = api.create({ id: 'service-task', title: 'Service task' })
  assert.equal(api.get(task.id).title, 'Service task')
  const project = api.createProject({ id: 'service-project', title: 'Service project' })
  assert.equal(api.getProject(project.id).id, 'service-project')
  api.deleteProject(project.id)
})

test('production preflight uses Cordis LLM and preset catalogs and fails closed on unavailable resources', async t => {
  assert.deepEqual(taskOrchestrator.inject, ['webServer', 'tools', 'llm', 'agentPresets'])

  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-preflight-composition-'))
  const ctx = new Context()
  const calls = { providers: 0, callConfigs: [], presets: 0 }
  let providers = [{ id: 'openai-codex', name: 'OpenAI Codex' }]
  let routable = true
  const llm = {
    listProviders() {
      calls.providers++
      return providers
    },
    async resolveCallConfig(config) {
      calls.callConfigs.push(config)
      if (!routable) throw Object.assign(new Error('unknown model'), { code: 'UNKNOWN_MODEL' })
      return config
    },
  }

  ctx.provide('webServer', { register() { return () => {} } })
  ctx.provide('tools', { register() { return () => {} } })
  ctx.provide('llm', llm)
  ctx.provide('agentPresets', { async list() { calls.presets++; return [{ id: 'standard' }] } })
  ctx.provide('sessionController', {
    async create() { return { sessionId: 'session-1' } },
    async selectModel() { return { selected: { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'medium' } } },
    async inspect() { return { events: [] } },
    async prompt() { return { accepted: true } },
    async cancel() { return { accepted: true } },
  })
  const fiber = ctx.plugin(taskOrchestrator, {
    dbPath: join(dir, 'tasks.db'),
    workerSpecs: {
      worker: {
        mode: 'session', agentPreset: 'standard', provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'medium',
        workspacePolicy: 'any',
      },
    },
  })
  await fiber
  t.after(async () => {
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const api = ctx.get('taskOrchestrator')
  const request = { worker_profile: 'worker', workspace: dir }
  const valid = await api.preflightWorker(request)
  assert.equal(valid.ok, true)
  assert.equal(valid.checks.find(check => check.name === 'agent_preset').ok, true)
  assert.equal(valid.checks.find(check => check.name === 'model').ok, true)
  assert.deepEqual(valid.checks.map(check => check.name), ['worker_spec', 'workspace', 'agent_preset', 'model'])
  assert.equal(calls.providers, 1)
  assert.deepEqual(calls.callConfigs, [{ provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'medium' }])

  providers = []
  const unavailableProvider = await api.preflightWorker(request)
  assert.equal(unavailableProvider.ok, false)
  assert.ok(unavailableProvider.blockers.some(blocker => blocker.code === 'PROVIDER_UNAVAILABLE'))
  assert.equal(calls.callConfigs.length, 1)

  providers = [{ id: 'openai-codex', name: 'OpenAI Codex' }]
  routable = false
  const unavailableModel = await api.preflightWorker(request)
  assert.equal(unavailableModel.ok, false)
  assert.ok(unavailableModel.blockers.some(blocker => blocker.code === 'MODEL_UNAVAILABLE'))
  assert.equal(calls.callConfigs.length, 2)
  assert.equal(calls.providers, 3)
  assert.equal(calls.presets, 3)
})

test('production worker launcher uses the injected SessionController for session setup', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-session-composition-'))
  const ctx = new Context()
  const calls = []
  let inspectionCount = 0
  ctx.provide('webServer', { register() { return () => {} } })
  ctx.provide('tools', { register() { return () => {} } })
  ctx.provide('llm', {
    listProviders() { return [{ id: 'openai-codex' }] },
    async resolveCallConfig(config) { return config },
  })
  ctx.provide('agentPresets', { async list() { return [{ id: 'standard' }] } })
  ctx.provide('sessionController', {
    async create(request) { calls.push(['create', request]); return { sessionId: 'host-session-1' } },
    async selectModel(request) {
      calls.push(['selectModel', request])
      return { selected: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort } }
    },
    async inspect(sessionId) {
      calls.push(['inspect', sessionId])
      inspectionCount++
      return {
        events: inspectionCount === 3 ? [
          { seq: 1, type: 'turn/start', data: { turn: 1 } },
          { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'session completed' }] } } },
          { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ] : [],
      }
    },
    async prompt(request, signal) {
      calls.push(['prompt', request, signal instanceof AbortSignal])
      return { accepted: true }
    },
    async cancel(request) { calls.push(['cancel', request]); return { accepted: true } },
  })
  const fiber = ctx.plugin(taskOrchestrator, {
    dbPath: join(dir, 'tasks.db'),
    workspaceRoots: [dir],
    workerSpecs: {
      worker: {
        mode: 'session', agentPreset: 'standard',
        provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'medium',
        workspacePolicy: 'any',
      },
    },
  })
  await fiber
  t.after(async () => {
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('worker session launch must not use loopback fetch') }
  try {
    const launcher = ctx.get('taskOrchestrator').createWorkerLauncher()
    const handle = await launcher.launch({
      task: { id: 'session-task', title: 'Session task', workspace: dir, acceptance_criteria: [] },
      spec: ctx.get('taskOrchestrator').getWorkerSpec('worker'),
      runId: 'session-run',
      requestId: 'request-1',
    })
    assert.equal(handle.sessionId, 'host-session-1')
    assert.deepEqual(calls.map(([name]) => name), ['create', 'selectModel', 'inspect', 'prompt'])
    assert.deepEqual(calls[1][1], {
      sessionId: 'host-session-1', provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'medium',
    })
    assert.equal(calls[2][1], 'host-session-1')
    assert.equal(calls[3][1].requestId, 'request-1')
    assert.equal(calls[3][1].mode, 'queue')
    assert.equal(calls[3][2], true)
    assert.equal(await handle.terminate(), true)
    assert.deepEqual(calls.at(-1), ['cancel', { sessionId: 'host-session-1' }])

    const api = ctx.get('taskOrchestrator')
    const task = api.create({
      id: 'dispatcher-session-task', title: 'Dispatcher session task', status: 'ready', workspace: dir,
      worker_profile: 'worker', acceptance_criteria: ['completed'],
    })
    const dispatched = await api.createDispatcher().dispatchOnce({ workerProfile: 'worker' })
    assert.equal(dispatched.dispatched, true)
    assert.equal(dispatched.exit_code, 0)
    assert.equal(dispatched.task.id, task.id)
    assert.equal(dispatched.task.status, 'in_review')
    assert.deepEqual(calls.slice(5).map(([name]) => name), ['create', 'selectModel', 'inspect', 'prompt', 'inspect'])
    assert.equal(calls[8][1].requestId.length > 0, true)
    assert.equal(calls[8][1].mode, 'queue')
  } finally {
    globalThis.fetch = originalFetch
  }
})
