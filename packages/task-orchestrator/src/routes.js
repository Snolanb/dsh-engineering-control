import { isIP } from 'node:net'
import { previewPlanImport, applyPlanImport } from './plan-import.js'

export const TASK_API_PREFIX = '/api/task-orchestrator'
const BODY_LIMIT = 1024 * 1024

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function loopback(address) {
  if (typeof address !== 'string') return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  const version = isIP(normalized)
  return version === 4 ? normalized.startsWith('127.') : version === 6 && normalized === '::1'
}

function allowed(req) {
  return loopback(req.socket?.remoteAddress)
}

async function body(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {}
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw Object.assign(new Error('request body too large'), { status: 413 })
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  if (size === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be a JSON object')
    return value
  } catch (error) {
    throw Object.assign(new Error('invalid JSON request body: ' + (error instanceof Error ? error.message : String(error))), { status: 400 })
  }
}

function routeError(error) {
  const code = error?.code
  if (error?.status !== undefined) return { status: error.status, body: { error: error.message } }
  if (code === 'TASK_NOT_FOUND' || code === 'PROJECT_NOT_FOUND' || code === 'MILESTONE_NOT_FOUND') return { status: 404, body: { error: error.message, code } }
  if (code === 'INVALID_TRANSITION' || code === 'TASK_EXISTS' || code === 'PROJECT_EXISTS' || code === 'MILESTONE_EXISTS' || code === 'DEPENDENCY_CYCLE' || code === 'TASK_LINK_CYCLE' || code === 'PARENT_CYCLE' || code === 'LEASE_OWNER_MISMATCH' || code === 'LEASE_EXPIRED' || code === 'TASK_NOT_CLAIMED' || code === 'TASK_NOT_RUNNING' || code === 'MAX_ATTEMPTS_EXCEEDED' || code === 'PLAN_IMPORT_CHECKSUM_MISMATCH' || code === 'PLAN_IMPORT_PROPOSAL_MISMATCH' || code === 'PLAN_IMPORT_SOURCE_CONFLICT') return { status: 409, body: { error: error.message, code } }
  if (code === 'PLAN_IMPORT_TOO_LARGE' || code === 'PLAN_IMPORT_EMPTY' || code === 'PLAN_IMPORT_NO_TITLE') return { status: 400, body: { error: error.message, code } }
  if (error instanceof TypeError || error instanceof URIError) return { status: 400, body: { error: error.message } }
  return { status: 500, body: { error: error instanceof Error ? error.message : String(error), code: code ?? 'INTERNAL_ERROR' } }
}

function pathParts(pathname) {
  const rest = pathname.slice(TASK_API_PREFIX.length).split('/').filter(Boolean).join('/')
  return rest === '' ? [] : rest.split('/').map(part => decodeURIComponent(part))
}

function listOptions(query) {
  const status = query.get('status')
  const options = {
    ...(status === null ? {} : { statuses: status.split(',').map(value => value.trim()).filter(Boolean) }),
    ...(query.has('parent_id') ? { parent_id: query.get('parent_id') } : {}),
    ...(query.has('relationship_type') ? { relationship_type: query.get('relationship_type') } : {}),
    ...(query.has('worker_profile') ? { worker_profile: query.get('worker_profile') } : {}),
    ...(query.has('claimed_by') ? { claimed_by: query.get('claimed_by') } : {}),
    ...(query.get('ready_to_run') === 'true' ? { ready_to_run: true } : {}),
    ...(query.get('blocked_by_dependencies') === 'true' ? { blocked_by_dependencies: true } : {}),
    ...(query.get('expired_claims') === 'true' ? { expired_claims: true } : {}),
    ...(query.get('in_review') === 'true' ? { in_review: true } : {}),
    ...(query.has('limit') ? { limit: Number(query.get('limit')) } : {}),
    ...(query.has('offset') ? { offset: Number(query.get('offset')) } : {}),
  }
  if (query.has('project_id')) options.project_id = query.get('project_id') === '' ? null : query.get('project_id')
  if (query.has('milestone_id')) options.milestone_id = query.get('milestone_id') === '' ? null : query.get('milestone_id')
  return options
}

