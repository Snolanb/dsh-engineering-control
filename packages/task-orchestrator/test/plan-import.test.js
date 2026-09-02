import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../src/store.js'
import { previewPlanImport, applyPlanImport, PLAN_IMPORT_MAX_BYTES, PLAN_IMPORT_VERSION } from '../src/plan-import.js'

const SAMPLE_PLAN = `# Compact Demo Plan

**Status:** Planning

# 1. Objective

Build a compact demo planner that parses project plans.

# Story 1 — Project foundation

## Objective

Establish the durable foundation.

## Implementation decision

Use the existing task orchestrator.

## Ordered plan

1. Define migration
2. Persist project metadata
3. Add milestone CRUD

## Target files/symbols

- src/store.js
- src/plan-import.js

## Dependencies

- Blocked by: shared persistence foundation
- Enables: Story 2

## Scope boundaries

- Read-only MVP
- No external provider calls

## Required invariants

- Replay safety
- Idempotent apply

## Acceptance criteria

- GIVEN a valid plan
- WHEN previewed
- THEN no mutation occurs

- GIVEN an existing project with the same source identity
- WHEN applied
- THEN the existing project is returned

## Validation

\`\`\`bash
npm test
npm run build
\`\`\`

## Deviation policy

Stop if a heuristic guess is needed.

## Completion receipt

Report tests, ids, replay behavior.

# Story 2 — Story tasks

## Objective

Convert stories into tasks.

## Acceptance criteria

- Works.

## Dependencies

- Blocked by: Story 1

## Tranche A — Initial import

Implement:

1. Story 1
2. Story 2

Exit criterion:

> All stories and milestones persist.

# 7. MVP Completion Criteria

1. project persists with source identity
2. milestone contains exit criterion
3. story tasks expose acceptance criteria
`

test('preview returns deterministic checksum, project, milestones, and unresolved refs', () => {
  const preview = previewPlanImport(SAMPLE_PLAN, { source_label: 'COMPACT.md' })
  assert.equal(preview.version, PLAN_IMPORT_VERSION)
  assert.equal(preview.source_checksum.length, 64)
  assert.equal(preview.proposal_id.length, 64)
  assert.equal(preview.source_label, 'COMPACT.md')
  assert.equal(preview.project.title, 'Compact Demo Plan')
  assert.equal(preview.project.status, 'planning')
  assert.ok(preview.project.objective.includes('Build a compact demo planner'))
  assert.deepEqual(preview.project.completion_criteria, [
    'project persists with source identity',
    'milestone contains exit criterion',
    'story tasks expose acceptance criteria',
  ])
  assert.equal(preview.project.stories.length, 2)
  assert.equal(preview.project.stories[0].title, 'Project foundation')
  assert.equal(preview.project.stories[0].ordered_plan.length, 3)
  assert.equal(preview.project.stories[0].target_files.length, 2)
  assert.equal(preview.project.stories[0].blocked_by.length, 1)
  assert.equal(preview.project.stories[0].enables.length, 1)
  assert.equal(preview.project.stories[0].acceptance_criteria.length, 6)
  assert.equal(preview.project.stories[0].validation.length, 2)
  assert.equal(preview.project.stories[0].deviation_policy.length > 0, true)
  assert.equal(preview.project.tranches.length, 1)
  assert.equal(preview.project.tranches[0].code, 'A')
  assert.equal(preview.project.tranches[0].title, 'Initial import')
  assert.deepEqual(preview.project.tranches[0].implement, ['Story 1', 'Story 2'])
  assert.ok(preview.project.tranches[0].exit_criterion.includes('All stories'))
  assert.ok(preview.unresolved_references.some(ref => ref.target === 'shared persistence foundation'))
  assert.equal(preview.warnings.length, 0)
})

test('preview is mutation-free across repeated calls', () => {
  const preview = previewPlanImport(SAMPLE_PLAN, { source_label: 'IMMUTABLE.md' })
  const before = preview.source_checksum
  for (let i = 0; i < 5; i += 1) {
    const next = previewPlanImport(SAMPLE_PLAN, { source_label: 'IMMUTABLE.md' })
    assert.equal(next.source_checksum, before)
    assert.equal(next.proposal_id, preview.proposal_id)
    assert.equal(next.project.stories.length, preview.project.stories.length)
  }
})

test('apply persists one project, milestones, story tasks, and is idempotent', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plan-import-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  const result = applyPlanImport(store, SAMPLE_PLAN, { source_label: 'COMPACT.md', actor: 'importer' })
  assert.equal(result.replayed, false)
  assert.equal(result.project.source_label, 'COMPACT.md')
  assert.equal(result.project.source_checksum.length, 64)
  assert.equal(result.milestones.length, 1)
  assert.equal(result.milestones[0].name, 'A — Initial import')
  assert.equal(result.tasks.length, 2)
  assert.equal(result.tasks[0].project_id, result.project.id)
  assert.equal(result.tasks[0].milestone_id, result.milestones[0].id)
  assert.equal(result.tasks[0].relationship_type, 'story')

  const replay = applyPlanImport(store, SAMPLE_PLAN, { source_label: 'COMPACT.md', actor: 'importer' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.project.id, result.project.id)
  assert.equal(replay.tasks.length, 2)
  const allProjects = store.listProjects()
  assert.equal(allProjects.length, 1, 'replay must not create a second project')
})

