# DSH Task Orchestrator

A small local task control plane for multi-agent software-engineering work. It keeps the durable task ledger separate from any kanban UI, dispatcher, worker, or reviewer.

## Purpose and architecture

The host plugin owns one SQLite database:

    dsh agent / Sol manager -> taskOrchestrator service and task_* tools -> SQLite task store
                                                                  |-> future kanban UI
                                                                  |-> worker registry, preflight, and dispatcher
                                                                  \-> Sol review

The database is authoritative. Mutations create append-only task events. The task store itself does not call an LLM or GitHub; the optional dispatcher can launch an allowlisted worker process after provider, profile, and workspace preflight.

## Installation

From this repository:

    pnpm install
    pnpm run build
    pnpm test

For a local DSH profile, link the package using the normal DSH plugin command:

    dsh plugin --profile web add link:/Users/you/Project/dsh-task-management-plugin

The package manifest includes cordis.patch.yml, which adds the host plugin and standalone browser board to a profile bundle. The plugin requires Node >= 22.5 because it uses node:sqlite. The DSH profile needs the standard tools and webServer services. Restart the managed DSH Web process after changing profile dependencies so the new client bundle enters the boot manifest.

## Configuration

The configuration is intentionally small:

    dbPath: ~/.dsh/task-orchestrator/tasks.db
    defaultLeaseSeconds: 1800
    maxAttemptsDefault: 3
    enabled: true

If dbPath is omitted, $DSH_HOME/task-orchestrator/tasks.db is used when DSH_HOME is set; otherwise ~/.dsh/task-orchestrator/tasks.db is used. Parent directories are created with mode 0700. maxAttemptsDefault: 0 means unlimited attempts; a task max_attempts overrides it.

Worker routing is configured with named workerSpecs and approved workspaceRoots. Each spec selects either a headless profile or an agent preset and an explicit provider/model/reasoning tuple. See docs/WORKER-DISPATCH-PLAN.md for the full registry schema and rollout plan.

    workerSpecs:
      ornith-filemount:
        mode: headless-profile
        profile: ornith-filemount-worker
        provider: ollama
        model: ornith-1.5:9b
        reasoningEffort: low
        workspacePolicy: project-only
    workspaceRoots:
      - /Users/you/Project

## Data model and schema

Tasks contain id, title, description, status, priority, parent_id, workspace, repo, branch, worker_profile, worker_model, reviewer_profile, reviewer_model, ordered acceptance_criteria, task_type, attempts, max_attempts, lease ownership and timestamps, GitHub repo and issue linkage, lifecycle timestamps, structured result fields, and arbitrary metadata.

Arrays and metadata are stored as JSON in the task row. Dependencies are normalized in task_dependencies. The returned dependencies field contains all direct prerequisites; blocked_by contains only prerequisites whose status is not done. A cancelled or failed prerequisite therefore remains a dependency blocker until a manager changes its state or removes the dependency.

SQLite tables:

- tasks: durable task records.
- task_dependencies: directed prerequisite edges with cycle checks.
- task_events: append-only audit records with integer id, task id, event type, timestamp, actor, and JSON payload.
- schema_migrations: applied migration timestamps; SQLite user_version is advanced by migrations.

Schema version 2 adds dispatcher-oriented indexes. New databases migrate automatically. A database with a newer version is rejected rather than silently modified.

## State model

The supported normal flow is:

    backlog -> planning -> ready -> claimed -> running -> in_review -> done

Review changes use:

    in_review -> changes_requested -> ready

blocked, failed, and cancelled are available where appropriate. Known obvious invalid transitions are rejected. Unknown non-empty states are allowed to and from so a later plugin can extend the lifecycle without a schema rewrite. Dependency blocking is reported separately from explicit blocked status.

## Programmatic service API

The host provides a Cordis capability named taskOrchestrator. It exposes create, get, list, update, delete, claim, release, renewLease, start, complete, fail, block, unblock, requestChanges, addDependency, removeDependency, addChild, listChildren, listDescendants, readyToRun, blockedByDependencies, events, subscribe, workerSpecs, getWorkerSpec, resolveWorkerSpec, preflightWorker, and createDispatcher. The dispatcher supports headless CLI profiles and session-backed presets; session workers select provider/model/reasoning before prompting and poll durable session history for completion. The store property is also available for callers that need the complete object.

Claims use SQLite BEGIN IMMEDIATE, so two processes cannot both win a claim. A lease records claimed_by, claimed_at, and lease_expires_at. Start, release, renew, complete, fail, and worker blocking require the recorded worker and an unexpired lease; an expired worker must let another worker reclaim the task. A worker should renew before expiry or release explicitly.

Worker completion deliberately enters in_review, not done. completed_at is reserved for terminal done, failed, or cancelled outcomes; a changes-requested retry clears attempt timestamps. A manager or reviewer then marks it done or calls requestChanges.

## DSH tools

Stable tool names use the normal underscore convention:

- CRUD: task_create, task_get, task_list, task_update, task_delete.
- Lifecycle: task_claim, task_release, task_renew_lease, task_start, task_complete, task_fail, task_block, task_unblock, task_request_changes.
- Structure: task_add_dependency, task_remove_dependency, task_add_child, task_list_children, task_list_descendants.
- Queries and history: task_ready_to_run, task_blocked_by_dependencies, task_events.

