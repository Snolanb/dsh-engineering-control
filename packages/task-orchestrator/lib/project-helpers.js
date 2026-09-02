// Pure, side-effect-free helpers that build project-centric views from
// task, project, milestone, and link data. Extracted so the browser UI can
// share grouping/progress logic with focused unit tests without a DOM.
//
// All inputs are intentionally tolerant: missing fields default to []/null
// so a partially loaded response still produces deterministic output.

const TASK_LINK_TYPES = Object.freeze(['enables', 'usually_follows', 'benefits_from', 'related_to'])

export const ROADMAP_BLOCKING = 'blocking_dependency'
export const ROADMAP_TYPED = 'typed_link'

export const CRITERION_STATUSES = Object.freeze(['pending', 'satisfied', 'waived'])

function normalizeTask(task) {
  if (!task || typeof task !== 'object') return null
  return {
    id: String(task.id ?? ''),
    title: String(task.title ?? task.id ?? 'Untitled'),
    description: typeof task.description === 'string' ? task.description : '',
    status: typeof task.status === 'string' ? task.status : 'backlog',
    priority: typeof task.priority === 'string' ? task.priority : 'normal',
    parent_id: task.parent_id ?? null,
    project_id: task.project_id ?? null,
    milestone_id: task.milestone_id ?? null,
    relationship_type: task.relationship_type ?? 'task',
    blocked_by: Array.isArray(task.blocked_by) ? task.blocked_by.slice() : [],
    dependencies: Array.isArray(task.dependencies) ? task.dependencies.slice() : [],
    ready_to_run: Boolean(task.ready_to_run),
    blocked_by_dependencies: Boolean(task.blocked_by_dependencies),
    worker_profile: task.worker_profile ?? null,
    claimed_by: task.claimed_by ?? null,
    acceptance_criteria: Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria.slice() : [],
    criterion_results: Array.isArray(task.criterion_results) ? task.criterion_results.slice() : [],
    specification: (task.specification && typeof task.specification === 'object') ? task.specification : {},
  }
}

function normalizeMilestone(milestone) {
  if (!milestone || typeof milestone !== 'object') return null
  return {
    id: String(milestone.id ?? ''),
    project_id: milestone.project_id ?? null,
    title: String(milestone.title ?? milestone.id ?? 'Untitled milestone'),
    description: typeof milestone.description === 'string' ? milestone.description : '',
    status: typeof milestone.status === 'string' ? milestone.status : 'planning',
    position: Number.isFinite(Number(milestone.position)) ? Number(milestone.position) : 0,
  }
}

function normalizeProject(project) {
  if (!project || typeof project !== 'object') return null
  const milestones = Array.isArray(project.milestones) ? project.milestones.map(normalizeMilestone).filter(Boolean) : []
  return {
    id: String(project.id ?? ''),
    title: String(project.title ?? project.id ?? 'Untitled project'),
    description: typeof project.description === 'string' ? project.description : '',
    status: typeof project.status === 'string' ? project.status : 'planning',
    specification: (project.specification && typeof project.specification === 'object') ? project.specification : {},
    roadmap: Array.isArray(project.roadmap) ? project.roadmap.slice() : [],
    outline: Array.isArray(project.outline) ? project.outline.slice() : [],
    milestones,
  }
}

function projectKey(task, fallbackProjectId) {
  if (task.project_id) return task.project_id
  return fallbackProjectId === undefined ? '__no_project__' : fallbackProjectId
}

function milestoneKey(task, fallbackMilestoneId) {
  if (task.milestone_id) return task.milestone_id
  return fallbackMilestoneId === undefined ? '__no_milestone__' : fallbackMilestoneId
}

