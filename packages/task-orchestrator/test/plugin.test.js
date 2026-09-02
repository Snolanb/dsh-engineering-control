import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
