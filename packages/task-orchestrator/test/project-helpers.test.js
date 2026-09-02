import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCriterionResultsPayload,
  buildHierarchy,
  buildRoadmapEdges,
  CRITERION_STATUSES,
  groupTasksByProjectMilestone,
  isDependencyBlocked,
  isReadyToRun,
  matchesFilter,
  milestoneExitCriteria,
  projectCompletionCriteria,
  ROADMAP_BLOCKING,
  ROADMAP_TYPED,
  summarizeCriteria,
  summarizeStatuses,
  TASK_LINK_TYPES,
  unmetCriteria,
} from '../src/project-helpers.js'

const SAMPLE_TASKS = [
  {
    id: 'root-a', title: 'Root A', status: 'ready', project_id: 'p1', milestone_id: 'm1',
    blocked_by: ['root-b'], ready_to_run: false, blocked_by_dependencies: true,
    acceptance_criteria: ['criterion text'], criterion_results: [{ criterion: 'criterion text', status: 'satisfied', evidence: 'tests pass' }],
  },
  {
    id: 'root-b', title: 'Root B', status: 'done', project_id: 'p1', milestone_id: 'm1',
    blocked_by: [], ready_to_run: false, blocked_by_dependencies: false,
    acceptance_criteria: [], criterion_results: [{ criterion: 'extra', status: 'pending' }],
  },
  {
    id: 'child-a1', title: 'Child A1', status: 'running', project_id: 'p1', milestone_id: 'm1',
    parent_id: 'root-a', blocked_by: [], ready_to_run: false,
    acceptance_criteria: [], criterion_results: [],
  },
  {
    id: 'orphan', title: 'Orphan', status: 'planning', project_id: 'p1', milestone_id: null,
    blocked_by: [], ready_to_run: false, acceptance_criteria: [], criterion_results: [],
  },
  {
    id: 'p2-task', title: 'P2 task', status: 'backlog', project_id: 'p2', milestone_id: null,
    blocked_by: [], ready_to_run: false, acceptance_criteria: [], criterion_results: [],
  },
]

const SAMPLE_PROJECTS = [
  {
    id: 'p1', title: 'Project one', status: 'active', description: 'desc',
    specification: { objective: 'ship it' }, roadmap: ['m1'], outline: [],
    milestones: [
      { id: 'm1', project_id: 'p1', title: 'Milestone one', status: 'active', position: 0 },
      { id: 'm2', project_id: 'p1', title: 'Milestone two', status: 'planning', position: 1, metadata: { exit_criteria: ['ship v1'] } },
    ],
  },
  { id: 'p2', title: 'Project two', status: 'planning', specification: {}, milestones: [] },
]

test('groupTasksByProjectMilestone builds project/milestone/unassigned buckets deterministically', () => {
  const grouped = groupTasksByProjectMilestone(SAMPLE_TASKS, { projects: SAMPLE_PROJECTS })
  const ids = grouped.map(group => group.id)
  assert.deepEqual(ids, ['p1', 'p2'])
  const p1 = grouped[0]
  assert.equal(p1.title, 'Project one')
  assert.equal(p1.milestones.length, 3) // m1, m2, unassigned
  const m1 = p1.milestones[0]
  assert.equal(m1.id, 'm1')
  assert.deepEqual(m1.tasks.map(t => t.id), ['child-a1', 'root-a', 'root-b'])
  const unassigned = p1.milestones[2]
  assert.equal(unassigned.id, '__no_milestone__')
  assert.deepEqual(unassigned.tasks.map(t => t.id), ['orphan'])
  const p2 = grouped[1]
  assert.equal(p2.milestones.length, 1)
  assert.deepEqual(p2.milestones[0].tasks.map(t => t.id), ['p2-task'])
})

test('groupTasksByProjectMilestone places unknown-project tasks under fallback bucket', () => {
  const grouped = groupTasksByProjectMilestone([{ id: 'x', status: 'backlog' }], { projects: [] })
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].id, '__no_project__')
  assert.deepEqual(grouped[0].milestones[0].tasks.map(t => t.id), ['x'])
})

test('buildHierarchy returns nested children for parent_id chains', () => {
  const roots = buildHierarchy(SAMPLE_TASKS.filter(t => t.project_id === 'p1'))
  const rootA = roots.find(root => root.id === 'root-a')
  assert.ok(rootA)
  assert.deepEqual(rootA.children.map(c => c.id), ['child-a1'])
  // root-b has no children
  const rootB = roots.find(root => root.id === 'root-b')
  assert.equal(rootB.children.length, 0)
  // orphan has no children and no parent in the slice
  const orphan = roots.find(root => root.id === 'orphan')
  assert.ok(orphan)
  assert.equal(orphan.children.length, 0)
})

test('summarizeStatuses counts tasks and excludes cancelled from percent', () => {
  const summary = summarizeStatuses([
    { id: '1', status: 'done' }, { id: '2', status: 'done' }, { id: '3', status: 'backlog' }, { id: '4', status: 'cancelled' },
  ])
  assert.equal(summary.total, 4)
  assert.equal(summary.done, 2)
  assert.equal(summary.cancelled, 1)
  assert.equal(summary.active_total, 3)
  assert.equal(summary.completion_percent, 66.67)
})

test('summarizeStatuses handles empty input deterministically', () => {
  const summary = summarizeStatuses([])
  assert.equal(summary.total, 0)
  assert.equal(summary.done, 0)
  assert.equal(summary.completion_percent, 0)
})