export function makeRoutes(store, dependencies = {}) {
  return [{ kind: 'prefix', path: TASK_API_PREFIX, handler: (req, res) => handleRequest(store, req, res, dependencies) }]
}

function notFound(res) { return json(res, 404, { error: 'not found' }) }

export async function handleRequest(store, req, res, dependencies = {}) {
  if (!allowed(req)) return json(res, 403, { error: 'task orchestrator API is loopback-only' })
  try {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    const parts = pathParts(requestUrl.pathname)
    const method = req.method ?? 'GET'
    const input = await body(req)
    let result

    if (parts[0] === 'tasks' && parts.length === 1 && method === 'GET') result = { tasks: store.list(listOptions(requestUrl.searchParams)) }
    else if (parts[0] === 'tasks' && parts.length === 1 && method === 'POST') result = { task: store.create(input, { actor: input.actor }) }
    else if (parts[0] === 'tasks' && parts.length === 2 && method === 'GET') {
      const task = store.get(parts[1])
      if (task === null) return json(res, 404, { error: 'task not found', code: 'TASK_NOT_FOUND' })
      result = { task }
    }
    else if (parts[0] === 'tasks' && parts.length === 2 && method === 'PATCH') {
      const { actor, ...patch } = input
      result = { task: store.update(parts[1], patch, { actor }) }
    } else if (parts[0] === 'tasks' && parts.length === 2 && method === 'DELETE') result = store.delete(parts[1], { actor: input.actor })
    else if (parts[0] === 'tasks' && parts[2] === 'claim' && method === 'POST') result = store.claim(parts[1], input.worker, input)
    else if (parts[0] === 'tasks' && parts[2] === 'release' && method === 'POST') result = store.release(parts[1], input.worker, input)
    else if (parts[0] === 'tasks' && parts[2] === 'renew-lease' && method === 'POST') result = store.renewLease(parts[1], input.worker, input)
    else if (parts[0] === 'tasks' && parts[2] === 'start' && method === 'POST') result = store.start(parts[1], input.worker, input)
    else if (parts[0] === 'tasks' && parts[2] === 'complete' && method === 'POST') { const { worker, actor, ...execution } = input; result = { task: store.complete(parts[1], execution, { worker, actor }) } }
    else if (parts[0] === 'tasks' && parts[2] === 'fail' && method === 'POST') { const { worker, actor, ...execution } = input; result = { task: store.fail(parts[1], execution, { worker, actor }) } }
    else if (parts[0] === 'tasks' && parts[2] === 'block' && method === 'POST') result = { task: store.block(parts[1], input.reason, { ...input }) }
    else if (parts[0] === 'tasks' && parts[2] === 'unblock' && method === 'POST') result = { task: store.unblock(parts[1], input) }
    else if (parts[0] === 'tasks' && parts[2] === 'request-changes' && method === 'POST') result = { task: store.requestChanges(parts[1], input.reason, input) }
    else if (parts[0] === 'tasks' && parts[2] === 'events' && method === 'GET') result = { events: store.events(parts[1], { limit: Number(requestUrl.searchParams.get('limit') ?? 100), before_id: requestUrl.searchParams.get('before_id') === null ? undefined : Number(requestUrl.searchParams.get('before_id')) }) }
    else if (parts[0] === 'tasks' && parts[2] === 'children' && method === 'GET') result = { tasks: store.listChildren(parts[1], { descendants: requestUrl.searchParams.get('descendants') === 'true' }) }
    else if (parts[0] === 'tasks' && parts[2] === 'children' && method === 'POST') { const { actor, ...child } = input; result = { task: store.addChild(parts[1], child, { actor }) } }
    else if (parts[0] === 'tasks' && parts[2] === 'dependencies' && method === 'POST') result = store.addDependency(parts[1], input.depends_on_task_id, input)
    else if (parts[0] === 'tasks' && parts[2] === 'dependencies' && method === 'DELETE') result = store.removeDependency(parts[1], requestUrl.searchParams.get('depends_on_task_id'), input)
    else if (parts[0] === 'tasks' && parts[2] === 'links' && method === 'GET') result = { links: store.listTaskLinks(parts[1], { link_type: requestUrl.searchParams.get('link_type') ?? undefined }) }
    else if (parts[0] === 'tasks' && parts[2] === 'links' && method === 'POST') result = store.addTaskLink(parts[1], input.linked_task_id, input.link_type, input)
    else if (parts[0] === 'tasks' && parts[2] === 'links' && method === 'DELETE') result = store.removeTaskLink(parts[1], requestUrl.searchParams.get('linked_task_id'), requestUrl.searchParams.get('link_type'), input)
    else if (parts[0] === 'tasks' && parts[2] === 'criterion-results' && method === 'PUT') result = { task: store.setCriterionResults(parts[1], input.criterion_results, input) }
    else if (parts[0] === 'projects' && parts.length === 1 && method === 'GET') result = { projects: store.listProjects() }
    else if (parts[0] === 'projects' && parts.length === 1 && method === 'POST') result = { project: store.createProject(input, { actor: input.actor }) }
    else if (parts[0] === 'projects' && parts.length === 2 && method === 'GET') {
      const project = store.getProject(parts[1])
      if (project === null) return json(res, 404, { error: 'project not found', code: 'PROJECT_NOT_FOUND' })
      result = { project }
    }
    else if (parts[0] === 'projects' && parts.length === 2 && method === 'PATCH') { const { actor, ...patch } = input; result = { project: store.updateProject(parts[1], patch, { actor }) } }
    else if (parts[0] === 'projects' && parts.length === 2 && method === 'DELETE') result = store.deleteProject(parts[1], { actor: input.actor })
    else if (parts[0] === 'projects' && parts[2] === 'milestones' && parts.length === 3 && method === 'GET') result = { milestones: store.listMilestones(parts[1]) }
    else if (parts[0] === 'projects' && parts[2] === 'milestones' && parts.length === 3 && method === 'POST') result = { milestone: store.createMilestone({ ...input, project_id: parts[1] }, { actor: input.actor }) }
    else if (parts[0] === 'milestones' && parts.length === 2 && method === 'GET') {
      const milestone = store.getMilestone(parts[1])
      if (milestone === null) return json(res, 404, { error: 'milestone not found', code: 'MILESTONE_NOT_FOUND' })
      result = { milestone }
    }
    else if (parts[0] === 'milestones' && parts.length === 2 && method === 'PATCH') { const { actor, ...patch } = input; result = { milestone: store.updateMilestone(parts[1], patch, { actor }) } }
    else if (parts[0] === 'milestones' && parts.length === 2 && method === 'DELETE') result = store.deleteMilestone(parts[1], { actor: input.actor })
    else if (parts[0] === 'dispatcher' && parts[1] === 'workers' && parts.length === 2 && method === 'GET') result = { workers: dependencies.registry?.list?.() ?? [] }
    else if (parts[0] === 'dispatcher' && parts[1] === 'preflight' && parts.length === 2 && method === 'POST') {
      result = { preflight: typeof dependencies.preflight === 'function'
        ? await dependencies.preflight(input)
        : { ok: false, blockers: [{ code: 'PREFLIGHT_UNAVAILABLE', message: 'worker preflight is not configured' }] } }
    }
    else if (parts[0] === 'dispatcher' && parts[1] === 'ready' && method === 'GET') result = { tasks: store.list({ ...listOptions(requestUrl.searchParams), ready_to_run: true }) }
    else if (parts[0] === 'dispatcher' && parts[1] === 'expired-claims' && method === 'GET') result = { tasks: store.list({ ...listOptions(requestUrl.searchParams), expired_claims: true }) }
    else if (parts[0] === 'dispatcher' && parts[1] === 'in-review' && method === 'GET') result = { tasks: store.list({ ...listOptions(requestUrl.searchParams), in_review: true }) }
    else if (parts[0] === 'plan-import' && parts[1] === 'preview' && parts.length === 2 && method === 'POST') result = previewPlanImport(input.markdown, { source_label: input.source_label })
    else if (parts[0] === 'plan-import' && parts[1] === 'apply' && parts.length === 2 && method === 'POST') result = applyPlanImport(store, input.markdown, { source_label: input.source_label, source_checksum: input.source_checksum, proposal_id: input.proposal_id, dry_run: input.dry_run, actor: input.actor })
    else return notFound(res)
    return json(res, 200, result)
  } catch (error) {
    const failure = routeError(error)
    return json(res, failure.status, failure.body)
  }
}