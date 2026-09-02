export const TASK_API_PREFIX = '/api/task-orchestrator'

export const PROJECT_STATUSES = Object.freeze(['planning', 'active', 'blocked', 'completed', 'cancelled'])
export const TASK_LINK_TYPES = Object.freeze(['enables', 'usually_follows', 'benefits_from', 'related_to'])

export const BOARD_STATUSES = Object.freeze([
  'backlog', 'planning', 'ready', 'claimed', 'running', 'in_review',
  'changes_requested', 'blocked', 'failed', 'done', 'cancelled',
])

async function responseJson(response) {
  let body
  try {
    body = await response.json()
  } catch {
    body = { error: 'task orchestrator returned invalid JSON' }
  }
  if (!response.ok) {
    const error = new Error(body?.error ?? 'task orchestrator request failed: ' + response.status)
    error.status = response.status
    error.code = body?.code
    throw error
  }
  return body
}

function queryString(options = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue
    if (value === null) { params.set(key, ''); continue }
    if (value === '') continue
    if (Array.isArray(value)) params.set(key, value.join(','))
    else params.set(key, String(value))
  }
  const encoded = params.toString()
  return encoded === '' ? '' : '?' + encoded
}

export class TaskOrchestratorClient {
  constructor(fetcher = globalThis.fetch?.bind(globalThis), prefix = TASK_API_PREFIX) {
    if (typeof fetcher !== 'function') throw new Error('fetch is unavailable')
    this.fetcher = fetcher
    this.prefix = prefix.replace(/\/+$/, '')
  }

  async request(path, init = {}) {
    const response = await this.fetcher(this.prefix + path, {
      cache: 'no-store',
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    })
    return await responseJson(response)
  }

  async list(options = {}) {
    const query = { ...options }
    if (query.statuses !== undefined && query.status === undefined) { query.status = query.statuses; delete query.statuses }
    return (await this.request('/tasks' + queryString(query))).tasks ?? []
  }

  async get(id) {
    return (await this.request('/tasks/' + encodeURIComponent(id))).task
  }

  async create(task) {
    return (await this.request('/tasks', { method: 'POST', body: JSON.stringify(task), headers: { 'content-type': 'application/json' } })).task
  }