// Group tasks into a project → milestone → hierarchy suitable for the Outline
// view. Tasks with no project are grouped under the optional fallback
// projectId; tasks with no milestone are grouped under an '__no_milestone__'
// bucket within their project so the UI can render an explicit "unassigned"
// section. Each task appears both at its parent position (drilling) and is
// also reachable via children() so renderers can choose either a flat list or
// nested tree.
export function groupTasksByProjectMilestone(tasks, { projects = [], fallbackProjectId = '__no_project__', fallbackMilestoneId = '__no_milestone__' } = {}) {
  const safeTasks = Array.isArray(tasks) ? tasks.map(normalizeTask).filter(Boolean) : []
  const projectMap = new Map()
  for (const project of projects.map(normalizeProject).filter(Boolean)) {
    projectMap.set(project.id, { ...project, milestones: new Map(project.milestones.map(milestone => [milestone.id, { ...milestone, tasks: [], childTasks: [] }])), noMilestone: { id: fallbackMilestoneId, title: 'Unassigned to milestone', status: 'planning', tasks: [], childTasks: [] } })
  }
  for (const task of safeTasks) {
    const pId = projectKey(task, fallbackProjectId)
    let project = projectMap.get(pId)
    if (project === undefined) {
      // Lazily create the fallback "no project" bucket the first time we
      // encounter a task without a project_id, so projects[] alone does not
      // implicitly add an empty "No project" section.
      if (pId === fallbackProjectId) {
        project = {
          id: fallbackProjectId, title: 'No project', description: '', status: 'planning', specification: {}, roadmap: [], outline: [], milestones: new Map(),
          noMilestone: { id: fallbackMilestoneId, title: 'Unassigned to milestone', status: 'planning', tasks: [], childTasks: [] },
        }
      } else {
        project = { id: pId, title: '(unknown project)', description: '', status: 'planning', specification: {}, roadmap: [], outline: [], milestones: new Map(), noMilestone: { id: fallbackMilestoneId, title: 'Unassigned to milestone', status: 'planning', tasks: [], childTasks: [] } }
      }
      projectMap.set(pId, project)
    }
    const mId = task.milestone_id ?? fallbackMilestoneId
    let bucket = mId === fallbackMilestoneId ? project.noMilestone : project.milestones.get(mId)
    if (bucket === undefined) {
      bucket = { id: mId, title: '(unknown milestone)', status: 'planning', tasks: [], childTasks: [] }
      project.milestones.set(mId, bucket)
    }
    bucket.tasks.push(task)
    if (task.parent_id) bucket.childTasks.push(task)
  }
  // Stable order: milestones by position then id; tasks by id for determinism.
  const result = []
  for (const project of projectMap.values()) {
    const milestones = Array.from(project.milestones.values()).sort((a, b) => (a.position - b.position) || a.id.localeCompare(b.id))
    milestones.forEach(milestone => milestone.tasks.sort((a, b) => a.id.localeCompare(b.id)))
    if (project.noMilestone.tasks.length > 0) {
      project.noMilestone.tasks.sort((a, b) => a.id.localeCompare(b.id))
      milestones.push(project.noMilestone)
    }
    result.push({ ...project, milestones })
  }
  return result
}

// Hierarchy: tasks grouped by parent_id (children nested under their parent).
// Roots are tasks whose parent_id is not present in the input list. Used by
// the outline renderer to display hierarchical task lists inside a milestone.
export function buildHierarchy(tasks) {
  const safeTasks = Array.isArray(tasks) ? tasks.map(normalizeTask).filter(Boolean) : []
  const byId = new Map(safeTasks.map(task => [task.id, { ...task, children: [] }]))
  const roots = []
  for (const task of byId.values()) {
    if (task.parent_id && byId.has(task.parent_id)) {
      byId.get(task.parent_id).children.push(task)
    } else {
      roots.push(task)
    }
  }
  const sortById = (a, b) => a.id.localeCompare(b.id)
  roots.sort(sortById)
  for (const task of byId.values()) task.children.sort(sortById)
  return roots
}

