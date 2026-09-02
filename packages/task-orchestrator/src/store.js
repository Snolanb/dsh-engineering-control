import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Initial lifecycle states supported by the store. Unknown non-empty states remain extensible. */
export const TASK_STATUSES = Object.freeze([
  'backlog',
  'planning',
  'ready',
  'claimed',
  'running',
  'in_review',
  'changes_requested',
  'blocked',
  'failed',
  'done',
  'cancelled',
])

export const TASK_EVENT_TYPES = Object.freeze([
  'task_created',
  'task_updated',
  'status_changed',
  'task_claimed',
  'task_released',
  'lease_renewed',
  'dependency_added',
  'dependency_removed',
  'task_completed',
  'task_failed',
  'review_changes_requested',
  'task_started',
  'task_blocked',
  'task_unblocked',
  'task_deleted',
  'project_updated',
  'project_deleted',
  'milestone_updated',
  'milestone_deleted',
  'task_link_added',
  'task_link_removed',
  'criterion_results_updated',
])

export const CURRENT_SCHEMA_VERSION = 3

export const PROJECT_STATUSES = Object.freeze(['planning', 'active', 'blocked', 'completed', 'cancelled'])
export const TASK_LINK_TYPES = Object.freeze(['enables', 'usually_follows', 'benefits_from', 'related_to'])
export const DEFAULT_LEASE_SECONDS = 30 * 60
export const DEFAULT_MAX_ATTEMPTS = 3

/** Obvious known-state transitions. Unknown states are allowed to/from for forward compatibility. */
export const KNOWN_TRANSITIONS = Object.freeze({
  backlog: ['planning', 'ready', 'blocked', 'cancelled'],
  planning: ['backlog', 'ready', 'blocked', 'failed', 'cancelled'],
  ready: ['planning', 'claimed', 'blocked', 'failed', 'cancelled'],
  claimed: ['ready', 'running', 'blocked', 'failed', 'cancelled'],
  running: ['ready', 'in_review', 'blocked', 'failed', 'cancelled'],
  in_review: ['done', 'changes_requested', 'blocked', 'failed', 'cancelled'],
  changes_requested: ['planning', 'ready', 'blocked', 'cancelled'],
  blocked: ['planning', 'ready', 'failed', 'cancelled'],
  failed: ['ready', 'cancelled'],
  done: [],
  cancelled: [],
})

export class TaskStoreError extends Error {
  constructor(message, code = 'TASK_STORE_ERROR') {
    super(message)
    this.name = 'TaskStoreError'
    this.code = code
  }
}

export class TaskNotFoundError extends TaskStoreError {
  constructor(id) {
    super('task not found: ' + id, 'TASK_NOT_FOUND')
    this.name = 'TaskNotFoundError'
  }
}

export class InvalidTransitionError extends TaskStoreError {
  constructor(from, to) {
    super('invalid task transition: ' + from + ' -> ' + to, 'INVALID_TRANSITION')
    this.name = 'InvalidTransitionError'
  }
}

export class DependencyBlockedError extends TaskStoreError {
  constructor(id, blockers) {
    super('task ' + id + ' is blocked by dependencies: ' + blockers.join(', '), 'DEPENDENCY_BLOCKED')
    this.name = 'DependencyBlockedError'
    this.blockers = blockers
  }
}

function nowMs(clock) {
  const value = Number(clock())
  if (!Number.isFinite(value)) throw new TypeError('clock must return a finite number')
  return Math.trunc(value)
}

function expandHome(value, home = homedir()) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

export function defaultDbPath(env = process.env, home = homedir()) {
  const root = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? expandHome(env.DSH_HOME.trim(), home)
    : join(home, '.dsh')
  return join(root, 'task-orchestrator', 'tasks.db')
}

function resolveDbPath(value) {
  if (value === ':memory:') return value
  const raw = value === undefined || value === null || value === '' ? defaultDbPath() : expandHome(String(value))
  return isAbsolute(raw) ? raw : join(process.cwd(), raw)
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function cloneJson(value, label) {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new TypeError(label + ' must be JSON-compatible: ' + (error instanceof Error ? error.message : String(error)))
  }
}

function jsonText(value, fallback, label) {
  const normalized = value === undefined ? fallback : cloneJson(value, label)
  try {
    return JSON.stringify(normalized)
  } catch (error) {
    throw new TypeError(label + ' must be JSON-compatible: ' + (error instanceof Error ? error.message : String(error)))
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function optionalString(value, label) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new TypeError(label + ' must be a string')
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(label + ' must be a non-empty string')
  return value.trim()
}

function nonNegativeInteger(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(label + ' must be a non-negative safe integer')
  return value
}

function positiveInteger(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(label + ' must be a positive safe integer')
  return value
}

function stringArray(value, label, fallback = []) {
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError(label + ' must be an array of strings')
  }
  return value.map(item => item.trim()).filter(item => item !== '')
}

function jsonArray(value, label, fallback = []) {
  if (value === undefined || value === null) return cloneJson(fallback, label)
  if (!Array.isArray(value)) throw new TypeError(label + ' must be an array')
  return cloneJson(value, label)
}

function metadataValue(value) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) throw new TypeError('metadata must be a JSON object')
  return cloneJson(value, 'metadata')
}

function field(input, snake, camel = snake) {
  if (Object.prototype.hasOwnProperty.call(input, snake)) return input[snake]
  if (camel !== snake && Object.prototype.hasOwnProperty.call(input, camel)) return input[camel]
  return undefined
}

function normalizeStatus(value, fallback = 'backlog') {
  const raw = value === undefined || value === null ? fallback : value
  return requiredString(raw, 'status')
}

function validateTransition(from, to) {
  if (from === to) return
  const allowed = KNOWN_TRANSITIONS[from]
  if (allowed !== undefined && KNOWN_TRANSITIONS[to] !== undefined && !allowed.includes(to)) {
    throw new InvalidTransitionError(from, to)
  }
}

function normalizeLeaseSeconds(value, fallback) {
  return positiveInteger(value, 'lease_seconds', fallback)
}

function statusIsTerminal(status) {
  return status === 'done' || status === 'cancelled'
}

function eventPayload(value) {
  return value === undefined ? {} : cloneJson(value, 'event payload')
}

function normalizeCriterionResults(value) {
  if (!Array.isArray(value)) throw new TypeError('criterion_results must be an array')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('criterion_results[' + index + '] must be an object')
    const indexValue = entry.index ?? entry.criterion_index ?? entry.criterionIndex
    const criterion = entry.criterion ?? entry.name ?? ''
    const status = entry.status ?? entry.state ?? 'pending'
    const evidence = entry.evidence ?? entry.proof ?? ''
    return {
      index: Number.isInteger(indexValue) ? indexValue : index,
      criterion: optionalString(criterion, 'criterion') ?? '',
      status: optionalString(status, 'status') ?? 'pending',
      evidence: optionalString(evidence, 'evidence') ?? '',
      updated_at: entry.updated_at ?? entry.updatedAt ?? null,
    }
  })
}

