import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, InvalidTransitionError, TaskStoreError } from '../src/store.js'

function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-task-orchestrator-'))
  let now = options.now ?? 1_000
  const clock = () => now
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db'), clock, ...options })
  return {
    dir,
    store,
    setNow(value) { now = value },
    advance(ms) { now += ms },
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('creates and retrieves normalized task data', t => {
  const f = fixture({ maxAttemptsDefault: 4 }); t.after(() => f.cleanup())
  const created = f.store.create({
    id: 'task-1', title: 'Implement store', description: 'details', priority: 'high',
    acceptance_criteria: ['schema exists', 'tests pass'], workspace: '/repo', repo: 'org/repo', branch: 'main',
    worker_profile: 'ornith', worker_model: 'model-a', reviewer_profile: 'sol', reviewer_model: 'model-b',
    task_type: 'implementation', github_repo: 'org/repo', github_issue: 42,
    metadata: { source: 'github', labels: ['backend'] },
  }, { actor: 'manager' })
  assert.equal(created.status, 'backlog')
  assert.deepEqual(created.acceptance_criteria, ['schema exists', 'tests pass'])
  assert.equal(created.max_attempts, 4)
  assert.equal(created.github_issue, 42)
  assert.deepEqual(f.store.get('task-1'), created)
  assert.equal(f.store.list({ status: 'backlog' }).length, 1)
  assert.equal(f.store.events('task-1').at(-1).event_type, 'task_created')
})

test('validates obvious transitions while allowing future states', t => {
  const f = fixture(); t.after(() => f.cleanup())
  f.store.create({ id: 'flow', title: 'Flow' })
  f.store.update('flow', { status: 'planning' })
  f.store.update('flow', { status: 'ready' })
  assert.throws(() => f.store.update('flow', { status: 'done' }), InvalidTransitionError)
  f.store.update('flow', { status: 'future_state' })
  assert.equal(f.store.get('flow').status, 'future_state')
  f.store.update('flow', { status: 'ready' })
  assert.equal(f.store.get('flow').status, 'ready')
})

test('atomically prevents double claims and supports lease renewal and expiry', t => {
  const f = fixture({ now: 0 }); t.after(() => f.cleanup())
  const second = new TaskStore({ dbPath: join(f.dir, 'tasks.db'), clock: f.store.clock })
  t.after(() => second.close())
  f.store.create({ id: 'claim', title: 'Claim me', status: 'ready' })
  assert.equal(f.store.claim('claim', 'worker-a', { lease_seconds: 10 }).claimed, true)
  const denied = second.claim('claim', 'worker-b', { lease_seconds: 10 })
  assert.equal(denied.claimed, false)
  assert.equal(denied.reason, 'already_claimed')
  f.advance(1_000)
  const renewed = f.store.renewLease('claim', 'worker-a', { lease_seconds: 20 })
  assert.equal(renewed.renewed, true)
  assert.equal(renewed.task.lease_expires_at, 21_000)
  f.setNow(21_000)
  assert.equal(f.store.renewLease('claim', 'worker-a').renewed, false)
  const reclaimed = second.claim('claim', 'worker-b', { lease_seconds: 5 })
  assert.equal(reclaimed.claimed, true)
  assert.equal(reclaimed.task.claimed_by, 'worker-b')
})

test('requires lease ownership and rejects expired worker mutations', t => {
  const f = fixture({ now: 0 }); t.after(() => f.cleanup())
  f.store.create({ id: 'owned', title: 'Owned task', status: 'ready' })
  f.store.claim('owned', 'owner', { lease_seconds: 1 })
  assert.throws(() => f.store.start('owned'), error => error instanceof TypeError && error.message.includes('worker'))
  assert.throws(() => f.store.start('owned', 'other'), error => error.code === 'LEASE_OWNER_MISMATCH')
  f.setNow(1_000)
  for (const operation of [
    () => f.store.release('owned', 'owner'),
    () => f.store.complete('owned', {}, { worker: 'owner' }),
    () => f.store.block('owned', 'expired', { worker: 'owner' }),
  ]) assert.throws(operation, error => error.code === 'LEASE_EXPIRED')
})


test('dependency readiness is separate from explicit blocked status', t => {
  const f = fixture(); t.after(() => f.cleanup())
  f.store.create({ id: 'blocker', title: 'Blocker', status: 'ready' })
  f.store.create({ id: 'dependent', title: 'Dependent', status: 'ready' })
  f.store.addDependency('dependent', 'blocker')
  assert.deepEqual(f.store.get('dependent').blocked_by, ['blocker'])
  assert.equal(f.store.readyToRun('dependent').ready_to_run, false)
  assert.equal(f.store.claim('dependent', 'worker').reason, 'blocked_by_dependencies')
  f.store.update('blocker', { status: 'claimed' })
  assert.equal(f.store.get('dependent').blocked_by_dependencies, true)
  f.store.removeDependency('dependent', 'blocker')
  assert.equal(f.store.get('dependent').ready_to_run, true)
  f.store.block('dependent', 'manual pause')
  assert.equal(f.store.get('dependent').status, 'blocked')
  assert.equal(f.store.blockedByDependencies('dependent').blocked_by_dependencies, false)
  f.store.unblock('dependent')
  assert.equal(f.store.get('dependent').status, 'ready')
})

test('rejects dependency cycles and supports parent child decomposition', t => {
  const f = fixture(); t.after(() => f.cleanup())
  f.store.create({ id: 'parent', title: 'Parent' })
  f.store.addChild('parent', { id: 'child', title: 'Child' })
  f.store.addChild('child', { id: 'grandchild', title: 'Grandchild' })
  assert.deepEqual(f.store.listChildren('parent').map(task => task.id), ['child'])
  assert.deepEqual(f.store.listDescendants('parent').map(task => task.id), ['child', 'grandchild'])
  f.store.create({ id: 'a', title: 'A' })
  f.store.create({ id: 'b', title: 'B' })
  f.store.addDependency('a', 'b')
  assert.throws(() => f.store.addDependency('b', 'a'), error => error instanceof TaskStoreError && error.code === 'DEPENDENCY_CYCLE')
})

test('runs worker lifecycle and stores structured completion output', t => {
  const f = fixture(); t.after(() => f.cleanup())
  f.store.create({ id: 'review', title: 'Review task', status: 'ready' })
  f.store.claim('review', 'worker-1')
  const started = f.store.start('review', 'worker-1')
  assert.equal(started.attempts, 1)
  const reviewed = f.store.complete('review', {
    result_summary: 'implemented API', commit_sha: 'abc123', files_changed: ['src/store.js'],
    tests_run: ['node --test'], remaining_blockers: [],
  }, { worker: 'worker-1', actor: 'worker-1' })
  assert.equal(reviewed.status, 'in_review')
  assert.equal(reviewed.claimed_by, null)
  assert.equal(reviewed.completed_at, null)
  assert.deepEqual(reviewed.files_changed, ['src/store.js'])
  assert.equal(reviewed.commit_sha, 'abc123')
  f.store.requestChanges('review', 'add migration test', { actor: 'sol' })
  f.store.update('review', { status: 'ready' }, { actor: 'sol' })
  assert.equal(f.store.get('review').status, 'ready')
  const eventTypes = f.store.events('review').map(event => event.event_type)
  for (const required of ['task_created', 'task_claimed', 'task_started', 'task_completed', 'review_changes_requested', 'status_changed']) assert.ok(eventTypes.includes(required), required)
})

test('clears terminal timestamps when a failed task is retried', t => {
  const f = fixture({ now: 1_000 }); t.after(() => f.cleanup())
  f.store.create({ id: 'retry', title: 'Retry task', status: 'ready' })
  f.store.claim('retry', 'worker')
  f.store.start('retry', 'worker')
  const failed = f.store.fail('retry', { result_summary: 'first attempt failed' }, { worker: 'worker' })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.completed_at, 1_000)
  f.setNow(2_000)
  const ready = f.store.update('retry', { status: 'ready' })
  assert.equal(ready.started_at, null)
  assert.equal(ready.completed_at, null)
  f.store.claim('retry', 'worker')
  const restarted = f.store.start('retry', 'worker')
  assert.equal(restarted.attempts, 2)
  assert.equal(restarted.started_at, 2_000)
})


