import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../src/store.js'
import { handleRequest } from '../src/routes.js'
import { WorkerSpecRegistry } from '../src/worker-specs.js'

function request(store, method, url, payload, remoteAddress = '127.0.0.1', dependencies = {}) {
  const req = Readable.from(payload === undefined ? [] : [JSON.stringify(payload)])
  req.method = method
  req.url = url
  req.socket = { remoteAddress }
  let body = ''
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(value = '') { body += value },
  }
  return handleRequest(store, req, res, dependencies).then(() => ({ status: res.status, headers: res.headers, body: JSON.parse(body) }))
}

test('serves loopback task CRUD, lifecycle, and dispatcher routes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-route-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  const created = await request(store, 'POST', '/api/task-orchestrator/tasks', { id: 'http-task', title: 'HTTP task', status: 'ready' })
  assert.equal(created.status, 200)
  assert.equal(created.body.task.id, 'http-task')
  assert.equal(created.headers['content-type'], 'application/json; charset=utf-8')

  const listed = await request(store, 'GET', '/api/task-orchestrator/dispatcher/ready')
  assert.deepEqual(listed.body.tasks.map(task => task.id), ['http-task'])
  const registry = new WorkerSpecRegistry({ ornith: { mode: 'headless-profile', profile: 'ornith-filemount-worker', provider: 'ollama', model: 'ornith-1.5:9b' } })
  const workers = await request(store, 'GET', '/api/task-orchestrator/dispatcher/workers', undefined, '127.0.0.1', { registry })
  assert.equal(workers.body.workers[0].name, 'ornith')
  const preflight = await request(store, 'POST', '/api/task-orchestrator/dispatcher/preflight', { worker_profile: 'ornith', workspace: '/workspace' }, '127.0.0.1', { preflight: async input => ({ ok: input.worker_profile === 'ornith', checks: [] }) })
  assert.equal(preflight.body.preflight.ok, true)
  const claimed = await request(store, 'POST', '/api/task-orchestrator/tasks/http-task/claim', { worker: 'http-worker' })
  assert.equal(claimed.body.claimed, true)
  await request(store, 'POST', '/api/task-orchestrator/tasks/http-task/start', { worker: 'http-worker' })
  const completed = await request(store, 'POST', '/api/task-orchestrator/tasks/http-task/complete', { worker: 'http-worker', result_summary: 'done', tests_run: ['node --test'] })
  assert.equal(completed.body.task.status, 'in_review')
  const events = await request(store, 'GET', '/api/task-orchestrator/tasks/http-task/events')
  assert.ok(events.body.events.some(event => event.event_type === 'task_completed'))
  const missing = await request(store, 'GET', '/api/task-orchestrator/tasks/missing')
  assert.equal(missing.status, 404)
  const missingWorker = await request(store, 'POST', '/api/task-orchestrator/tasks/http-task/claim', {})
  assert.equal(missingWorker.status, 400)
  const malformedPath = await request(store, 'GET', '/api/task-orchestrator/tasks/%E0%A4%A')
  assert.equal(malformedPath.status, 400)
})

test('rejects non-loopback HTTP requests', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-route-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const response = await request(store, 'GET', '/api/task-orchestrator/tasks', undefined, '192.0.2.10')
  assert.equal(response.status, 403)
})