test('isReadyToRun and isDependencyBlocked mirror task semantics', () => {
  const blocked = { id: 'a', status: 'ready', blocked_by: ['b'], ready_to_run: false }
  assert.equal(isReadyToRun(blocked), false)
  assert.equal(isDependencyBlocked(blocked), true)
  const open = { id: 'c', status: 'ready', blocked_by: [], ready_to_run: true }
  assert.equal(isReadyToRun(open), true)
  assert.equal(isDependencyBlocked(open), false)
})

test('unmetCriteria excludes satisfied and waived entries', () => {
  const task = { id: 't', criterion_results: [
    { criterion: 'one', status: 'satisfied' },
    { criterion: 'two', status: 'pending' },
    { criterion: 'three', status: 'waived' },
    { criterion: 'four', status: 'pending' },
  ] }
  assert.deepEqual(unmetCriteria(task).map(c => c.criterion), ['two', 'four'])
})

test('summarizeCriteria totals all four buckets', () => {
  const counts = summarizeCriteria([
    { id: '1', criterion_results: [{ criterion: 'a', status: 'satisfied' }, { criterion: 'b', status: 'pending' }] },
    { id: '2', criterion_results: [{ criterion: 'c', status: 'waived' }, { criterion: 'd', status: 'unknown' }] },
  ])
  assert.equal(counts.total, 4)
  assert.equal(counts.satisfied, 1)
  assert.equal(counts.pending, 1)
  assert.equal(counts.waived, 1)
  assert.equal(counts.other, 1)
})

test('milestoneExitCriteria reads metadata exit_criteria and detects evidence', () => {
  const milestone = { id: 'm2', metadata: { exit_criteria: ['ship v1', 'docs published'] } }
  const childTasks = [{ id: 't1', criterion_results: [{ criterion: 'ship v1', status: 'satisfied' }] }]
  const exit = milestoneExitCriteria(milestone, childTasks)
  assert.equal(exit.length, 2)
  assert.equal(exit[0].met, true)
  assert.equal(exit[0].evidence_task_id, 't1')
  assert.equal(exit[1].met, false)
  assert.equal(exit[1].evidence_task_id, null)
})

test('milestoneExitCriteria returns empty when no exit_criteria present', () => {
  assert.deepEqual(milestoneExitCriteria({ id: 'm' }, []), [])
})

test('buildRoadmapEdges separates blocking deps from typed links and orders deterministically', () => {
  const tasks = [
    { id: 'a', status: 'ready', title: 'A', blocked_by: ['b'] },
    { id: 'b', status: 'done', title: 'B', blocked_by: [] },
    { id: 'c', status: 'ready', title: 'C', blocked_by: [] },
  ]
  const linksByTask = { a: [{ linked_task_id: 'c', link_type: 'enables' }], b: [], c: [] }
  const edges = buildRoadmapEdges(tasks, linksByTask)
  assert.equal(edges.blocking.length, 1)
  assert.equal(edges.blocking[0].kind, ROADMAP_BLOCKING)
  assert.equal(edges.blocking[0].from_id, 'b')
  assert.equal(edges.blocking[0].to_id, 'a')
  assert.equal(edges.typed.length, 1)
  assert.equal(edges.typed[0].kind, ROADMAP_TYPED)
  assert.equal(edges.typed[0].link_type, 'enables')
})

test('buildRoadmapEdges includes unresolved references so UI can render warnings', () => {
  const edges = buildRoadmapEdges([{ id: 'a', title: 'A', status: 'ready', blocked_by: ['ghost'] }], {})
  assert.equal(edges.blocking.length, 1)
  assert.equal(edges.blocking[0].from, null)
})

test('matchesFilter handles all/unassigned/exact selector semantics', () => {
  assert.equal(matchesFilter('p1', undefined), true)
  assert.equal(matchesFilter('p1', null), true)
  assert.equal(matchesFilter('p1', ''), false)
  assert.equal(matchesFilter(null, ''), true)
  assert.equal(matchesFilter('p1', 'p1'), true)
  assert.equal(matchesFilter('p2', 'p1'), false)
})

test('buildCriterionResultsPayload normalizes entries and rejects bad status', () => {
  const ok = buildCriterionResultsPayload([
    { criterion: 'one', status: 'satisfied', evidence: 'see sha' },
    { criterion: 'two', status: 'pending' },
  ])
  assert.equal(ok.ok, true)
  assert.equal(ok.normalized.length, 2)
  assert.equal(ok.normalized[0].index, 0)
  assert.equal(ok.normalized[0].status, 'satisfied')
  const bad = buildCriterionResultsPayload([{ criterion: 'a', status: 'made_up' }])
  assert.equal(bad.ok, false)
  assert.match(bad.error, /status must be one of/)
  const notArray = buildCriterionResultsPayload('nope')
  assert.equal(notArray.ok, false)
})

test('projectCompletionCriteria reads from metadata or specification or top-level', () => {
  assert.deepEqual(projectCompletionCriteria({ id: 'p', completion_criteria: ['a'] }), ['a'])
  assert.deepEqual(projectCompletionCriteria({ id: 'p', metadata: { completion_criteria: ['b'] } }), ['b'])
  assert.deepEqual(projectCompletionCriteria({ id: 'p', specification: { completion_criteria: ['c'] } }), ['c'])
  assert.deepEqual(projectCompletionCriteria({ id: 'p' }), [])
})

test('module re-exports the shared enums from client-api surface', () => {
  assert.equal(CRITERION_STATUSES.length, 3)
  assert.equal(TASK_LINK_TYPES.length, 4)
})
