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