// Counts of task statuses plus completion percent (matches the store _progress
// helper). Cancelled tasks are excluded from the denominator.
export function summarizeStatuses(tasks) {
  const safeTasks = Array.isArray(tasks) ? tasks.map(normalizeTask).filter(Boolean) : []
  const counts = {}
  let cancelled = 0
  for (const task of safeTasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1
    if (task.status === 'cancelled') cancelled++
  }
  const total = safeTasks.length
  const activeTotal = total - cancelled
  const done = counts.done ?? 0
  return {
    counts,
    total,
    done,
    cancelled,
    active_total: activeTotal,
    completion_percent: activeTotal === 0 ? 0 : Math.round(done * 10000 / activeTotal) / 100,
  }
}

// Returns true when the task is ready to run (status ready AND no
// dependency blockers). Mirrors the store ready_to_run semantics for the
// outline indicator.
export function isReadyToRun(task) {
  const safe = normalizeTask(task)
  if (!safe) return false
  if (safe.ready_to_run) return true
  return safe.status === 'ready' && safe.blocked_by.length === 0
}

// Returns true when the task is blocked by at least one unfinished blocker
// dependency (NOT the explicit blocked status, NOT nonblocking typed links).
export function isDependencyBlocked(task) {
  const safe = normalizeTask(task)
  if (!safe) return false
  if (safe.blocked_by_dependencies) return true
  return safe.blocked_by.length > 0
}

// Returns the list of unmet acceptance criteria for a task — the set of
// `criterion_results` entries whose status is not 'satisfied' or 'waived'.
export function unmetCriteria(task) {
  const safe = normalizeTask(task)
  if (!safe) return []
  return safe.criterion_results.filter(entry => entry.status !== 'satisfied' && entry.status !== 'waived')
}

// Deterministic counts of criterion statuses for a milestone or project
// (flattening all child tasks). Empty lists produce zeroed counts so the
// renderer always renders the same shape.
export function summarizeCriteria(tasks) {
  const safeTasks = Array.isArray(tasks) ? tasks.map(normalizeTask).filter(Boolean) : []
  const counts = { pending: 0, satisfied: 0, waived: 0, other: 0, total: 0 }
  for (const task of safeTasks) {
    for (const entry of task.criterion_results) {
      counts.total++
      if (entry.status === 'satisfied') counts.satisfied++
      else if (entry.status === 'waived') counts.waived++
      else if (entry.status === 'pending') counts.pending++
      else counts.other++
    }
  }
  return counts
}

// Milestone "exit criteria" are derived from a project's milestone-level
// metadata (caller-supplied) — the store does not model these as a first
// class field on milestones, so callers either pass a map of milestone-id
// to ordered criteria strings or an empty array. We surface them as-is for
// the outline renderer and compute how many are unmet using the supplied
// task summaries (criteria are considered met when any child task has the
// criterion satisfied in its criterion_results list).
export function milestoneExitCriteria(milestone, childTasks) {
  if (!milestone) return []
  const metadataCriteria = Array.isArray(milestone.exit_criteria)
    ? milestone.exit_criteria
    : (milestone.metadata && Array.isArray(milestone.metadata.exit_criteria) ? milestone.metadata.exit_criteria : [])
  if (!metadataCriteria.length) return []
  const safeChildren = Array.isArray(childTasks) ? childTasks.map(normalizeTask).filter(Boolean) : []
  return metadataCriteria.map((criterion, index) => {
    const text = typeof criterion === 'string' ? criterion : (criterion && typeof criterion === 'object' ? (criterion.criterion ?? criterion.text ?? JSON.stringify(criterion)) : String(criterion))
    const matched = safeChildren.find(task => task.criterion_results.some(entry => entry.criterion === text && (entry.status === 'satisfied' || entry.status === 'waived')))
    return {
      index,
      criterion: text,
      met: Boolean(matched),
      evidence_task_id: matched?.id ?? null,
    }
  })
}