test('serves project, milestone, link, and criterion routes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-route-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  const created = await request(store, 'POST', '/api/task-orchestrator/projects', { id: 'p1', title: 'Project', status: 'active' })
  assert.equal(created.status, 200)
  assert.equal(created.body.project.id, 'p1')
  const invalidStatus = await request(store, 'POST', '/api/task-orchestrator/projects', { id: 'p2', title: 'Bad', status: 'unknown' })
  assert.equal(invalidStatus.status, 400)
  const listed = await request(store, 'GET', '/api/task-orchestrator/projects')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.projects.length, 1)
  const fetched = await request(store, 'GET', '/api/task-orchestrator/projects/p1')
  assert.equal(fetched.body.project.id, 'p1')
  const missingProject = await request(store, 'GET', '/api/task-orchestrator/projects/missing')
  assert.equal(missingProject.status, 404)
  assert.equal(missingProject.body.code, 'PROJECT_NOT_FOUND')
  const patched = await request(store, 'PATCH', '/api/task-orchestrator/projects/p1', { title: 'Renamed' })
  assert.equal(patched.body.project.name, 'Renamed')

  const msCreated = await request(store, 'POST', '/api/task-orchestrator/projects/p1/milestones', { id: 'm1', title: 'M1', position: 1 })
  assert.equal(msCreated.status, 200)
  assert.equal(msCreated.body.milestone.position, 1)
  const missingProjectMs = await request(store, 'POST', '/api/task-orchestrator/projects/missing/milestones', { id: 'mx', title: 'X' })
  assert.equal(missingProjectMs.status, 404)
  assert.equal(missingProjectMs.body.code, 'PROJECT_NOT_FOUND')
  const msListed = await request(store, 'GET', '/api/task-orchestrator/projects/p1/milestones')
  assert.equal(msListed.body.milestones.length, 1)
  const msFetched = await request(store, 'GET', '/api/task-orchestrator/milestones/m1')
  assert.equal(msFetched.body.milestone.id, 'm1')
  const msMissing = await request(store, 'GET', '/api/task-orchestrator/milestones/missing')
  assert.equal(msMissing.status, 404)
  assert.equal(msMissing.body.code, 'MILESTONE_NOT_FOUND')
  const msPatched = await request(store, 'PATCH', '/api/task-orchestrator/milestones/m1', { title: 'M1-updated', position: 3 })
  assert.equal(msPatched.body.milestone.name, 'M1-updated')

  await request(store, 'POST', '/api/task-orchestrator/tasks', { id: 'ta', title: 'Task A', project_id: 'p1', milestone_id: 'm1' })
  await request(store, 'POST', '/api/task-orchestrator/tasks', { id: 'tb', title: 'Task B' })
  const filtered = await request(store, 'GET', '/api/task-orchestrator/tasks?project_id=p1')
  assert.deepEqual(filtered.body.tasks.map(t => t.id), ['ta'])
  const filteredEmpty = await request(store, 'GET', '/api/task-orchestrator/tasks?project_id=')
  assert.deepEqual(filteredEmpty.body.tasks.map(t => t.id), ['tb'])

  const link = await request(store, 'POST', '/api/task-orchestrator/tasks/ta/links', { linked_task_id: 'tb', link_type: 'enables' })
  assert.equal(link.status, 200)
  assert.equal(link.body.added, true)
  const linkBadType = await request(store, 'POST', '/api/task-orchestrator/tasks/ta/links', { linked_task_id: 'tb', link_type: 'bogus' })
  assert.equal(linkBadType.status, 400)
  const linkSelf = await request(store, 'POST', '/api/task-orchestrator/tasks/ta/links', { linked_task_id: 'ta', link_type: 'related_to' })
  assert.equal(linkSelf.status, 409)
  assert.equal(linkSelf.body.code, 'TASK_LINK_CYCLE')
  const linkMissingTask = await request(store, 'POST', '/api/task-orchestrator/tasks/missing/links', { linked_task_id: 'tb', link_type: 'enables' })
  assert.equal(linkMissingTask.status, 404)
  const listLinks = await request(store, 'GET', '/api/task-orchestrator/tasks/ta/links')
  assert.equal(listLinks.body.links.length, 1)
  const listLinksFiltered = await request(store, 'GET', '/api/task-orchestrator/tasks/ta/links?link_type=usually_follows')
  assert.equal(listLinksFiltered.body.links.length, 0)
  const removeLink = await request(store, 'DELETE', '/api/task-orchestrator/tasks/ta/links?linked_task_id=tb&link_type=enables')
  assert.equal(removeLink.body.removed, true)

  const setCriteria = await request(store, 'PUT', '/api/task-orchestrator/tasks/ta/criterion-results', { criterion_results: [{ criterion: 'works', status: 'met', evidence: 'e' }] })
  assert.equal(setCriteria.status, 200)
  assert.equal(setCriteria.body.task.criterion_results.length, 1)
  const setCriteriaBad = await request(store, 'PUT', '/api/task-orchestrator/tasks/ta/criterion-results', { criterion_results: 'not-array' })
  assert.equal(setCriteriaBad.status, 400)

  const removed = await request(store, 'DELETE', '/api/task-orchestrator/milestones/m1')
  assert.equal(removed.status, 200)
  const projectDelete = await request(store, 'DELETE', '/api/task-orchestrator/projects/p1')
  assert.equal(projectDelete.status, 200)
  assert.equal(projectDelete.body.deleted, true)
  const projectGone = await request(store, 'GET', '/api/task-orchestrator/projects/p1')
  assert.equal(projectGone.status, 404)
})

