# dsh-engineering-control

Monorepo for the DSH (DeepSeek Harness) engineering-control plugins.

## Packages

| Package | Name | Role |
|---|---|---|
| `packages/task-orchestrator` | `dsh-task-orchestrator` | Authoritative task control plane: projects, milestones, tasks, dependencies, claims/leases, worker routing and dispatch, task lifecycle, dashboard. |
| `packages/change-control` | `dsh-change-control` | Authoritative governance plane: Change lifecycle, plans, role bindings, proof bundles, deterministic preflight, review findings, repair cycles, risk/escalation policy, tool enforcement, Change audit history. |
| `packages/task-change-control` | `dsh-task-change-control` | Integration package (added in Phase 3): task ↔ Change linkage, bootstrap/resume, lifecycle synchronization, worker-session role binding, governed completion, reviewer routing coordination, dashboard Change projection. Absent = both domain plugins behave standalone. |

## Architecture rules

- The two domain packages never import each other's store implementations. All cross-package communication flows through Cordis services: `ctx.taskOrchestrator`, `ctx.changeControl`, `ctx.taskChangeControl`.
- Task persistence (SQLite, Task Orchestrator) and Change persistence (file-backed JSON, Change Control) remain separate.
- There is exactly one dashboard, owned by Task Orchestrator.

## Repository commands

All commands run from the repository root and delegate to packages via `pnpm -r --if-present`:

```sh
pnpm install     # install all workspace dependencies
pnpm build       # build every package (task-orchestrator builds lib/ + client bundle)
pnpm test        # run every package's test suite
pnpm typecheck   # run every package's typecheck (change-control: tsc --checkJs)
```

Per-package scripts can also be run directly, e.g.
`pnpm --filter dsh-task-orchestrator test`.

## Host-provided runtime dependencies

`@deepseek-ai/dsh-tools` is a **peer dependency** of every plugin package
(host provides `defineTool`, tool registration, and the `tools/pre-execute`
event contract). The demonstrated common range is `>=0.1.0-rc.7 <0.2.0-0`,
validated against published artifacts 0.1.0-rc.7 / 0.1.0-rc.8 / 0.1.1-rc.2,
whose built `lib/` output is byte-identical for the APIs used (`defineTool`,
`ToolRuntime`). The root pins `@deepseek-ai/dsh-tools@0.1.1-rc.2` as a
devDependency so package test suites exercise a demonstrated artifact.

## Phases

The consolidation is executed in dependency-gated phases; see the
`dsh-engineering-control — Monorepo Consolidation` project on the DSH task
board (Tasks → Outline) for tickets and acceptance criteria.