Tools return JSON-native records. Acceptance criteria and structured result fields are directly readable by workers.

## HTTP API for a future web UI

When DSH's loopback webServer is present, the host registers the loopback-only prefix /api/task-orchestrator. Requests use the same field names as task records.

- GET /api/task-orchestrator/tasks?status=ready lists tasks. Filters include parent_id, worker_profile, ready_to_run=true, expired_claims=true, and in_review=true.
- POST /api/task-orchestrator/tasks creates a task.
- GET, PATCH, or DELETE /api/task-orchestrator/tasks/:id retrieves, mutates, or deletes a task.
- POST /api/task-orchestrator/tasks/:id/claim, /release, /renew-lease, /start, /complete, /fail, /block, /unblock, and /request-changes perform lifecycle actions.
- GET /api/task-orchestrator/tasks/:id/events returns event history.
- GET /api/task-orchestrator/tasks/:id/children?descendants=true returns hierarchy; POST to the same path creates a child.
- POST or DELETE /api/task-orchestrator/tasks/:id/dependencies mutates dependencies; POST takes depends_on_task_id.
- GET /api/task-orchestrator/dispatcher/ready, /expired-claims, and /in-review provide dispatcher-friendly queries.
- GET /api/task-orchestrator/dispatcher/workers lists configured worker specs.
- POST /api/task-orchestrator/dispatcher/preflight checks a worker profile, workspace, composition, launcher, provider, model, and reasoning effort without claiming the task.

Example calls:

    curl 'http://127.0.0.1:3080/api/task-orchestrator/tasks?ready_to_run=true'
    curl -X POST 'http://127.0.0.1:3080/api/task-orchestrator/tasks' -H 'content-type: application/json' -d '{"title":"Implement parser","status":"ready","worker_profile":"ornith","acceptance_criteria":["tests pass"]}'
    curl -X POST 'http://127.0.0.1:3080/api/task-orchestrator/tasks/TASK_ID/claim' -H 'content-type: application/json' -d '{"worker":"ornith-1","lease_seconds":1800}'

The managed kanban frontend could replace its local task ledger by using these routes: load tasks, render each returned status, use PATCH for manager moves, use action routes for worker leases, and use dependencies, children, and events for detail panels. This package instead ships an isolated standalone board and does not modify that managed frontend.

## Standalone browser board

This package also ships its own independent browser face. It does not modify or import the managed kanban plugin. When the package is loaded in a DSH web profile, it adds a small Tasks launcher button and a floating board panel.

The board displays all eleven lifecycle columns, refreshes from the orchestration API, supports task creation, status moves, worker id and profile filtering, claim/start/release/renew actions, structured completion into in_review, review changes, dependency inspection and event history. It is intentionally plain DOM/CSS with no React or UI-package dependency, so it remains isolated from other board implementations.

The browser client is exported as ./client and the reusable request wrapper as ./client-api. The build uses tsdown to bundle the browser source and emits the DSH `window.__ModuleLoader__.load` factory format under the package identity dsh-task-orchestrator; local dependencies are bundled, so the artifact has no unresolved browser ESM imports. Its only server dependency is the loopback /api/task-orchestrator HTTP prefix. If the API is unavailable, the board reports the error without affecting the DSH shell.

## Example manager workflow

1. Create a parent task linked to github_repo and github_issue.
2. Create child tasks with task_add_child.
3. Add prerequisite edges with task_add_dependency.
4. Move an implementation child to ready with task_update.
5. Inspect task_list or the dispatcher ready endpoint.
6. Review the worker result in in_review; mark done or request changes, then move it back to ready.

## Example worker workflow

1. Query task_list with ready_to_run and its worker_profile.
2. Call task_claim with a stable worker id.
3. Call task_start, renew the lease during long work, and work in the pinned workspace and branch.
4. Call task_complete with only the structured fields known: summary, commit SHA, files, tests, and remaining blockers.
5. If work cannot proceed, call task_block or task_fail rather than hiding the state in prose.

## Dispatcher seam and limitations

A dispatcher should poll task_list({ ready_to_run: true, worker_profile }) or GET /dispatcher/ready, claim atomically, and treat a false claim result as a normal race. It can poll expired claims for recovery and in-review tasks for Sol review. subscribe is an in-process notification hook; the reliable cross-restart interface remains SQLite plus the query/API endpoints. The detailed worker-spec, profile/model routing, preflight, monitoring, and rollout design is documented in [docs/WORKER-DISPATCH-PLAN.md](docs/WORKER-DISPATCH-PLAN.md).

This version intentionally does not implement GitHub synchronization, autonomous scheduling, chat, RBAC, cloud storage, or multi-host coordination. The worker registry, preflight, lease-aware process dispatcher, and session-backed model launcher are implemented; autonomous scheduling and production profile installation remain planned. GitHub linkage is storage only, and the HTTP surface is loopback-only with no remote authentication layer.

## Verification

Exact commands for this repository:

    pnpm run build
    pnpm test

The test suite covers CRUD, lifecycle transitions, atomic and double claims, lease renewal and expiry, dependency blocking and removal, dependency cycles, parent and child relationships, structured results, audit history, persistence, and schema migration upgrade behavior.
