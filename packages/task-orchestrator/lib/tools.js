import { defineTool } from '@deepseek-ai/dsh-tools'
import { previewPlanImport, applyPlanImport } from './plan-import.js'

function text(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const arrayOfStrings = { type: 'array', items: { type: 'string' } }
const json = { type: 'json' }

function schema(properties, required = []) {
  const output = {}
  for (const [name, definition] of Object.entries(properties)) {
    output[name] = required.includes(name) ? { ...definition, required: true } : definition
  }
  return output
}

function actorFrom(args, exec) {
  return args.actor ?? exec?.agent?.id ?? exec?.agent?.name
}

function tool(name, description, parameters, execute) {
  return defineTool({
    name,
    description,
    parameters,
    output: { schema: json, render: (_args, value) => text(value) },
    async execute(args, exec) {
      return execute(args, exec)
    },
  })
}

const taskFields = {
  title: { type: 'string' }, description: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' },
  parent_id: { type: 'string' }, project_id: { type: 'string' }, milestone_id: { type: 'string' },
  relationship_type: { type: 'string' }, specification: json, roadmap: json, outline: json,
  completion_evidence: json, criterion_results: json,
  workspace: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' },
  worker_profile: { type: 'string' }, worker_model: { type: 'string' }, reviewer_profile: { type: 'string' }, reviewer_model: { type: 'string' },
  acceptance_criteria: arrayOfStrings, task_type: { type: 'string' }, attempts: { type: 'integer' }, max_attempts: { type: 'integer' },
  github_repo: { type: 'string' }, github_issue: { type: 'integer' }, result_summary: { type: 'string' }, commit_sha: { type: 'string' },
  files_changed: json, tests_run: json, remaining_blockers: json, metadata: json, actor: { type: 'string' },
}

const projectFields = {
  title: { type: 'string' }, description: { type: 'string' }, status: { type: 'string' },
  workspace: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' },
  specification: json, roadmap: json, outline: json, metadata: json, actor: { type: 'string' },
}

const milestoneFields = {
  project_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
  status: { type: 'string' }, position: { type: 'integer' }, due_at: { type: 'integer' },
  metadata: json, actor: { type: 'string' },
}

export function createTaskTools(store) {
  const tools = []
  tools.push(tool('task_create', 'Create a persistent orchestration task. Acceptance criteria are ordered first-class data.', schema({ ...taskFields, blocked_by: arrayOfStrings }, ['title']), (args, exec) => store.create(args, { actor: actorFrom(args, exec) })))
  tools.push(tool('task_get', 'Get one task, including dependencies, readiness, acceptance criteria, and structured result fields.', schema({ id: { type: 'string' } }, ['id']), args => store.get(args.id)))
  tools.push(tool('task_list', 'List tasks. Filter by status, project_id, milestone_id, relationship_type, parent_id, worker_profile, readiness, expired claims, or in_review.', schema({ status: { type: 'string' }, statuses: arrayOfStrings, project_id: { type: 'string' }, milestone_id: { type: 'string' }, relationship_type: { type: 'string' }, parent_id: { type: 'string' }, worker_profile: { type: 'string' }, claimed_by: { type: 'string' }, ready_to_run: { type: 'boolean' }, blocked_by_dependencies: { type: 'boolean' }, expired_claims: { type: 'boolean' }, in_review: { type: 'boolean' }, limit: { type: 'integer' }, offset: { type: 'integer' } }), args => store.list(args)))
  tools.push(tool('task_update', 'Update task fields or move a task through a validated lifecycle transition.', schema({ id: { type: 'string' }, ...taskFields }, ['id']), (args, exec) => { const { id, actor, ...patch } = args; return store.update(id, patch, { actor: actor ?? actorFrom(args, exec) }) }))
  tools.push(tool('task_delete', 'Delete a task while preserving its append-only deletion event.', schema({ id: { type: 'string' }, actor: { type: 'string' } }, ['id']), (args, exec) => store.delete(args.id, { actor: actorFrom(args, exec) })))
  tools.push(tool('task_claim', 'Atomically claim a ready, dependency-unblocked task with a worker lease.', schema({ id: { type: 'string' }, worker: { type: 'string' }, lease_seconds: { type: 'integer' }, actor: { type: 'string' } }, ['id', 'worker']), (args, exec) => store.claim(args.id, args.worker, { lease_seconds: args.lease_seconds, actor: actorFrom(args, exec) })))
  tools.push(tool('task_release', 'Release a worker lease and return the task to ready.', schema({ id: { type: 'string' }, worker: { type: 'string' }, actor: { type: 'string' } }, ['id', 'worker']), (args, exec) => store.release(args.id, args.worker, { actor: actorFrom(args, exec) })))
  tools.push(tool('task_renew_lease', 'Renew an unexpired worker lease.', schema({ id: { type: 'string' }, worker: { type: 'string' }, lease_seconds: { type: 'integer' }, actor: { type: 'string' } }, ['id', 'worker']), (args, exec) => store.renewLease(args.id, args.worker, { lease_seconds: args.lease_seconds, actor: actorFrom(args, exec) })))
  tools.push(tool('task_start', 'Start a claimed task, incrementing its attempt count.', schema({ id: { type: 'string' }, worker: { type: 'string' }, actor: { type: 'string' } }, ['id', 'worker']), (args, exec) => store.start(args.id, args.worker, { actor: actorFrom(args, exec) })))
  tools.push(tool('task_complete', 'Report structured worker output and move a running task into in_review.', schema({ id: { type: 'string' }, worker: { type: 'string' }, result_summary: { type: 'string' }, commit_sha: { type: 'string' }, files_changed: json, tests_run: json, remaining_blockers: json, actor: { type: 'string' } }, ['id', 'worker']), (args, exec) => { const { id, worker, actor, ...result } = args; return store.complete(id, result, { worker, actor: actor ?? actorFrom(args, exec) }) }))
  tools.push(tool('task_fail', 'Report structured worker failure and move a claimed/running task into failed.', schema({ id: { type: 'string' }, worker: { type: 'string' }, result_summary: { type: 'string' }, files_changed: json, tests_run: json, remaining_blockers: json, actor: { type: 'string' } }, ['id', 'worker']), (args, exec) => { const { id, worker, actor, ...result } = args; return store.fail(id, result, { worker, actor: actor ?? actorFrom(args, exec) }) }))
  tools.push(tool('task_block', 'Explicitly block a task, distinct from dependency blocking. A worker id is required when the task is claimed or running; managers may block unclaimed tasks.', schema({ id: { type: 'string' }, reason: { type: 'string' }, remaining_blockers: json, worker: { type: 'string' }, actor: { type: 'string' } }, ['id']), (args, exec) => store.block(args.id, args.reason, { worker: args.worker, remaining_blockers: args.remaining_blockers, actor: actorFrom(args, exec) })))
  tools.push(tool('task_unblock', 'Clear an explicit blocked status and return a task to ready.', schema({ id: { type: 'string' }, actor: { type: 'string' } }, ['id']), (args, exec) => store.unblock(args.id, { actor: actorFrom(args, exec) })))
  tools.push(tool('task_request_changes', 'Ask for review changes and move an in_review task to changes_requested.', schema({ id: { type: 'string' }, reason: { type: 'string' }, actor: { type: 'string' } }, ['id']), (args, exec) => store.requestChanges(args.id, args.reason, { actor: actorFrom(args, exec) })))
  tools.push(tool('task_add_dependency', 'Add a BLOCKING dependency after checking existence and cycles. Dependency changes are distinct from typed task links.', schema({ task_id: { type: 'string' }, depends_on_task_id: { type: 'string' }, actor: { type: 'string' } }, ['task_id', 'depends_on_task_id']), (args, exec) => store.addDependency(args.task_id, args.depends_on_task_id, { actor: actorFrom(args, exec) })))
  tools.push(tool('task_remove_dependency', 'Remove a BLOCKING task dependency. Dependency changes are distinct from typed task links.', schema({ task_id: { type: 'string' }, depends_on_task_id: { type: 'string' }, actor: { type: 'string' } }, ['task_id', 'depends_on_task_id']), (args, exec) => store.removeDependency(args.task_id, args.depends_on_task_id, { actor: actorFrom(args, exec) })))
  tools.push(tool('task_add_link', 'Add a NONBLOCKING typed relationship between two tasks. link_type must be one of enables, usually_follows, benefits_from, or related_to.', schema({ task_id: { type: 'string' }, linked_task_id: { type: 'string' }, link_type: { type: 'string' }, actor: { type: 'string' } }, ['task_id', 'linked_task_id', 'link_type']), (args, exec) => store.addTaskLink(args.task_id, args.linked_task_id, args.link_type, { actor: actorFrom(args, exec) })))
  tools.push(tool('task_remove_link', 'Remove a NONBLOCKING typed relationship between two tasks.', schema({ task_id: { type: 'string' }, linked_task_id: { type: 'string' }, link_type: { type: 'string' }, actor: { type: 'string' } }, ['task_id', 'linked_task_id', 'link_type']), (args, exec) => store.removeTaskLink(args.task_id, args.linked_task_id, args.link_type, { actor: actorFrom(args, exec) })))
  tools.push(tool('task_list_links', 'List NONBLOCKING typed relationships from a task. Optional link_type filter.', schema({ task_id: { type: 'string' }, link_type: { type: 'string' } }, ['task_id']), args => store.listTaskLinks(args.task_id, { link_type: args.link_type })))
  tools.push(tool('task_set_criterion_results', 'Update the ordered acceptance criterion status/evidence list for a task.', schema({ task_id: { type: 'string' }, criterion_results: json, actor: { type: 'string' } }, ['task_id', 'criterion_results']), (args, exec) => store.setCriterionResults(args.task_id, args.criterion_results, { actor: actorFrom(args, exec) })))
  tools.push(tool('task_add_child', 'Create a child implementation task under a parent task.', schema({ parent_id: { type: 'string' }, ...taskFields, blocked_by: arrayOfStrings }, ['parent_id', 'title']), (args, exec) => { const { parent_id, actor, ...child } = args; return store.addChild(parent_id, child, { actor: actor ?? actorFrom(args, exec) }) }))
  tools.push(tool('task_list_children', 'List direct children or all descendants of a parent task.', schema({ parent_id: { type: 'string' }, descendants: { type: 'boolean' } }, ['parent_id']), args => store.listChildren(args.parent_id, { descendants: args.descendants })))
  tools.push(tool('task_list_descendants', 'List all descendants of a parent task.', schema({ parent_id: { type: 'string' } }, ['parent_id']), args => store.listDescendants(args.parent_id)))
  tools.push(tool('task_ready_to_run', 'Explain whether a task is ready and unblocked for dispatch.', schema({ id: { type: 'string' } }, ['id']), args => store.readyToRun(args.id)))
  tools.push(tool('task_blocked_by_dependencies', 'Explain dependency blocking separately from explicit blocked status.', schema({ id: { type: 'string' } }, ['id']), args => store.blockedByDependencies(args.id)))
  tools.push(tool('task_events', 'Read append-only task event history.', schema({ task_id: { type: 'string' }, limit: { type: 'integer' }, before_id: { type: 'integer' } }, ['task_id']), args => store.events(args.task_id, args)))
  tools.push(tool('project_create', 'Create a project board with optional specification, roadmap, and outline JSON.', schema({ ...projectFields, id: { type: 'string' } }, ['title']), (args, exec) => store.createProject(args, { actor: actorFrom(args, exec) })))
  tools.push(tool('project_get', 'Get one project with its milestones.', schema({ id: { type: 'string' } }, ['id']), args => store.getProject(args.id)))
  tools.push(tool('project_list', 'List projects.', schema({}), args => store.listProjects()))
  tools.push(tool('project_update', 'Update project fields.', schema({ id: { type: 'string' }, ...projectFields }, ['id']), (args, exec) => { const { id, actor, ...patch } = args; return store.updateProject(id, patch, { actor: actor ?? actorFrom(args, exec) }) }))
  tools.push(tool('project_delete', 'Delete a project and cascade-delete its milestones.', schema({ id: { type: 'string' }, actor: { type: 'string' } }, ['id']), (args, exec) => store.deleteProject(args.id, { actor: actorFrom(args, exec) })))
  tools.push(tool('milestone_create', 'Create a milestone under a project.', schema({ ...milestoneFields, id: { type: 'string' } }, ['project_id', 'title']), (args, exec) => store.createMilestone(args, { actor: actorFrom(args, exec) })))
  tools.push(tool('milestone_get', 'Get one milestone.', schema({ id: { type: 'string' } }, ['id']), args => store.getMilestone(args.id)))
  tools.push(tool('milestone_list', 'List milestones for a project, ordered by position.', schema({ project_id: { type: 'string' } }, ['project_id']), args => store.listMilestones(args.project_id)))
  tools.push(tool('milestone_update', 'Update milestone fields.', schema({ id: { type: 'string' }, ...milestoneFields }, ['id']), (args, exec) => { const { id, actor, ...patch } = args; return store.updateMilestone(id, patch, { actor: actor ?? actorFrom(args, exec) }) }))
  tools.push(tool('milestone_delete', 'Delete a milestone.', schema({ id: { type: 'string' }, actor: { type: 'string' } }, ['id']), (args, exec) => store.deleteMilestone(args.id, { actor: actorFrom(args, exec) })))
  tools.push(tool('plan_import_preview', 'Parse a Markdown plan and return a non-mutating preview with proposal_id, source_checksum, project/milestones/stories, warnings, and unresolved references.', schema({ markdown: { type: 'string' }, source_label: { type: 'string' } }, ['markdown']), args => previewPlanImport(args.markdown, { source_label: args.source_label })))
  tools.push(tool('plan_import_apply', 'Apply a previously-previewed Markdown plan. Requires proposal_id/source_checksum for replay safety, is idempotent on identical source_label+checksum, and fails closed on conflicting replays.', schema({ markdown: { type: 'string' }, source_label: { type: 'string' }, source_checksum: { type: 'string' }, proposal_id: { type: 'string' }, dry_run: { type: 'boolean' }, actor: { type: 'string' } }, ['markdown']), (args, exec) => applyPlanImport(store, args.markdown, { source_label: args.source_label, source_checksum: args.source_checksum, proposal_id: args.proposal_id, dry_run: args.dry_run, actor: actorFrom(args, exec) })))
  return tools
}