test('preserves backward compatibility for blocking dependency endpoints', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-route-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  await request(store, 'POST', '/api/task-orchestrator/tasks', { id: 'dep1', title: 'Dep1' })
  await request(store, 'POST', '/api/task-orchestrator/tasks', { id: 'dep2', title: 'Dep2' })
  const added = await request(store, 'POST', '/api/task-orchestrator/tasks/dep1/dependencies', { depends_on_task_id: 'dep2' })
  assert.equal(added.body.added, true)
  const cycle = await request(store, 'POST', '/api/task-orchestrator/tasks/dep2/dependencies', { depends_on_task_id: 'dep1' })
  assert.equal(cycle.status, 409)
  assert.equal(cycle.body.code, 'DEPENDENCY_CYCLE')
  const remove = await request(store, 'DELETE', '/api/task-orchestrator/tasks/dep1/dependencies?depends_on_task_id=dep2')
  assert.equal(remove.body.removed, true)
  const events = await request(store, 'GET', '/api/task-orchestrator/tasks/dep1/events')
  assert.ok(events.body.events.some(event => event.event_type === 'dependency_added'))
})

test('plan-import preview and apply routes are idempotent and reject bad identity', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-route-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  const md = '# Route Plan\n\n**Status:** Planning\n\n# 1. Objective\n\nX.\n\n# Story 1 — Foundation\n\n## Objective\n\nBase.\n\n## Acceptance criteria\n- Works.\n\n# 7. MVP Completion Criteria\n\n1. project exists\n'

  const preview = await request(store, 'POST', '/api/task-orchestrator/plan-import/preview', { markdown: md, source_label: 'ROUTE.md' })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.source_checksum.length, 64)
  assert.equal(preview.body.project.title, 'Route Plan')
  assert.equal(preview.body.project.stories.length, 1)

  const applied = await request(store, 'POST', '/api/task-orchestrator/plan-import/apply', { markdown: md, source_label: 'ROUTE.md', actor: 'route-test' })
  assert.equal(applied.status, 200)
  assert.equal(applied.body.replayed, false)
  assert.equal(applied.body.project.name, 'Route Plan')

  const replay = await request(store, 'POST', '/api/task-orchestrator/plan-import/apply', { markdown: md, source_label: 'ROUTE.md', actor: 'route-test' })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.replayed, true)

  const badChecksum = await request(store, 'POST', '/api/task-orchestrator/plan-import/apply', { markdown: md, source_label: 'ROUTE.md', source_checksum: 'wrong' })
  assert.equal(badChecksum.status, 409)
  assert.equal(badChecksum.body.code, 'PLAN_IMPORT_CHECKSUM_MISMATCH')

  const conflicting = await request(store, 'POST', '/api/task-orchestrator/plan-import/apply', { markdown: md + '\n# extra\n', source_label: 'ROUTE.md' })
  assert.equal(conflicting.status, 409)
  assert.equal(conflicting.body.code, 'PLAN_IMPORT_SOURCE_CONFLICT')

  const empty = await request(store, 'POST', '/api/task-orchestrator/plan-import/preview', { markdown: '' })
  assert.equal(empty.status, 400)

  const dryRun = await request(store, 'POST', '/api/task-orchestrator/plan-import/apply', { markdown: md, source_label: 'DRY.md', dry_run: true })
  assert.equal(dryRun.status, 200)
  assert.equal(dryRun.body.dry_run, true)
  assert.equal(dryRun.body.project, null)
})