function taskFieldsFromInput(input, defaults) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('task input must be an object')
  const title = requiredString(field(input, 'title'), 'title')
  const status = normalizeStatus(field(input, 'status'), defaults.status)
  const priority = optionalString(field(input, 'priority'), 'priority') ?? defaults.priority
  const maxAttempts = nonNegativeInteger(field(input, 'max_attempts', 'maxAttempts'), 'max_attempts', defaults.maxAttempts)
  const attempts = nonNegativeInteger(field(input, 'attempts'), 'attempts', 0)
  const acceptance = stringArray(field(input, 'acceptance_criteria', 'acceptanceCriteria'), 'acceptance_criteria')
  const githubIssueValue = field(input, 'github_issue', 'githubIssue')
  return {
    id: field(input, 'id') === undefined ? randomUUID() : requiredString(field(input, 'id'), 'id'),
    title,
    description: optionalString(field(input, 'description'), 'description') ?? '',
    status,
    priority,
    parent_id: optionalString(field(input, 'parent_id', 'parentId'), 'parent_id'),
    project_id: optionalString(field(input, 'project_id', 'projectId'), 'project_id'),
    milestone_id: optionalString(field(input, 'milestone_id', 'milestoneId'), 'milestone_id'),
    relationship_type: optionalString(field(input, 'relationship_type', 'relationshipType'), 'relationship_type') ?? 'task',
    specification: metadataValue(field(input, 'specification')),
    roadmap: jsonArray(field(input, 'roadmap'), 'roadmap'),
    outline: jsonArray(field(input, 'outline'), 'outline'),
    completion_evidence: metadataValue(field(input, 'completion_evidence', 'completionEvidence')),
    criterion_results: (() => {
      const raw = field(input, 'criterion_results', 'criterionResults')
      return raw === undefined || raw === null ? [] : normalizeCriterionResults(raw)
    })(),
    workspace: optionalString(field(input, 'workspace'), 'workspace'),
    repo: optionalString(field(input, 'repo'), 'repo'),
    branch: optionalString(field(input, 'branch'), 'branch'),
    worker_profile: optionalString(field(input, 'worker_profile', 'workerProfile'), 'worker_profile'),
    worker_model: optionalString(field(input, 'worker_model', 'workerModel'), 'worker_model'),
    reviewer_profile: optionalString(field(input, 'reviewer_profile', 'reviewerProfile'), 'reviewer_profile'),
    reviewer_model: optionalString(field(input, 'reviewer_model', 'reviewerModel'), 'reviewer_model'),
    acceptance_criteria: acceptance,
    task_type: optionalString(field(input, 'task_type', 'taskType'), 'task_type'),
    attempts,
    max_attempts: maxAttempts,
    github_repo: optionalString(field(input, 'github_repo', 'githubRepo'), 'github_repo'),
    github_issue: githubIssueValue === undefined || githubIssueValue === null ? null : positiveInteger(githubIssueValue, 'github_issue', undefined),
    result_summary: optionalString(field(input, 'result_summary', 'resultSummary'), 'result_summary'),
    commit_sha: optionalString(field(input, 'commit_sha', 'commitSha'), 'commit_sha'),
    files_changed: jsonArray(field(input, 'files_changed', 'filesChanged'), 'files_changed'),
    tests_run: jsonArray(field(input, 'tests_run', 'testsRun'), 'tests_run'),
    remaining_blockers: jsonArray(field(input, 'remaining_blockers', 'remainingBlockers'), 'remaining_blockers'),
    metadata: metadataValue(field(input, 'metadata')),
  }
}

const TASK_INSERT_COLUMNS = Object.freeze([
  'id', 'title', 'description', 'status', 'priority', 'parent_id', 'project_id', 'milestone_id', 'relationship_type',
  'specification', 'roadmap', 'outline', 'completion_evidence', 'workspace', 'repo', 'branch',
  'worker_profile', 'worker_model', 'reviewer_profile', 'reviewer_model',
  'acceptance_criteria', 'task_type', 'attempts', 'max_attempts', 'github_repo', 'github_issue',
  'result_summary', 'commit_sha', 'files_changed', 'tests_run', 'remaining_blockers', 'metadata',
  'created_at', 'updated_at',
])
const CREATE_SQL = String.raw`INSERT INTO tasks (${TASK_INSERT_COLUMNS.join(', ')}) VALUES (${TASK_INSERT_COLUMNS.map(() => '?').join(', ')})`

function migrationV1(db, timestamp) {
  db.exec(String.raw`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog',
      priority TEXT NOT NULL DEFAULT 'normal',
      parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      workspace TEXT,
      repo TEXT,
      branch TEXT,
      worker_profile TEXT,
      worker_model TEXT,
      reviewer_profile TEXT,
      reviewer_model TEXT,
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      task_type TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 0),
      claimed_by TEXT,
      claimed_at INTEGER,
      lease_expires_at INTEGER,
      github_repo TEXT,
      github_issue INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      result_summary TEXT,
      commit_sha TEXT,
      files_changed TEXT NOT NULL DEFAULT '[]',
      tests_run TEXT NOT NULL DEFAULT '[]',
      remaining_blockers TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id),
      CHECK (task_id <> depends_on_task_id)
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      actor TEXT,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ${timestamp});
  `)
}

function migrationV2(db, timestamp) {
  db.exec(String.raw`
    CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_worker_profile_status ON tasks(worker_profile, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_dependencies_dependency ON task_dependencies(depends_on_task_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_events_task_time ON task_events(task_id, id);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ${timestamp});
  `)
}

function migrationV3(db, timestamp) {
  const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name))
  const addColumn = (name, sql) => { if (!columns.has(name)) db.exec('ALTER TABLE tasks ADD COLUMN ' + sql) }
  const addProjectColumn = (name, sql) => {
    const projectColumns = new Set(db.prepare('PRAGMA table_info(projects)').all().map(row => row.name))
    if (!projectColumns.has(name)) db.exec('ALTER TABLE projects ADD COLUMN ' + sql)
  }
  const addMilestoneColumn = (name, sql) => {
    const milestoneColumns = new Set(db.prepare('PRAGMA table_info(milestones)').all().map(row => row.name))
    if (!milestoneColumns.has(name)) db.exec('ALTER TABLE milestones ADD COLUMN ' + sql)
  }
  db.exec(String.raw`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planning',
      workspace TEXT,
      repo TEXT,
      branch TEXT,
      specification TEXT NOT NULL DEFAULT '{}',
      roadmap TEXT NOT NULL DEFAULT '[]',
      outline TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog',
      position INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_milestones_project_position ON milestones(project_id, position, created_at);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ${timestamp});
  `)
  addColumn('project_id', 'project_id TEXT REFERENCES projects(id) ON DELETE SET NULL')
  addColumn('milestone_id', 'milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL')
  addColumn('relationship_type', "relationship_type TEXT NOT NULL DEFAULT 'task'")
  addColumn('specification', "specification TEXT NOT NULL DEFAULT '{}'")
  addColumn('roadmap', "roadmap TEXT NOT NULL DEFAULT '[]'")
  addColumn('outline', "outline TEXT NOT NULL DEFAULT '[]'")
  addColumn('completion_evidence', "completion_evidence TEXT NOT NULL DEFAULT '{}'")
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project_milestone ON tasks(project_id, milestone_id, created_at)')
  // Canonical project fields folded into v3: name is the canonical form of
  // title (title remains the column for backward compatibility); description
  // is a separate canonical field distinct from `objective` which captures the
  // # N. Objective body text from the Markdown plan importer.
  addProjectColumn('objective', "objective TEXT NOT NULL DEFAULT ''")
  addProjectColumn('completion_criteria', "completion_criteria TEXT NOT NULL DEFAULT '[]'")
  addProjectColumn('source_label', 'source_label TEXT')
  addProjectColumn('source_checksum', 'source_checksum TEXT')
  addProjectColumn('completed_at', 'completed_at INTEGER')
  addMilestoneColumn('exit_criteria', "exit_criteria TEXT NOT NULL DEFAULT '[]'")
  addMilestoneColumn('completed_at', 'completed_at INTEGER')
  migrationV4(db, timestamp)
}

function migrationV4(db, timestamp) {
  db.exec(String.raw`
    CREATE TABLE IF NOT EXISTS task_links (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      linked_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL CHECK (link_type IN ('enables','usually_follows','benefits_from','related_to')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, linked_task_id, link_type), CHECK (task_id <> linked_task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_links_linked ON task_links(linked_task_id);
  `)
  const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name))
  if (!columns.has('criterion_results')) db.exec("ALTER TABLE tasks ADD COLUMN criterion_results TEXT NOT NULL DEFAULT '[]'")
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_criterion ON tasks(project_id, milestone_id)')
}

/**
 * Canonical project output.
 *
 * Projects expose name (canonical of `title`), description, objective,
 * completion_criteria, source_label, source_checksum, completed_at plus
 * status, timestamps, workspace, repo, branch, and milestones.
 *
 * The older `title`/`specification`/`roadmap`/`outline` columns remain
 * documented input-only backward-compatible aliases — `title` is mirrored
 * onto `name` for legacy callers, and the JSON columns are accepted on
 * create/update but not echoed in canonical project output.
 */
