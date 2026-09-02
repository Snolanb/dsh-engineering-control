# Implementation plan

1. Build a framework-free SQLite task store on Node's built-in node:sqlite API, with versioned migrations, JSON fields for arrays/metadata, normalized dependencies, and append-only events.
2. Keep lifecycle operations transactional and explicit: validate known statuses and obvious transitions, use BEGIN IMMEDIATE for claims/leases, and expose dependency readiness separately from explicit blocked status.
3. Add a thin DSH host plugin that provides a taskOrchestrator capability, registers stable task_* tools, and mounts loopback-only JSON HTTP routes when webServer is present.
4. Add Node test-runner coverage against temporary databases for CRUD, transitions, claims/leases, dependencies, hierarchy, results, events, persistence, and migration upgrade behavior.
5. Document installation, configuration, schema, tools/routes, manager/worker flows, dispatcher queries, and the future kanban integration seam; run tests/build checks and commit only this repository.

## Worker dispatch extension

The detailed model/profile routing and worker-spawning design is persisted in [docs/WORKER-DISPATCH-PLAN.md](docs/WORKER-DISPATCH-PLAN.md). It defines the worker-spec registry, Ornith headless profile, MiniMax and Luna session tiers, provider preflight, lease-aware dispatch lifecycle, monitoring, failure policy, security boundaries, tests, and phased rollout.

The repository now includes the worker registry, provider/workspace preflight, headless and session-backed launchers, lease-aware dispatcher, and tests on the feature/worker-dispatch branch. Autonomous scheduling, production profile installation, and durable run records remain future rollout work.
