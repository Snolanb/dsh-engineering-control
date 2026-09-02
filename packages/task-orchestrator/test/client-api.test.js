import test from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_STATUSES, PROJECT_STATUSES, TASK_LINK_TYPES, TaskOrchestratorClient } from '../src/client-api.js'

function fakeResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body } }
}

test('client builds task queries and lifecycle requests', async () => {
  const calls = []
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.includes('/tasks?')) return fakeResponse({ tasks: [{ id: 'one' }] })
    if (url.endsWith('/tasks')) return fakeResponse({ task: { id: 'created' } })
    if (url.endsWith('/claim')) return fakeResponse({ claimed: true, task: { id: 'one', status: 'claimed' } })
    return fakeResponse({ task: { id: 'one', status: 'ready' } })
  }
  const client = new TaskOrchestratorClient(fetcher, '/api/task-orchestrator/')
  assert.deepEqual(await client.list({ statuses: ['ready', 'running'], worker_profile: 'ornith' }), [{ id: 'one' }])
  assert.equal((await client.create({ title: 'Created' })).id, 'created')
  assert.equal((await client.claim('one', 'worker-1', 60)).status, 'claimed')
  assert.equal(BOARD_STATUSES.length, 11)
  assert.equal(calls[0].url, '/api/task-orchestrator/tasks?worker_profile=ornith&status=ready%2Crunning')
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(JSON.parse(calls[1].init.body).title, 'Created')
})

test('client surfaces structured API errors', async () => {
  const client = new TaskOrchestratorClient(async () => fakeResponse({ error: 'lease expired', code: 'LEASE_EXPIRED' }, 409))
  await assert.rejects(() => client.start('one', 'worker'), error => error.status === 409 && error.code === 'LEASE_EXPIRED' && error.message === 'lease expired')
})

test('client encodes project/milestone/link endpoints with filters', async () => {
  const calls = []
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init })
    if (init?.method === 'DELETE' && url.includes('/projects/p1')) return fakeResponse({ deleted: true, id: 'p1' })
    if (init?.method === 'DELETE' && url.includes('/milestones/m1')) return fakeResponse({ deleted: true, id: 'm1' })
    if (init?.method === 'DELETE' && url.includes('/tasks/one/links')) return fakeResponse({ removed: true })
    if (init?.method === 'POST' && url === '/api/task-orchestrator/projects') return fakeResponse({ project: { id: 'p1' } })
    if (init?.method === 'PATCH' && url === '/api/task-orchestrator/projects/p1') return fakeResponse({ project: { id: 'p1', title: 'Renamed' } })
    if (init?.method === 'POST' && url === '/api/task-orchestrator/projects/p1/milestones') return fakeResponse({ milestone: { id: 'm1' } })
    if (init?.method === 'PATCH' && url === '/api/task-orchestrator/milestones/m1') return fakeResponse({ milestone: { id: 'm1' } })
    if (init?.method === 'POST' && url === '/api/task-orchestrator/tasks/one/links') return fakeResponse({ added: true })
    if (init?.method === 'PUT' && url === '/api/task-orchestrator/tasks/one/criterion-results') return fakeResponse({ task: { id: 'one', criterion_results: [{ criterion: 'works', status: 'met' }] } })
    if (url === '/api/task-orchestrator/projects') return fakeResponse({ projects: [{ id: 'p1', title: 'P1' }] })
    if (url === '/api/task-orchestrator/projects/p1') return fakeResponse({ project: { id: 'p1', title: 'P1' } })
    if (url === '/api/task-orchestrator/projects/p1/milestones') return fakeResponse({ milestones: [{ id: 'm1', title: 'M1' }] })
    if (url === '/api/task-orchestrator/milestones/m1') return fakeResponse({ milestone: { id: 'm1' } })
    if (url.endsWith('/tasks/one/links')) return fakeResponse({ links: [{ linked_task_id: 'two', link_type: 'enables' }] })
    if (url.startsWith('/api/task-orchestrator/tasks?project_id=p1')) return fakeResponse({ tasks: [{ id: 'one' }] })
    return fakeResponse({})
  }
  const client = new TaskOrchestratorClient(fetcher, '/api/task-orchestrator')
  assert.deepEqual(await client.listProjects(), [{ id: 'p1', title: 'P1' }])
  const project = await client.getProject('p1')
  assert.equal(project.id, 'p1')
  const created = await client.createProject({ title: 'P1' })
  assert.equal(created.id, 'p1')
  await client.updateProject('p1', { title: 'Renamed' })
  await client.deleteProject('p1')
  assert.equal((await client.listMilestones('p1')).length, 1)
  assert.equal((await client.createMilestone('p1', { title: 'M1' })).id, 'm1')
  assert.equal((await client.getMilestone('m1')).id, 'm1')
  await client.updateMilestone('m1', { title: 'M1-updated' })
  await client.deleteMilestone('m1')
  await client.addLink('one', 'two', 'enables')
  await client.listLinks('one', 'enables')
  await client.removeLink('one', 'two', 'enables')
  await client.setCriterionResults('one', [{ criterion: 'works', status: 'met' }])
  await client.list({ project_id: 'p1' })
  const linkCall = calls.find(call => call.url.includes('/tasks/one/links?linked_task_id=two'))
  assert.ok(linkCall, 'expected DELETE link call to encode query string')
  assert.equal(linkCall.init.method, 'DELETE')
  const criterionCall = calls.find(call => call.url.endsWith('/tasks/one/criterion-results') && call.init?.method === 'PUT')
  assert.ok(criterionCall)
  const listCall = calls.find(call => call.url.startsWith('/api/task-orchestrator/tasks?project_id=p1'))
  assert.ok(listCall, 'expected list call to encode project_id filter')
  assert.equal(PROJECT_STATUSES.length, 5)
  assert.equal(TASK_LINK_TYPES.length, 4)
})

test('client posts markdown to plan-import endpoints', async () => {
  const calls = []
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.endsWith('/plan-import/preview')) return fakeResponse({ proposal_id: 'p', source_checksum: 'c', project: { title: 'T' } })
    if (url.endsWith('/plan-import/apply')) return fakeResponse({ replayed: false, project: { id: 'p1', title: 'T' }, milestones: [], tasks: [] })
    return fakeResponse({})
  }
  const client = new TaskOrchestratorClient(fetcher, '/api/task-orchestrator')
  const preview = await client.previewPlanImport('# Title\n\n# 1. Objective\n\nX.\n', 'TEST.md')
  assert.equal(preview.source_checksum, 'c')
  assert.ok(calls[0].url.endsWith('/plan-import/preview'))
  assert.equal(calls[0].init.method, 'POST')
  const applied = await client.applyPlanImport('# Title', { source_label: 'X.md', actor: 'me' })
  assert.equal(applied.project.id, 'p1')
  assert.ok(calls[1].url.endsWith('/plan-import/apply'))
})