function canonicalProject(row, store) {
  if (!row) return null
  return {
    id: row.id,
    name: row.title,
    description: typeof row.description === 'string' ? row.description : '',
    objective: typeof row.objective === 'string' ? row.objective : (typeof row.description === 'string' ? row.description : ''),
    status: row.status,
    workspace: row.workspace,
    repo: row.repo,
    branch: row.branch,
    completion_criteria: parseJson(row.completion_criteria, []),
    source_label: row.source_label ?? null,
    source_checksum: row.source_checksum ?? null,
    completed_at: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    metadata: parseJson(row.metadata, {}),
    milestones: store ? store.listMilestones(row.id) : [],
  }
}

/**
 * Canonical milestone output.
 *
 * Milestones expose name (canonical of `title`), description, position,
 * exit_criteria, completed_at plus status, due_at, project_id, and
 * timestamps.
 */
function canonicalMilestone(row) {
  if (!row) return null
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.title,
    description: typeof row.description === 'string' ? row.description : '',
    status: row.status,
    position: Number(row.position),
    due_at: row.due_at === null || row.due_at === undefined ? null : Number(row.due_at),
    exit_criteria: parseJson(row.exit_criteria, []),
    completed_at: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    metadata: parseJson(row.metadata, {}),
  }
}

export class TaskStore {
  constructor(options = {}) {
    this.dbPath = resolveDbPath(options.dbPath)
    this.defaultLeaseSeconds = normalizeLeaseSeconds(options.defaultLeaseSeconds, DEFAULT_LEASE_SECONDS)
    this.maxAttemptsDefault = nonNegativeInteger(options.maxAttemptsDefault, 'max_attempts_default', DEFAULT_MAX_ATTEMPTS)
    this.clock = options.clock ?? Date.now
    this.listeners = new Set()
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.initializeSchema()
  }