test('event history and tasks persist across close and reopen', t => {
  const f = fixture();
  f.store.create({ id: 'persist', title: 'Persisted' }, { actor: 'manager' })
  const dbPath = f.store.dbPath
  f.store.close()
  const reopened = new TaskStore({ dbPath, clock: f.store.clock })
  assert.equal(reopened.get('persist').title, 'Persisted')
  assert.equal(reopened.events('persist').at(-1).event_type, 'task_created')
  reopened.close(); rmSync(f.dir, { recursive: true, force: true })
})

test('initializes schema and applies the next migration on reopen', t => {
  const f = fixture();
  f.store.create({ id: 'migration', title: 'Migration fixture' })
  f.store.db.exec('DROP INDEX idx_tasks_lease')
  f.store.db.exec('PRAGMA user_version = 1')
  const path = f.store.dbPath
  f.store.close()
  const reopened = new TaskStore({ dbPath: path, clock: f.store.clock })
  const version = Number(reopened.db.prepare('PRAGMA user_version').get().user_version)
  const indexes = reopened.db.prepare('PRAGMA index_list(tasks)').all().map(row => row.name)
  assert.equal(version, 3)
  assert.ok(indexes.includes('idx_tasks_lease'))
  assert.ok(reopened.get('migration'))
  reopened.close(); rmSync(f.dir, { recursive: true, force: true })
})