  async update(id, patch) {
    return (await this.request('/tasks/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch), headers: { 'content-type': 'application/json' } })).task
  }

  async delete(id, actor) {
    const init = { method: 'DELETE' }
    if (actor !== undefined && actor !== null && actor !== '') init.body = JSON.stringify({ actor })
    return (await this.request('/tasks/' + encodeURIComponent(id), init))
  }

  async action(id, action, payload = {}) {
    const result = await this.request('/tasks/' + encodeURIComponent(id) + '/' + action, {
      method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' },
    })
    return result.task ?? result
  }

  async claim(id, worker, leaseSeconds) { return await this.action(id, 'claim', { worker, ...(leaseSeconds === undefined ? {} : { lease_seconds: leaseSeconds }) }) }
  async release(id, worker) { return await this.action(id, 'release', { worker }) }
  async renewLease(id, worker, leaseSeconds) { return await this.action(id, 'renew-lease', { worker, ...(leaseSeconds === undefined ? {} : { lease_seconds: leaseSeconds }) }) }
  async start(id, worker) { return await this.action(id, 'start', { worker }) }
  async complete(id, worker, result = {}) { return await this.action(id, 'complete', { worker, ...result }) }
  async fail(id, worker, result = {}) { return await this.action(id, 'fail', { worker, ...result }) }
  async block(id, reason, worker) { return await this.action(id, 'block', { reason, ...(worker === undefined ? {} : { worker }) }) }
  async unblock(id) { return await this.action(id, 'unblock') }
  async requestChanges(id, reason) { return await this.action(id, 'request-changes', { reason }) }

  async children(id, descendants = false) {
    return (await this.request('/tasks/' + encodeURIComponent(id) + '/children' + queryString({ descendants: descendants ? 'true' : undefined }))).tasks ?? []
  }

  async events(id, limit = 100) {
    return (await this.request('/tasks/' + encodeURIComponent(id) + '/events' + queryString({ limit }))).events ?? []
  }

  async addDependency(id, dependsOn) {
    return await this.request('/tasks/' + encodeURIComponent(id) + '/dependencies', {
      method: 'POST', body: JSON.stringify({ depends_on_task_id: dependsOn }), headers: { 'content-type': 'application/json' },
    })
  }

  async removeDependency(id, dependsOn) {
    return await this.request('/tasks/' + encodeURIComponent(id) + '/dependencies' + queryString({ depends_on_task_id: dependsOn }), { method: 'DELETE' })
  }

  async addLink(id, linkedTaskId, linkType, options = {}) {
    return await this.request('/tasks/' + encodeURIComponent(id) + '/links', {
      method: 'POST', body: JSON.stringify({ linked_task_id: linkedTaskId, link_type: linkType, ...options }), headers: { 'content-type': 'application/json' },
    })
  }

  async removeLink(id, linkedTaskId, linkType, options = {}) {
    return await this.request('/tasks/' + encodeURIComponent(id) + '/links' + queryString({ linked_task_id: linkedTaskId, link_type: linkType, ...options }), { method: 'DELETE' })
  }

  async listLinks(id, linkType) {
    const result = await this.request('/tasks/' + encodeURIComponent(id) + '/links' + queryString({ link_type: linkType }))
    return result.links ?? []
  }

  async setCriterionResults(id, criterionResults) {
    return (await this.request('/tasks/' + encodeURIComponent(id) + '/criterion-results', {
      method: 'PUT', body: JSON.stringify({ criterion_results: criterionResults }), headers: { 'content-type': 'application/json' },
    })).task
  }

  async listProjects() {
    return (await this.request('/projects')).projects ?? []
  }

  async getProject(id) {
    return (await this.request('/projects/' + encodeURIComponent(id))).project
  }

  async createProject(project) {
    return (await this.request('/projects', { method: 'POST', body: JSON.stringify(project), headers: { 'content-type': 'application/json' } })).project
  }

  async updateProject(id, patch) {
    return (await this.request('/projects/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch), headers: { 'content-type': 'application/json' } })).project
  }

  async deleteProject(id) {
    return await this.request('/projects/' + encodeURIComponent(id), { method: 'DELETE' })
  }

  async listMilestones(projectId) {
    return (await this.request('/projects/' + encodeURIComponent(projectId) + '/milestones')).milestones ?? []
  }

  async createMilestone(projectId, milestone) {
    return (await this.request('/projects/' + encodeURIComponent(projectId) + '/milestones', { method: 'POST', body: JSON.stringify(milestone), headers: { 'content-type': 'application/json' } })).milestone
  }

  async getMilestone(id) {
    return (await this.request('/milestones/' + encodeURIComponent(id))).milestone
  }

  async updateMilestone(id, patch) {
    return (await this.request('/milestones/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch), headers: { 'content-type': 'application/json' } })).milestone
  }

  async deleteMilestone(id) {
    return await this.request('/milestones/' + encodeURIComponent(id), { method: 'DELETE' })
  }

  async previewPlanImport(markdown, sourceLabel) {
    return await this.request('/plan-import/preview', { method: 'POST', body: JSON.stringify({ markdown, source_label: sourceLabel }), headers: { 'content-type': 'application/json' } })
  }

  async applyPlanImport(markdown, options = {}) {
    return await this.request('/plan-import/apply', { method: 'POST', body: JSON.stringify({ markdown, ...options }), headers: { 'content-type': 'application/json' } })
  }
}

export function createTaskOrchestratorClient(fetcher, prefix) {
  return new TaskOrchestratorClient(fetcher, prefix)
}