  initializeSchema() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)')
    const current = Number(this.db.prepare('PRAGMA user_version').get().user_version ?? 0)
    if (current > CURRENT_SCHEMA_VERSION) throw new TaskStoreError('database schema version ' + current + ' is newer than supported version ' + CURRENT_SCHEMA_VERSION, 'SCHEMA_TOO_NEW')
    if (current < 1) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        migrationV1(this.db, nowMs(this.clock))
        this.db.exec('PRAGMA user_version = 1')
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    const afterV1 = Number(this.db.prepare('PRAGMA user_version').get().user_version ?? 0)
    if (afterV1 < 2) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        migrationV2(this.db, nowMs(this.clock))
        this.db.exec('PRAGMA user_version = 2')
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    const afterV2 = Number(this.db.prepare('PRAGMA user_version').get().user_version ?? 0)
    if (afterV2 < 3) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        migrationV3(this.db, nowMs(this.clock))
        this.db.exec('PRAGMA user_version = 3')
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  close() {
    if (this.db !== undefined) {
      this.db.close()
      this.db = undefined
    }
    this.listeners.clear()
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  _notify() {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* observer failures cannot break the store */ }
    }
  }

  _write(callback) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = callback(this.db)
      this.db.exec('COMMIT')
      this._notify()
      return value
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve original failure */ }
      throw error
    }
  }

  _row(id, db = this.db) {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null
  }

  _requireRow(id, db = this.db) {
    const row = this._row(id, db)
    if (row === null) throw new TaskNotFoundError(id)
    return row
  }

  _dependencyIds(id, db = this.db) {
    return db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at, depends_on_task_id').all(id).map(row => row.depends_on_task_id)
  }

  _blockerIds(id, db = this.db) {
    return db.prepare(String.raw`
      SELECT d.id
      FROM task_dependencies dep
      JOIN tasks d ON d.id = dep.depends_on_task_id
      WHERE dep.task_id = ? AND d.status <> 'done'
      ORDER BY dep.created_at, d.id
    `).all(id).map(row => row.id)
  }

  _hydrate(row, db = this.db) {
    if (row === null) return null
    const dependencies = this._dependencyIds(row.id, db)
    const blockers = this._blockerIds(row.id, db)
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      parent_id: row.parent_id,
      project_id: row.project_id ?? null,
      milestone_id: row.milestone_id ?? null,
      relationship_type: row.relationship_type ?? 'task',
      specification: parseJson(row.specification, {}),
      roadmap: parseJson(row.roadmap, []),
      outline: parseJson(row.outline, []),
      completion_evidence: parseJson(row.completion_evidence, {}),
      criterion_results: parseJson(row.criterion_results, []),
      blocked_by: blockers,
      dependencies,
      ready_to_run: row.status === 'ready' && blockers.length === 0 && (Number(row.max_attempts) === 0 || Number(row.attempts) < Number(row.max_attempts)),
      blocked_by_dependencies: blockers.length > 0,
      workspace: row.workspace,
      repo: row.repo,
      branch: row.branch,
      worker_profile: row.worker_profile,
      worker_model: row.worker_model,
      reviewer_profile: row.reviewer_profile,
      reviewer_model: row.reviewer_model,
      acceptance_criteria: parseJson(row.acceptance_criteria, []),
      task_type: row.task_type,
      attempts: Number(row.attempts),
      max_attempts: Number(row.max_attempts),
      claimed_by: row.claimed_by,
      claimed_at: row.claimed_at === null ? null : Number(row.claimed_at),
      lease_expires_at: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
      github_repo: row.github_repo,
      github_issue: row.github_issue === null ? null : Number(row.github_issue),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      started_at: row.started_at === null ? null : Number(row.started_at),
      completed_at: row.completed_at === null ? null : Number(row.completed_at),
      result_summary: row.result_summary,
      commit_sha: row.commit_sha,
      files_changed: parseJson(row.files_changed, []),
      tests_run: parseJson(row.tests_run, []),
      remaining_blockers: parseJson(row.remaining_blockers, []),
      metadata: parseJson(row.metadata, {}),
    }
  }

  get(id) {
    return this._hydrate(this._row(requiredString(id, 'id')))
  }

  list(options = {}) {
    const clauses = ['1 = 1']
    const params = []
    const statuses = options.statuses ?? (options.status === undefined ? undefined : [options.status])
    if (statuses !== undefined) {
      if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some(status => typeof status !== 'string' || status.trim() === '')) throw new TypeError('statuses must be a non-empty array of strings')
      clauses.push('status IN (' + statuses.map(() => '?').join(', ') + ')')
      params.push(...statuses)
    }
    const parentId = field(options, 'parent_id', 'parentId')
    if (parentId !== undefined) {
      clauses.push('parent_id = ?')
      params.push(requiredString(parentId, 'parent_id'))
    }
    const projectId = field(options, 'project_id', 'projectId')
    if (projectId !== undefined) {
      const value = projectId === null ? null : requiredString(projectId, 'project_id')
      if (value === null) clauses.push('project_id IS NULL')
      else { clauses.push('project_id = ?'); params.push(value) }
    }
    const milestoneId = field(options, 'milestone_id', 'milestoneId')
    if (milestoneId !== undefined) {
      const value = milestoneId === null ? null : requiredString(milestoneId, 'milestone_id')
      if (value === null) clauses.push('milestone_id IS NULL')
      else { clauses.push('milestone_id = ?'); params.push(value) }
    }
    const relationshipType = field(options, 'relationship_type', 'relationshipType')
    if (relationshipType !== undefined) {
      clauses.push('relationship_type = ?')
      params.push(requiredString(relationshipType, 'relationship_type'))
    }
    const workerProfile = field(options, 'worker_profile', 'workerProfile')
    if (workerProfile !== undefined) {
      clauses.push('worker_profile = ?')
      params.push(requiredString(workerProfile, 'worker_profile'))
    }
    const claimedBy = field(options, 'claimed_by', 'claimedBy')
    if (claimedBy !== undefined) {
      clauses.push('claimed_by = ?')
      params.push(requiredString(claimedBy, 'claimed_by'))
    }
    if (options.ready_to_run === true || options.readyToRun === true) {
      clauses.push(String.raw`status = 'ready' AND (tasks.max_attempts = 0 OR tasks.attempts < tasks.max_attempts) AND NOT EXISTS (
        SELECT 1 FROM task_dependencies dep JOIN tasks blocker ON blocker.id = dep.depends_on_task_id
        WHERE dep.task_id = tasks.id AND blocker.status <> 'done'
      )`)
    }
    if (options.blocked_by_dependencies === true || options.blockedByDependencies === true) {
      clauses.push(String.raw`EXISTS (
        SELECT 1 FROM task_dependencies dep JOIN tasks blocker ON blocker.id = dep.depends_on_task_id
        WHERE dep.task_id = tasks.id AND blocker.status <> 'done'
      )`)
    }
    if (options.expired_claims === true || options.expiredClaims === true) {
      clauses.push("status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?")
      params.push(nowMs(this.clock))
    }
    if (options.in_review === true || options.inReview === true) clauses.push("status = 'in_review'")
    const limit = Math.min(500, positiveInteger(options.limit, 'limit', 100))
    const offset = nonNegativeInteger(options.offset, 'offset', 0)
    params.push(limit, offset)
    const rows = this.db.prepare(String.raw`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, created_at, id LIMIT ? OFFSET ?`).all(...params)
    return rows.map(row => this._hydrate(row))
  }

  _insertDependency(taskId, dependencyId, timestamp, db) {
    const existing = db.prepare('SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?').get(taskId, dependencyId)
    if (existing !== undefined) return false
    const cycle = db.prepare(String.raw`
      WITH RECURSIVE prerequisites(id) AS (
        SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
        UNION
        SELECT dep.depends_on_task_id FROM task_dependencies dep JOIN prerequisites p ON dep.task_id = p.id
      ) SELECT 1 FROM prerequisites WHERE id = ? LIMIT 1
    `).get(dependencyId, taskId)
    if (cycle !== undefined) throw new TaskStoreError('dependency would create a cycle', 'DEPENDENCY_CYCLE')
    db.prepare('INSERT INTO task_dependencies(task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)').run(taskId, dependencyId, timestamp)
    return true
  }

  _appendEvent(taskId, type, actor, payload, db, timestamp = nowMs(this.clock)) {
    const result = db.prepare('INSERT INTO task_events(task_id, event_type, timestamp, actor, payload) VALUES (?, ?, ?, ?, ?)').run(taskId, type, timestamp, optionalString(actor, 'actor'), jsonText(eventPayload(payload), {}, 'event payload'))
    return Number(result.lastInsertRowid)
  }

  _statusEvent(taskId, from, to, actor, timestamp, db) {
    if (from !== to) this._appendEvent(taskId, 'status_changed', actor, { from, to }, db, timestamp)
  }

  create(input, options = {}) {
    const values = taskFieldsFromInput(input, { status: 'backlog', priority: 'normal', maxAttempts: this.maxAttemptsDefault })
    const timestamp = nowMs(this.clock)
    const blockedBy = stringArray(field(input, 'blocked_by', 'blockedBy'), 'blocked_by')
    return this._write(db => {
      if (this._row(values.id, db) !== null) throw new TaskStoreError('task id already exists: ' + values.id, 'TASK_EXISTS')
      if (values.parent_id !== null) this._requireRow(values.parent_id, db)
       if (values.project_id !== null && db.prepare('SELECT 1 FROM projects WHERE id = ?').get(values.project_id) === undefined) throw new TaskStoreError('project not found: ' + values.project_id, 'PROJECT_NOT_FOUND')
       if (values.milestone_id !== null) {
         const milestone = db.prepare('SELECT project_id FROM milestones WHERE id = ?').get(values.milestone_id)
         if (milestone === undefined) throw new TaskStoreError('milestone not found: ' + values.milestone_id, 'MILESTONE_NOT_FOUND')
         if (values.project_id === null || milestone.project_id !== values.project_id) throw new TaskStoreError('milestone does not belong to project', 'MILESTONE_PROJECT_MISMATCH')
       }
      db.prepare(CREATE_SQL).run(
        values.id, values.title, values.description, values.status, values.priority, values.parent_id,
        values.project_id, values.milestone_id, values.relationship_type,
         jsonText(values.specification, {}, 'specification'), jsonText(values.roadmap, [], 'roadmap'),
         jsonText(values.outline, [], 'outline'), jsonText(values.completion_evidence, {}, 'completion_evidence'),
         values.workspace, values.repo, values.branch, values.worker_profile, values.worker_model,
        values.reviewer_profile, values.reviewer_model, jsonText(values.acceptance_criteria, [], 'acceptance_criteria'),
        values.task_type, values.attempts, values.max_attempts, values.github_repo, values.github_issue,
        values.result_summary, values.commit_sha, jsonText(values.files_changed, [], 'files_changed'),
        jsonText(values.tests_run, [], 'tests_run'), jsonText(values.remaining_blockers, [], 'remaining_blockers'),
        jsonText(values.metadata, {}, 'metadata'), timestamp, timestamp,
      )
      if (values.criterion_results !== undefined && values.criterion_results.length > 0) {
        db.prepare('UPDATE tasks SET criterion_results = ? WHERE id = ?').run(jsonText(values.criterion_results, [], 'criterion_results'), values.id)
      }
      this._appendEvent(values.id, 'task_created', options.actor, { status: values.status, parent_id: values.parent_id }, db, timestamp)
      for (const dependencyId of [...new Set(blockedBy)].sort()) {
        this._requireRow(dependencyId, db)
        if (this._insertDependency(values.id, dependencyId, timestamp, db)) this._appendEvent(values.id, 'dependency_added', options.actor, { depends_on_task_id: dependencyId }, db, timestamp)
      }
      return this._hydrate(this._requireRow(values.id, db), db)
    })
  }

  update(id, patch, options = {}) {
    const taskId = requiredString(id, 'id')
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new TypeError('patch must be an object')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      const before = this._requireRow(taskId, db)
      const allowed = {
        title: 'title', description: 'description', priority: 'priority', parent_id: 'parent_id',
        project_id: 'project_id', milestone_id: 'milestone_id', relationship_type: 'relationship_type',
        specification: 'specification', roadmap: 'roadmap', outline: 'outline', completion_evidence: 'completion_evidence',
        workspace: 'workspace', repo: 'repo', branch: 'branch', worker_profile: 'worker_profile',
        worker_model: 'worker_model', reviewer_profile: 'reviewer_profile', reviewer_model: 'reviewer_model',
        acceptance_criteria: 'acceptance_criteria', criterion_results: 'criterion_results',
        task_type: 'task_type', attempts: 'attempts', max_attempts: 'max_attempts',
        github_repo: 'github_repo', github_issue: 'github_issue', result_summary: 'result_summary', commit_sha: 'commit_sha',
        files_changed: 'files_changed', tests_run: 'tests_run', remaining_blockers: 'remaining_blockers', metadata: 'metadata',
      }
      const setters = []
      const params = []
      const changes = {}
      const add = (name, value) => { setters.push(name + ' = ?'); params.push(value); changes[name] = value }
      const statusRaw = field(patch, 'status')
      let nextStatus = before.status
      if (statusRaw !== undefined) {
        nextStatus = normalizeStatus(statusRaw, before.status)
        validateTransition(before.status, nextStatus)
        if (nextStatus !== before.status) add('status', nextStatus)
      }
      for (const [inputName, column] of Object.entries(allowed)) {
        const value = field(patch, inputName, inputName)
        if (value === undefined) continue
        if (inputName === 'title') add(column, requiredString(value, 'title'))
        else if (inputName === 'description' || inputName === 'priority' || inputName === 'task_type' || inputName === 'workspace' || inputName === 'repo' || inputName === 'branch' || inputName === 'worker_profile' || inputName === 'worker_model' || inputName === 'reviewer_profile' || inputName === 'reviewer_model' || inputName === 'github_repo' || inputName === 'result_summary' || inputName === 'commit_sha') add(column, optionalString(value, inputName))
        else if (inputName === 'parent_id') {
          const parentId = optionalString(value, 'parent_id')
          if (parentId === taskId) throw new TaskStoreError('a task cannot be its own parent', 'PARENT_CYCLE')
          if (parentId !== null) {
            this._requireRow(parentId, db)
            let cursor = parentId
            while (cursor !== null) {
              if (cursor === taskId) throw new TaskStoreError('parent relationship would create a cycle', 'PARENT_CYCLE')
              const parentRow = this._row(cursor, db)
              cursor = parentRow?.parent_id ?? null
            }
          }
          add(column, parentId)
        } else if (inputName === 'project_id' || inputName === 'milestone_id') add(column, optionalString(value, inputName))
        else if (inputName === 'relationship_type') add(column, requiredString(value, 'relationship_type'))
        else if (inputName === 'specification' || inputName === 'completion_evidence') add(column, jsonText(metadataValue(value), {}, inputName))
        else if (inputName === 'roadmap' || inputName === 'outline') add(column, jsonText(jsonArray(value, inputName), [], inputName))
        else if (inputName === 'acceptance_criteria') add(column, jsonText(stringArray(value, 'acceptance_criteria'), [], 'acceptance_criteria'))
        else if (inputName === 'criterion_results') add(column, jsonText(normalizeCriterionResults(value), [], 'criterion_results'))
        else if (inputName === 'attempts') add(column, nonNegativeInteger(value, 'attempts', undefined))
        else if (inputName === 'max_attempts') add(column, nonNegativeInteger(value, 'max_attempts', undefined))
        else if (inputName === 'github_issue') add(column, value === null ? null : positiveInteger(value, 'github_issue', undefined))
        else if (inputName === 'files_changed' || inputName === 'tests_run' || inputName === 'remaining_blockers') add(column, jsonText(jsonArray(value, inputName), [], inputName))
        else if (inputName === 'metadata') add(column, jsonText(metadataValue(value), {}, 'metadata'))
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'project_id') || Object.prototype.hasOwnProperty.call(patch, 'projectId') || Object.prototype.hasOwnProperty.call(patch, 'milestone_id') || Object.prototype.hasOwnProperty.call(patch, 'milestoneId')) {
        const targetProject = Object.prototype.hasOwnProperty.call(patch, 'project_id') ? optionalString(patch.project_id, 'project_id') : (Object.prototype.hasOwnProperty.call(patch, 'projectId') ? optionalString(patch.projectId, 'project_id') : before.project_id)
        const targetMilestone = Object.prototype.hasOwnProperty.call(patch, 'milestone_id') ? optionalString(patch.milestone_id, 'milestone_id') : (Object.prototype.hasOwnProperty.call(patch, 'milestoneId') ? optionalString(patch.milestoneId, 'milestone_id') : before.milestone_id)
        if (targetProject !== null && db.prepare('SELECT 1 FROM projects WHERE id = ?').get(targetProject) === undefined) throw new TaskStoreError('project not found: ' + targetProject, 'PROJECT_NOT_FOUND')
        if (targetMilestone !== null) { const milestone = db.prepare('SELECT project_id FROM milestones WHERE id = ?').get(targetMilestone); if (milestone === undefined) throw new TaskStoreError('milestone not found: ' + targetMilestone, 'MILESTONE_NOT_FOUND'); if (targetProject === null || milestone.project_id !== targetProject) throw new TaskStoreError('milestone does not belong to project', 'MILESTONE_PROJECT_MISMATCH') }
      }
      if (nextStatus !== before.status && !['claimed', 'running'].includes(nextStatus)) {
        add('claimed_by', null)
        add('claimed_at', null)
        add('lease_expires_at', null)
      }
      if (nextStatus === 'ready' || nextStatus === 'planning' || nextStatus === 'backlog') {
        add('started_at', null)
        add('completed_at', null)
      }
      if (nextStatus === 'changes_requested') add('completed_at', null)
      if (nextStatus === 'running' && before.started_at === null) add('started_at', timestamp)
      if (statusIsTerminal(nextStatus) && before.completed_at === null) add('completed_at', timestamp)
      if (setters.length === 0) return this._hydrate(before, db)
      add('updated_at', timestamp)
      params.push(taskId)
      db.prepare('UPDATE tasks SET ' + setters.join(', ') + ' WHERE id = ?').run(...params)
      this._statusEvent(taskId, before.status, nextStatus, options.actor, timestamp, db)
      this._appendEvent(taskId, 'task_updated', options.actor, { changes }, db, timestamp)
      return this._hydrate(this._requireRow(taskId, db), db)
    })
  }

  delete(id, options = {}) {
    const taskId = requiredString(id, 'id')
    return this._write(db => {
      const before = this._requireRow(taskId, db)
      this._appendEvent(taskId, 'task_deleted', options.actor, { title: before.title, status: before.status }, db)
      db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
      return { deleted: true, id: taskId }
    })
  }

  claim(id, worker, options = {}) {
    const taskId = requiredString(id, 'id')
    const owner = requiredString(worker, 'worker')
    const leaseSeconds = normalizeLeaseSeconds(options.lease_seconds ?? options.leaseSeconds, this.defaultLeaseSeconds)
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      const row = this._requireRow(taskId, db)
      const blockers = this._blockerIds(taskId, db)
      if (blockers.length > 0) return { claimed: false, reason: 'blocked_by_dependencies', blockers, task: this._hydrate(row, db) }
      const expired = row.lease_expires_at !== null && Number(row.lease_expires_at) <= timestamp
      if (!['ready', 'claimed', 'running'].includes(row.status)) return { claimed: false, reason: 'not_claimable', task: this._hydrate(row, db) }
      if ((row.status === 'claimed' || row.status === 'running') && !expired) return { claimed: false, reason: 'already_claimed', task: this._hydrate(row, db) }
      if (Number(row.max_attempts) > 0 && Number(row.attempts) >= Number(row.max_attempts)) return { claimed: false, reason: 'max_attempts_exceeded', task: this._hydrate(row, db) }
      const leaseExpires = timestamp + leaseSeconds * 1000
      db.prepare('UPDATE tasks SET status = ?, claimed_by = ?, claimed_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?').run('claimed', owner, timestamp, leaseExpires, timestamp, taskId)
      this._statusEvent(taskId, row.status, 'claimed', options.actor ?? owner, timestamp, db)
      this._appendEvent(taskId, 'task_claimed', options.actor ?? owner, { claimed_by: owner, lease_expires_at: leaseExpires }, db, timestamp)
      return { claimed: true, task: this._hydrate(this._requireRow(taskId, db), db) }
    })
  }

  _assertOwner(row, worker) {
    const owner = requiredString(worker, 'worker')
    if (row.claimed_by !== owner) throw new TaskStoreError('task is owned by ' + (row.claimed_by ?? 'another worker'), 'LEASE_OWNER_MISMATCH')
  }

  _assertActiveLease(row, worker, timestamp) {
    this._assertOwner(row, worker)
    if (row.lease_expires_at === null || Number(row.lease_expires_at) <= timestamp) throw new TaskStoreError('task claim lease has expired', 'LEASE_EXPIRED')
  }

  release(id, worker, options = {}) {
    const taskId = requiredString(id, 'id')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      const row = this._requireRow(taskId, db)
      if (!['claimed', 'running'].includes(row.status)) return { released: false, reason: 'not_claimed', task: this._hydrate(row, db) }
      this._assertActiveLease(row, worker, timestamp)
      db.prepare('UPDATE tasks SET status = ?, claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL, started_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?').run('ready', timestamp, taskId)
      this._statusEvent(taskId, row.status, 'ready', options.actor ?? worker, timestamp, db)
      this._appendEvent(taskId, 'task_released', options.actor ?? worker, { previous_status: row.status }, db, timestamp)
      return { released: true, task: this._hydrate(this._requireRow(taskId, db), db) }
    })
  }

  renewLease(id, worker, options = {}) {
    const taskId = requiredString(id, 'id')
    const owner = requiredString(worker, 'worker')
    const leaseSeconds = normalizeLeaseSeconds(options.lease_seconds ?? options.leaseSeconds, this.defaultLeaseSeconds)
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      const row = this._requireRow(taskId, db)
      if (row.claimed_by !== owner) return { renewed: false, reason: 'lease_owner_mismatch', task: this._hydrate(row, db) }
      if (!['claimed', 'running'].includes(row.status)) return { renewed: false, reason: 'not_claimed', task: this._hydrate(row, db) }
      if (row.lease_expires_at === null || Number(row.lease_expires_at) <= timestamp) return { renewed: false, reason: 'lease_expired', task: this._hydrate(row, db) }
      const leaseExpires = timestamp + leaseSeconds * 1000
      db.prepare('UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?').run(leaseExpires, timestamp, taskId)
      this._appendEvent(taskId, 'lease_renewed', options.actor ?? owner, { lease_expires_at: leaseExpires }, db, timestamp)
      return { renewed: true, task: this._hydrate(this._requireRow(taskId, db), db) }
    })
  }

  start(id, worker, options = {}) {
    const taskId = requiredString(id, 'id')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      const row = this._requireRow(taskId, db)
      if (row.status !== 'claimed') throw new TaskStoreError('task must be claimed before it can start', 'TASK_NOT_CLAIMED')
      this._assertActiveLease(row, worker, timestamp)
      if (Number(row.max_attempts) > 0 && Number(row.attempts) >= Number(row.max_attempts)) throw new TaskStoreError('task max_attempts exceeded', 'MAX_ATTEMPTS_EXCEEDED')
      const attempts = Number(row.attempts) + 1
      db.prepare('UPDATE tasks SET status = ?, attempts = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?').run('running', attempts, timestamp, timestamp, taskId)
      this._statusEvent(taskId, row.status, 'running', options.actor ?? worker, timestamp, db)
      this._appendEvent(taskId, 'task_started', options.actor ?? worker, { attempts }, db, timestamp)
      return this._hydrate(this._requireRow(taskId, db), db)
    })
  }

  complete(id, result = {}, options = {}) {
    return this._finish(id, 'in_review', result, options)
  }

  fail(id, result = {}, options = {}) {
    return this._finish(id, 'failed', result, options)
  }

  _finish(id, targetStatus, result, options = {}) {
    const taskId = requiredString(id, 'id')
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new TypeError('result must be an object')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      const row = this._requireRow(taskId, db)
      if (!['claimed', 'running'].includes(row.status)) throw new TaskStoreError('task must be claimed or running before it can finish', 'TASK_NOT_RUNNING')
      this._assertActiveLease(row, options.worker, timestamp)
      const resultSummary = field(result, 'result_summary', 'resultSummary')
      const commitSha = field(result, 'commit_sha', 'commitSha')
      const filesChanged = field(result, 'files_changed', 'filesChanged')
      const testsRun = field(result, 'tests_run', 'testsRun')
      const remainingBlockers = field(result, 'remaining_blockers', 'remainingBlockers')
      const updates = {
        result_summary: resultSummary === undefined ? row.result_summary : optionalString(resultSummary, 'result_summary'),
        commit_sha: commitSha === undefined ? row.commit_sha : optionalString(commitSha, 'commit_sha'),
        files_changed: filesChanged === undefined ? parseJson(row.files_changed, []) : jsonArray(filesChanged, 'files_changed'),
        tests_run: testsRun === undefined ? parseJson(row.tests_run, []) : jsonArray(testsRun, 'tests_run'),
        remaining_blockers: remainingBlockers === undefined ? parseJson(row.remaining_blockers, []) : jsonArray(remainingBlockers, 'remaining_blockers'),
      }
      db.prepare(String.raw`UPDATE tasks SET status = ?, claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL,
        completed_at = ?, result_summary = ?, commit_sha = ?, files_changed = ?, tests_run = ?, remaining_blockers = ?, updated_at = ? WHERE id = ?`).run(
        targetStatus, targetStatus === 'in_review' ? null : timestamp, updates.result_summary, updates.commit_sha,
        jsonText(updates.files_changed, [], 'files_changed'), jsonText(updates.tests_run, [], 'tests_run'),
        jsonText(updates.remaining_blockers, [], 'remaining_blockers'), timestamp, taskId,
      )
      this._statusEvent(taskId, row.status, targetStatus, options.actor ?? options.worker, timestamp, db)
      this._appendEvent(taskId, targetStatus === 'in_review' ? 'task_completed' : 'task_failed', options.actor ?? options.worker, {
        result_summary: updates.result_summary,
        commit_sha: updates.commit_sha,
        files_changed: updates.files_changed,
        tests_run: updates.tests_run,
        remaining_blockers: updates.remaining_blockers,
      }, db, timestamp)
      return this._hydrate(this._requireRow(taskId, db), db)
    })
  }

  block(id, reason, options = {}) {
    const taskId = requiredString(id, 'id')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      const row = this._requireRow(taskId, db)
      if (statusIsTerminal(row.status)) throw new InvalidTransitionError(row.status, 'blocked')
      if (['claimed', 'running'].includes(row.status)) this._assertActiveLease(row, options.worker, timestamp)
      const blockers = options.remaining_blockers ?? options.remainingBlockers ?? (reason === undefined ? parseJson(row.remaining_blockers, []) : [requiredString(reason, 'reason')])
      const normalized = jsonArray(blockers, 'remaining_blockers')
      db.prepare(String.raw`UPDATE tasks SET status = 'blocked', claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL,
        remaining_blockers = ?, updated_at = ? WHERE id = ?`).run(jsonText(normalized, [], 'remaining_blockers'), timestamp, taskId)
      this._statusEvent(taskId, row.status, 'blocked', options.actor ?? options.worker, timestamp, db)
      this._appendEvent(taskId, 'task_blocked', options.actor ?? options.worker, { reason: reason ?? null, remaining_blockers: normalized }, db, timestamp)
      return this._hydrate(this._requireRow(taskId, db), db)
    })
  }

  unblock(id, options = {}) {
    const taskId = requiredString(id, 'id')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      const row = this._requireRow(taskId, db)
      if (row.status !== 'blocked') throw new InvalidTransitionError(row.status, 'ready')
      db.prepare(`UPDATE tasks SET status = 'ready', remaining_blockers = '[]', started_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`).run(timestamp, taskId)
      this._statusEvent(taskId, row.status, 'ready', options.actor, timestamp, db)
      this._appendEvent(taskId, 'task_unblocked', options.actor, {}, db, timestamp)
      return this._hydrate(this._requireRow(taskId, db), db)
    })
  }

  requestChanges(id, reason, options = {}) {
    const taskId = requiredString(id, 'id')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      const row = this._requireRow(taskId, db)
      if (row.status !== 'in_review') throw new InvalidTransitionError(row.status, 'changes_requested')
      const payload = reason === undefined ? parseJson(row.remaining_blockers, []) : [requiredString(reason, 'reason')]
      db.prepare('UPDATE tasks SET status = ?, remaining_blockers = ?, updated_at = ? WHERE id = ?').run('changes_requested', jsonText(payload, [], 'remaining_blockers'), timestamp, taskId)
      this._statusEvent(taskId, row.status, 'changes_requested', options.actor, timestamp, db)
      this._appendEvent(taskId, 'review_changes_requested', options.actor, { reason: reason ?? null, remaining_blockers: payload }, db, timestamp)
      return this._hydrate(this._requireRow(taskId, db), db)
    })
  }

  readyToRun(id) {
    const task = this.get(id)
    if (task === null) return null
    return { task_id: task.id, ready_to_run: task.ready_to_run, blocked_by_dependencies: task.blocked_by.length > 0, blockers: task.blocked_by, status: task.status }
  }

  blockedByDependencies(id) {
    const task = this.get(id)
    if (task === null) return null
    return { task_id: task.id, blocked_by_dependencies: task.blocked_by.length > 0, blockers: task.blocked_by, ready_to_run: task.ready_to_run, status: task.status }
  }

  addDependency(taskId, dependencyId, options = {}) {
    const id = requiredString(taskId, 'task_id')
    const dependsOn = requiredString(dependencyId, 'depends_on_task_id')
    if (id === dependsOn) throw new TaskStoreError('a task cannot depend on itself', 'DEPENDENCY_CYCLE')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      this._requireRow(id, db)
      this._requireRow(dependsOn, db)
      const added = this._insertDependency(id, dependsOn, timestamp, db)
      if (added) this._appendEvent(id, 'dependency_added', options.actor, { depends_on_task_id: dependsOn }, db, timestamp)
      return { added, task: this._hydrate(this._requireRow(id, db), db) }
    })
  }

  removeDependency(taskId, dependencyId, options = {}) {
    const id = requiredString(taskId, 'task_id')
    const dependsOn = requiredString(dependencyId, 'depends_on_task_id')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      this._requireRow(id, db)
      const result = db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?').run(id, dependsOn)
      const removed = Number(result.changes) === 1
      if (removed) this._appendEvent(id, 'dependency_removed', options.actor, { depends_on_task_id: dependsOn }, db, timestamp)
      return { removed, task: this._hydrate(this._requireRow(id, db), db) }
    })
  }

  createProject(input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('project input must be an object')
    const id = field(input, 'id') === undefined ? randomUUID() : requiredString(field(input, 'id'), 'id')
    const title = requiredString(field(input, 'title', 'name'), 'name')
    const timestamp = nowMs(this.clock)
    const status = optionalString(field(input, 'status'), 'status') ?? 'planning'
    if (!PROJECT_STATUSES.includes(status)) throw new TypeError('status must be one of: ' + PROJECT_STATUSES.join(', '))
    const objective = optionalString(field(input, 'objective'), 'objective') ?? optionalString(field(input, 'description'), 'description') ?? ''
    const completionCriteria = jsonArray(field(input, 'completion_criteria', 'completionCriteria'), 'completion_criteria')
    const sourceLabel = optionalString(field(input, 'source_label', 'sourceLabel'), 'source_label')
    const sourceChecksum = optionalString(field(input, 'source_checksum', 'sourceChecksum'), 'source_checksum')
    const values = [id, title, optionalString(field(input, 'description'), 'description') ?? '', status, optionalString(field(input, 'workspace'), 'workspace'), optionalString(field(input, 'repo'), 'repo'), optionalString(field(input, 'branch'), 'branch'), jsonText(metadataValue(field(input, 'specification')), {}, 'specification'), jsonText(jsonArray(field(input, 'roadmap'), 'roadmap'), [], 'roadmap'), jsonText(jsonArray(field(input, 'outline'), 'outline'), [], 'outline'), jsonText(metadataValue(field(input, 'metadata')), {}, 'metadata'), timestamp, timestamp, objective, jsonText(completionCriteria, [], 'completion_criteria'), sourceLabel, sourceChecksum, null]
    return this._write(db => { db.prepare('INSERT INTO projects (id,title,description,status,workspace,repo,branch,specification,roadmap,outline,metadata,created_at,updated_at,objective,completion_criteria,source_label,source_checksum,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values); return this.getProject(id) })
  }

  getProject(id) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(requiredString(id, 'id'))
    if (!row) return null
    return canonicalProject(row, this)
  }

  listProjects() { return this.db.prepare('SELECT * FROM projects ORDER BY created_at, id').all().map(row => this.getProject(row.id)) }

  findProjectBySource(sourceLabel, sourceChecksum) {
    if (typeof sourceLabel !== 'string' || sourceLabel.trim() === '') return null
    if (typeof sourceChecksum !== 'string' || sourceChecksum.trim() === '') return null
    const row = this.db.prepare('SELECT id FROM projects WHERE source_label = ? AND source_checksum = ? ORDER BY created_at, id LIMIT 1').get(sourceLabel, sourceChecksum)
    return row ? this.getProject(row.id) : null
  }

  projectProgress(projectId) {
    const id = requiredString(projectId, 'project_id')
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) throw new TaskStoreError('project not found: ' + id, 'PROJECT_NOT_FOUND')
    return this._progress('project_id', id)
  }

  milestoneProgress(milestoneId) {
    const id = requiredString(milestoneId, 'milestone_id')
    if (!this.db.prepare('SELECT 1 FROM milestones WHERE id = ?').get(id)) throw new TaskStoreError('milestone not found: ' + id, 'MILESTONE_NOT_FOUND')
    return this._progress('milestone_id', id)
  }

  _progress(column, id) {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM tasks WHERE ' + column + ' = ? GROUP BY status').all(id)
    const counts = Object.fromEntries(rows.map(r => [r.status, Number(r.count)])); const total = Object.values(counts).reduce((a,b) => a+b, 0)
    const cancelled = counts.cancelled ?? 0; const activeTotal = total - cancelled; const done = counts.done ?? 0
    return { counts, total, done, completion_percent: activeTotal === 0 ? 0 : Math.round(done * 10000 / activeTotal) / 100 }
  }

  createMilestone(input, options = {}) {
    const projectId = requiredString(field(input, 'project_id', 'projectId'), 'project_id'); if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new TaskStoreError('project not found: ' + projectId, 'PROJECT_NOT_FOUND')
    const id = field(input, 'id') === undefined ? randomUUID() : requiredString(field(input, 'id'), 'id'); const timestamp = nowMs(this.clock)
    const status = optionalString(field(input, 'status'), 'status') ?? 'planning'; if (!PROJECT_STATUSES.includes(status)) throw new TypeError('status must be one of: ' + PROJECT_STATUSES.join(', '))
    const exitCriteria = jsonArray(field(input, 'exit_criteria', 'exitCriteria'), 'exit_criteria')
    this._write(db => db.prepare('INSERT INTO milestones (id,project_id,title,description,status,position,due_at,metadata,created_at,updated_at,exit_criteria) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, projectId, requiredString(field(input, 'title', 'name'), 'name'), optionalString(field(input, 'description'), 'description') ?? '', status, nonNegativeInteger(field(input, 'position'), 'position', 0), field(input, 'due_at', 'dueAt') ?? null, jsonText(metadataValue(field(input, 'metadata')), {}, 'metadata'), timestamp, timestamp, jsonText(exitCriteria, [], 'exit_criteria')))
    return this.getMilestone(id)
  }

  getMilestone(id) { const row = this.db.prepare('SELECT * FROM milestones WHERE id = ?').get(requiredString(id, 'id')); return row ? canonicalMilestone(row) : null }
  listMilestones(projectId) { return this.db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY position, created_at, id').all(requiredString(projectId, 'project_id')).map(row => canonicalMilestone(row)) }

  updateProject(id, patch, options = {}) {
    const projectId = requiredString(id, 'id')
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new TypeError('patch must be an object')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      this._requireProjectRow(projectId, db)
      const setters = []
      const params = []
      const changes = {}
      const add = (name, value) => { setters.push(name + ' = ?'); params.push(value); changes[name] = value }
      for (const inputName of ['title', 'name', 'description', 'status', 'workspace', 'repo', 'branch', 'specification', 'roadmap', 'outline', 'metadata', 'objective', 'completion_criteria', 'source_label', 'source_checksum', 'completed_at']) {
        const camel = inputName.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())
        const value = field(patch, inputName, camel)
        if (value === undefined) continue
        if (inputName === 'title' || inputName === 'name') add('title', requiredString(value, inputName))
        else if (inputName === 'description' || inputName === 'status' || inputName === 'workspace' || inputName === 'repo' || inputName === 'branch' || inputName === 'objective' || inputName === 'source_label' || inputName === 'source_checksum') {
          const stringValue = optionalString(value, inputName)
          if (inputName === 'status' && stringValue !== null && !PROJECT_STATUSES.includes(stringValue)) throw new TypeError('status must be one of: ' + PROJECT_STATUSES.join(', '))
          add(inputName, stringValue)
        } else if (inputName === 'completed_at') {
          if (value === null) add(inputName, null)
          else add(inputName, positiveInteger(value, 'completed_at', undefined))
        } else if (inputName === 'specification') add(inputName, jsonText(metadataValue(value), {}, 'specification'))
        else if (inputName === 'roadmap' || inputName === 'outline' || inputName === 'completion_criteria') add(inputName, jsonText(jsonArray(value, inputName), [], inputName))
        else if (inputName === 'metadata') add(inputName, jsonText(metadataValue(value), {}, 'metadata'))
      }
      if (setters.length === 0) return this.getProject(projectId)
      add('updated_at', timestamp)
      params.push(projectId)
      db.prepare('UPDATE projects SET ' + setters.join(', ') + ' WHERE id = ?').run(...params)
      this._appendEvent(projectId, 'project_updated', options.actor, { changes }, db, timestamp)
      return this.getProject(projectId)
    })
  }

  deleteProject(id, options = {}) {
    const projectId = requiredString(id, 'id')
    return this._write(db => {
      this._requireProjectRow(projectId, db)
      this._appendEvent(projectId, 'project_deleted', options.actor, { id: projectId }, db)
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
      return { deleted: true, id: projectId }
    })
  }

  _requireProjectRow(id, db = this.db) {
    const row = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)
    if (!row) throw new TaskStoreError('project not found: ' + id, 'PROJECT_NOT_FOUND')
    return row
  }

  updateMilestone(id, patch, options = {}) {
    const milestoneId = requiredString(id, 'id')
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new TypeError('patch must be an object')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      this._requireMilestoneRow(milestoneId, db)
      const setters = []
      const params = []
      const changes = {}
      const add = (name, value) => { setters.push(name + ' = ?'); params.push(value); changes[name] = value }
      for (const inputName of ['project_id', 'title', 'description', 'status', 'position', 'due_at', 'metadata', 'exit_criteria']) {
        const camel = inputName.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())
        const value = field(patch, inputName, camel)
        if (value === undefined) continue
        if (inputName === 'title') add(inputName, requiredString(value, 'title'))
        else if (inputName === 'description' || inputName === 'status') add(inputName, optionalString(value, inputName))
        else if (inputName === 'project_id') {
          const target = requiredString(value, 'project_id')
          this._requireProjectRow(target, db)
          add(inputName, target)
        } else if (inputName === 'position') add(inputName, nonNegativeInteger(value, 'position', 0))
        else if (inputName === 'due_at') add(inputName, value === null ? null : positiveInteger(value, 'due_at', undefined))
        else if (inputName === 'exit_criteria') add(inputName, jsonText(jsonArray(value, 'exit_criteria'), [], 'exit_criteria'))
        else if (inputName === 'metadata') add(inputName, jsonText(metadataValue(value), {}, 'metadata'))
      }
      if (setters.length === 0) return this.getMilestone(milestoneId)
      add('updated_at', timestamp)
      params.push(milestoneId)
      db.prepare('UPDATE milestones SET ' + setters.join(', ') + ' WHERE id = ?').run(...params)
      this._appendEvent(milestoneId, 'milestone_updated', options.actor, { changes }, db, timestamp)
      return this.getMilestone(milestoneId)
    })
  }

  deleteMilestone(id, options = {}) {
    const milestoneId = requiredString(id, 'id')
    return this._write(db => {
      this._requireMilestoneRow(milestoneId, db)
      this._appendEvent(milestoneId, 'milestone_deleted', options.actor, { id: milestoneId }, db)
      db.prepare('DELETE FROM milestones WHERE id = ?').run(milestoneId)
      return { deleted: true, id: milestoneId }
    })
  }

  _requireMilestoneRow(id, db = this.db) {
    const row = db.prepare('SELECT 1 FROM milestones WHERE id = ?').get(id)
    if (!row) throw new TaskStoreError('milestone not found: ' + id, 'MILESTONE_NOT_FOUND')
    return row
  }

  _validateLinkType(linkType) {
    const normalized = requiredString(linkType, 'link_type')
    if (!TASK_LINK_TYPES.includes(normalized)) throw new TypeError('link_type must be one of: ' + TASK_LINK_TYPES.join(', '))
    return normalized
  }

  addTaskLink(taskId, linkedTaskId, linkType, options = {}) {
    const id = requiredString(taskId, 'task_id')
    const linked = requiredString(linkedTaskId, 'linked_task_id')
    const type = this._validateLinkType(linkType)
    if (id === linked) throw new TaskStoreError('a task cannot link to itself', 'TASK_LINK_CYCLE')
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      this._requireRow(id, db)
      this._requireRow(linked, db)
      const existing = db.prepare('SELECT 1 FROM task_links WHERE task_id = ? AND linked_task_id = ? AND link_type = ?').get(id, linked, type)
      if (existing !== undefined) return { added: false, link: { task_id: id, linked_task_id: linked, link_type: type, created_at: timestamp }, task: this._hydrate(this._requireRow(id, db), db) }
      db.prepare('INSERT INTO task_links(task_id, linked_task_id, link_type, created_at) VALUES (?, ?, ?, ?)').run(id, linked, type, timestamp)
      this._appendEvent(id, 'task_link_added', options.actor, { linked_task_id: linked, link_type: type }, db, timestamp)
      return { added: true, link: { task_id: id, linked_task_id: linked, link_type: type, created_at: timestamp }, task: this._hydrate(this._requireRow(id, db), db) }
    })
  }

  removeTaskLink(taskId, linkedTaskId, linkType, options = {}) {
    const id = requiredString(taskId, 'task_id')
    const linked = requiredString(linkedTaskId, 'linked_task_id')
    const type = this._validateLinkType(linkType)
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      this._requireRow(id, db)
      const result = db.prepare('DELETE FROM task_links WHERE task_id = ? AND linked_task_id = ? AND link_type = ?').run(id, linked, type)
      const removed = Number(result.changes) === 1
      if (removed) this._appendEvent(id, 'task_link_removed', options.actor, { linked_task_id: linked, link_type: type }, db, timestamp)
      return { removed, task: this._hydrate(this._requireRow(id, db), db) }
    })
  }

  listTaskLinks(taskId, options = {}) {
    const id = requiredString(taskId, 'task_id')
    this._requireRow(id)
    const clauses = ['task_id = ?']
    const params = [id]
    if (options.link_type !== undefined || options.linkType !== undefined) {
      const type = this._validateLinkType(options.link_type ?? options.linkType)
      clauses.push('link_type = ?')
      params.push(type)
    }
    return this.db.prepare('SELECT task_id, linked_task_id, link_type, created_at FROM task_links WHERE ' + clauses.join(' AND ') + ' ORDER BY created_at, link_type, linked_task_id').all(...params).map(row => ({ task_id: row.task_id, linked_task_id: row.linked_task_id, link_type: row.link_type, created_at: Number(row.created_at) }))
  }

  setCriterionResults(taskId, criterionResults, options = {}) {
    const id = requiredString(taskId, 'task_id')
    const normalized = normalizeCriterionResults(criterionResults)
    const timestamp = nowMs(this.clock)
    return this._write(db => {
      this._requireRow(id, db)
      db.prepare('UPDATE tasks SET criterion_results = ?, updated_at = ? WHERE id = ?').run(jsonText(normalized, [], 'criterion_results'), timestamp, id)
      this._appendEvent(id, 'criterion_results_updated', options.actor, { criterion_results: normalized }, db, timestamp)
      return this._hydrate(this._requireRow(id, db), db)
    })
  }

  addChild(parentId, input, options = {}) {
    const parent = requiredString(parentId, 'parent_id')
    this._requireRow(parent)
    return this.create({ ...input, parent_id: parent }, options)
  }

  listChildren(parentId, options = {}) {
    const parent = requiredString(parentId, 'parent_id')
    if (options.descendants === true) return this.listDescendants(parent)
    const rows = this.db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at, id').all(parent)
    return rows.map(row => this._hydrate(row))
  }

  listDescendants(parentId) {
    const parent = requiredString(parentId, 'parent_id')
    const rows = this.db.prepare(String.raw`
      WITH RECURSIVE descendants(id, depth) AS (
        SELECT id, 1 FROM tasks WHERE parent_id = ?
        UNION ALL
        SELECT child.id, descendants.depth + 1 FROM tasks child JOIN descendants ON child.parent_id = descendants.id
      )
      SELECT tasks.* FROM tasks JOIN descendants ON descendants.id = tasks.id ORDER BY descendants.depth, tasks.created_at, tasks.id
    `).all(parent)
    return rows.map(row => this._hydrate(row))
  }

  events(taskId, options = {}) {
    const id = requiredString(taskId, 'task_id')
    const clauses = ['task_id = ?']
    const params = [id]
    if (options.before_id !== undefined || options.beforeId !== undefined) {
      clauses.push('id < ?')
      params.push(positiveInteger(options.before_id ?? options.beforeId, 'before_id', undefined))
    }
    const limit = Math.min(500, positiveInteger(options.limit, 'limit', 100))
    params.push(limit)
    const rows = this.db.prepare('SELECT id, task_id, event_type, timestamp, actor, payload FROM task_events WHERE ' + clauses.join(' AND ') + ' ORDER BY id DESC LIMIT ?').all(...params)
    return rows.map(row => ({ id: Number(row.id), task_id: row.task_id, event_type: row.event_type, timestamp: Number(row.timestamp), actor: row.actor, payload: parseJson(row.payload, {}) }))
  }
}


export function createTaskStore(options = {}) {
  return new TaskStore(options)
}