test('creates, updates, and deletes projects with milestones', t => {
  const f = fixture(); t.after(() => f.cleanup())
  const project = f.store.createProject({ title: 'Project board', description: 'demo', status: 'active', specification: { vision: 'go' } })
  assert.equal(project.status, 'active')
  assert.equal(project.name, 'Project board')
  assert.equal(project.specification, undefined)
  assert.deepEqual(f.store.db.prepare('SELECT specification FROM projects WHERE id = ?').get(project.id).specification, JSON.stringify({ vision: 'go' }))
  assert.equal(project.milestones.length, 0)
  const milestone = f.store.createMilestone({ project_id: project.id, title: 'M1', position: 2 })
  assert.equal(milestone.position, 2)
  assert.deepEqual(f.store.listMilestones(project.id).map(m => m.id), [milestone.id])
  assert.equal(f.store.getProject(project.id).milestones.length, 1)
  const updated = f.store.updateProject(project.id, { title: 'Renamed', status: 'completed' })
  assert.equal(updated.name, 'Renamed')
  assert.equal(updated.status, 'completed')
  const updatedMs = f.store.updateMilestone(milestone.id, { title: 'M1-updated', position: 5 })
  assert.equal(updatedMs.position, 5)
  assert.throws(() => f.store.updateMilestone(milestone.id, { project_id: 'missing' }), error => error.code === 'PROJECT_NOT_FOUND')
  assert.throws(() => f.store.updateProject('missing', { title: 'x' }), error => error.code === 'PROJECT_NOT_FOUND')
  assert.throws(() => f.store.deleteProject('missing'), error => error.code === 'PROJECT_NOT_FOUND')
  assert.throws(() => f.store.deleteMilestone('missing'), error => error.code === 'MILESTONE_NOT_FOUND')
  assert.throws(() => f.store.createProject({ status: 'bogus', title: 'bad' }), error => error instanceof TypeError)
  f.store.deleteMilestone(milestone.id)
  assert.equal(f.store.getMilestone(milestone.id), null)
  f.store.deleteProject(project.id)
  assert.equal(f.store.getProject(project.id), null)
})

test('nonblocking task links and criterion results update', t => {
  const f = fixture(); t.after(() => f.cleanup())
  f.store.create({ id: 'a', title: 'A' })
  f.store.create({ id: 'b', title: 'B' })
  const first = f.store.addTaskLink('a', 'b', 'enables')
  assert.equal(first.added, true)
  const dup = f.store.addTaskLink('a', 'b', 'enables')
  assert.equal(dup.added, false)
  assert.deepEqual(f.store.listTaskLinks('a').map(link => link.link_type), ['enables'])
  const filtered = f.store.listTaskLinks('a', { link_type: 'usually_follows' })
  assert.deepEqual(filtered, [])
  f.store.addTaskLink('a', 'b', 'usually_follows')
  assert.deepEqual(f.store.listTaskLinks('a', { link_type: 'usually_follows' }).map(link => link.linked_task_id), ['b'])
  assert.throws(() => f.store.addTaskLink('a', 'b', 'bogus'), error => error instanceof TypeError)
  assert.throws(() => f.store.addTaskLink('a', 'a', 'related_to'), error => error.code === 'TASK_LINK_CYCLE')
  assert.throws(() => f.store.addTaskLink('missing', 'a', 'related_to'), error => error.code === 'TASK_NOT_FOUND')
  const removed = f.store.removeTaskLink('a', 'b', 'enables')
  assert.equal(removed.removed, true)
  assert.equal(f.store.listTaskLinks('a').length, 1)
  const created = f.store.create({ id: 'c', title: 'C', acceptance_criteria: ['c1', 'c2'] })
  assert.deepEqual(created.criterion_results, [])
  const updated = f.store.setCriterionResults('c', [{ criterion: 'c1', status: 'met', evidence: 'demo' }, { criterion: 'c2', status: 'pending' }])
  assert.equal(updated.criterion_results[0].status, 'met')
  assert.equal(updated.criterion_results[1].evidence, '')
  assert.throws(() => f.store.setCriterionResults('c', [{ criterion: 1, status: 'met' }]), error => error instanceof TypeError)
})

test('task list filters by project and milestone', t => {
  const f = fixture(); t.after(() => f.cleanup())
  const project = f.store.createProject({ title: 'P' })
  const milestone = f.store.createMilestone({ project_id: project.id, title: 'M' })
  f.store.create({ id: 'in-project', title: 'in project', project_id: project.id, milestone_id: milestone.id })
  f.store.create({ id: 'orphan', title: 'orphan' })
  assert.deepEqual(f.store.list({ project_id: project.id }).map(t => t.id), ['in-project'])
  assert.deepEqual(f.store.list({ milestone_id: milestone.id }).map(t => t.id), ['in-project'])
  assert.deepEqual(f.store.list({ project_id: null }).map(t => t.id), ['orphan'])
  assert.deepEqual(f.store.list({ relationship_type: 'task' }).map(t => t.id).sort(), ['in-project', 'orphan'])
  f.store.update('orphan', { relationship_type: 'spike' })
  assert.deepEqual(f.store.list({ relationship_type: 'spike' }).map(t => t.id), ['orphan'])
})