// Build a list of roadmap edges from a list of tasks plus their typed links.
// Each edge is labeled with kind 'blocking_dependency' or 'typed_link' so the
// UI can render them in clearly separate sections. Edges where either endpoint
// is unknown to the caller are still returned (with `from_id`/`to_id`
// strings) so the UI can render unresolved references explicitly.
export function buildRoadmapEdges(tasks, linksByTask = {}) {
  const safeTasks = Array.isArray(tasks) ? tasks.map(normalizeTask).filter(Boolean) : []
  const byId = new Map(safeTasks.map(task => [task.id, task]))
  const blocking = []
  const typed = []
  for (const task of safeTasks) {
    for (const blockerId of task.blocked_by) {
      blocking.push({
        kind: ROADMAP_BLOCKING,
        from_id: blockerId,
        to_id: task.id,
        from: byId.get(blockerId) ? { id: blockerId, title: byId.get(blockerId).title, status: byId.get(blockerId).status } : null,
        to: { id: task.id, title: task.title, status: task.status },
        link_type: 'depends_on',
      })
    }
    const links = Array.isArray(linksByTask[task.id]) ? linksByTask[task.id] : []
    for (const link of links) {
      const linked = byId.get(link.linked_task_id)
      typed.push({
        kind: ROADMAP_TYPED,
        from_id: task.id,
        to_id: link.linked_task_id,
        from: { id: task.id, title: task.title, status: task.status },
        to: linked ? { id: linked.id, title: linked.title, status: linked.status } : null,
        link_type: link.link_type,
      })
    }
  }
  // Deterministic ordering for both buckets.
  blocking.sort((a, b) => (a.from_id + '|' + a.to_id).localeCompare(b.from_id + '|' + b.to_id))
  typed.sort((a, b) => (a.from_id + '|' + a.to_id + '|' + a.link_type).localeCompare(b.from_id + '|' + b.to_id + '|' + b.link_type))
  return { blocking, typed }
}

// Determine whether a given project or milestone id matches the active
// filter selectors. `null`/missing selector means "all"; the literal empty
// string means "unassigned only"; any other string means "exactly this id".
export function matchesFilter(value, selector) {
  if (selector === undefined || selector === null || selector === '') {
    if (selector === '') return value === null || value === undefined
    return true
  }
  return value === selector
}

// Validate a criterion_results payload before PUT. Returns an array of
// {ok: boolean, error?: string, normalized: entry[]} structure. The
// normalized entry mirrors store normalizeCriterionResults so the UI can
// preview what will be saved.
export function buildCriterionResultsPayload(entries) {
  if (!Array.isArray(entries)) return { ok: false, error: 'criterion_results must be an array', normalized: [] }
  const normalized = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, error: 'criterion_results[' + index + '] must be an object', normalized }
    const status = entry.status ?? 'pending'
    if (!CRITERION_STATUSES.includes(status)) return { ok: false, error: 'criterion_results[' + index + '].status must be one of: ' + CRITERION_STATUSES.join(', '), normalized }
    normalized.push({
      index: Number.isInteger(entry.index) ? entry.index : index,
      criterion: typeof entry.criterion === 'string' ? entry.criterion : '',
      status,
      evidence: typeof entry.evidence === 'string' ? entry.evidence : '',
      updated_at: entry.updated_at ?? null,
    })
  }
  return { ok: true, normalized }
}

// Project "completion criteria" live on the project metadata in lieu of a
// first-class field. Renderers extract and validate them from metadata so the
// UI can show "Unmet criteria: N" badges in the outline.
export function projectCompletionCriteria(project) {
  if (!project || typeof project !== 'object') return []
  if (Array.isArray(project.completion_criteria)) return project.completion_criteria.slice()
  if (project.metadata && Array.isArray(project.metadata.completion_criteria)) return project.metadata.completion_criteria.slice()
  if (project.specification && Array.isArray(project.specification.completion_criteria)) return project.specification.completion_criteria.slice()
  return []
}

export { TASK_LINK_TYPES, normalizeTask, normalizeProject, normalizeMilestone }