test('apply requires matching source_checksum and proposal_id', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plan-import-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  applyPlanImport(store, SAMPLE_PLAN, { source_label: 'CHECK.md' })
  assert.throws(() => applyPlanImport(store, SAMPLE_PLAN, { source_label: 'CHECK.md', source_checksum: 'wrong' }), error => error.code === 'PLAN_IMPORT_CHECKSUM_MISMATCH')
  assert.throws(() => applyPlanImport(store, SAMPLE_PLAN, { source_label: 'CHECK.md', proposal_id: 'wrong' }), error => error.code === 'PLAN_IMPORT_PROPOSAL_MISMATCH')
})

test('conflicting source_label with a different checksum fails closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plan-import-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  applyPlanImport(store, SAMPLE_PLAN, { source_label: 'CONFLICT.md' })
  const altered = SAMPLE_PLAN + '\n# extra\n'
  assert.throws(() => applyPlanImport(store, altered, { source_label: 'CONFLICT.md' }), error => error.code === 'PLAN_IMPORT_SOURCE_CONFLICT')
})

test('malformed or oversized markdown is rejected', () => {
  assert.throws(() => previewPlanImport(''), error => error.message.includes('non-empty'))
  assert.throws(() => previewPlanImport(null), error => error.message.includes('string'))
  assert.throws(() => previewPlanImport('no headings here'), error => error.code === 'PLAN_IMPORT_EMPTY')
  assert.throws(() => previewPlanImport('# Title\n\n# 1. Objective\n\nX.' + '\n\n# Story 1 — A\n\n## Objective\n\nx' + '\n## Acceptance criteria\n- a'.repeat(20000)), error => error.code === 'PLAN_IMPORT_TOO_LARGE')
  const oversized = '# T\n\n# 1. Objective\n\nX\n\n' + ('# Story 1 — A\n\n## Objective\n\nx\n## Acceptance criteria\n- a\n'.repeat(20000))
  assert.ok(oversized.length > PLAN_IMPORT_MAX_BYTES)
  assert.throws(() => previewPlanImport(oversized), error => error.code === 'PLAN_IMPORT_TOO_LARGE')
})

test('dry-run apply does not persist anything', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plan-import-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const result = applyPlanImport(store, SAMPLE_PLAN, { source_label: 'DRY.md', dry_run: true })
  assert.equal(result.dry_run, true)
  assert.equal(result.project, null)
  assert.equal(store.listProjects().length, 0)
})

test('unresolved references are reported as warnings rather than guessed', () => {
  const md = `# Test

**Status:** Planning

# 1. Objective

Build a small plan.

# Story 1 — One

## Objective

X.

## Dependencies

- Blocked by: nonexistent upstream
- Enables: nonexistent downstream
`
  const preview = previewPlanImport(md)
  const unresolved = preview.unresolved_references.map(ref => ref.target).sort()
  assert.deepEqual(unresolved, ['nonexistent downstream', 'nonexistent upstream'])
  assert.ok(preview.warnings.some(w => w.code === 'PLAN_IMPORT_NO_COMPLETION_CRITERIA'))
})

test('Story N references resolve to actual story ids', t => {
  const md = `# Test

# 1. Objective

Build.

# Story 1 — First

## Objective

First.

## Dependencies

- Blocked by: shared base

# Story 2 — Second

## Objective

Second.

## Dependencies

- Blocked by: Story 1
`
  const preview = previewPlanImport(md)
  const unresolved = preview.unresolved_references.map(ref => ref.target)
  assert.ok(!unresolved.includes('Story 1'), 'Story 1 should resolve to story-second-second')
  assert.ok(unresolved.includes('shared base'), 'shared base should be reported as unresolved')
})

test('applies blocked_by dependencies that resolve by title', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plan-import-'))
  const store = new TaskStore({ dbPath: join(dir, 'tasks.db') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const md = `# Test

# 1. Objective

X.

# Story 1 — Foundation

## Objective

Base.

## Acceptance criteria

- Works.

# Story 2 — Dependent

## Objective

Depends on foundation.

## Dependencies

- Blocked by: Foundation

## Acceptance criteria

- Works.
`
  const result = applyPlanImport(store, md, { source_label: 'DEP.md' })
  assert.equal(result.tasks.length, 2)
  const dependent = store.get(result.tasks[1].id)
  assert.deepEqual(dependent.blocked_by, [result.tasks[0].id])
})

test('duplicate normalized story titles are ambiguous and unresolved', () => {
  const md = `# Duplicate Plan\n\n# 1. Objective\n\nX.\n\n# Story 1 — Same Title\n\n## Objective\n\nOne.\n\n# Story 2 — Same Title\n\n## Objective\n\nTwo.\n\n## Dependencies\n\n- Blocked by: Same Title\n`
  const preview = previewPlanImport(md)
  assert.ok(preview.warnings.some(w => w.code === 'PLAN_IMPORT_AMBIGUOUS_STORY_TITLE'))
  assert.ok(preview.unresolved_references.some(ref => ref.target === 'Same Title' && ref.ambiguous === true))
})

test('plan import enforces UTF-8 byte limit for multibyte input', () => {
  const markdown = 'é'.repeat(Math.floor(PLAN_IMPORT_MAX_BYTES / 2) + 1)
  assert.ok(markdown.length <= PLAN_IMPORT_MAX_BYTES)
  assert.throws(() => previewPlanImport(markdown), error => error.code === 'PLAN_IMPORT_TOO_LARGE')
})