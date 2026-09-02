# Worker Dispatch and Model Routing Plan

## Status

This document records the design and implementation status for dispatching task-board work to workers with different DSH compositions, plugins, models, reasoning budgets, and workspace policies. The validated registry, preflight, lease-aware process dispatcher, and session-backed model launcher are implemented on feature/worker-dispatch; autonomous scheduling and durable run persistence remain planned.

## Goals

1. Route a ready task to a named worker specification such as ornith-filemount, minimax-standard, or luna-max.
2. Give each worker the exact plugin and tool composition it needs.
3. Select the provider, model, and reasoning effort independently from the composition.
4. Run the worker in the task's authorized workspace with bounded time, concurrency, and lease ownership.
5. Record enough information to recover, retry, review, and audit every dispatch.
6. Avoid consuming task attempts when a provider, model, profile, or workspace is unavailable before work begins.

## Non-goals

- Do not modify the managed kanban plugin.
- Do not allow arbitrary task text to choose an executable command or escape the workspace allowlist.
- Do not silently fall back from a requested model to a more expensive or differently capable model.
- Do not require GitHub Issues or pull requests for ordinary local task execution.
- Do not make the worker responsible for authoritative task lifecycle state when the dispatcher can own it.

## Current baseline

The task-orchestrator already provides the important control-plane primitives:

- Tasks have workspace, repo, branch, worker_profile, worker_model, acceptance criteria, attempts, and structured result fields.
- task_list({ ready_to_run: true, worker_profile }) is the intended ready queue.
- task_claim provides an atomic worker lease.
- task_start records an execution attempt.
- task_renew_lease, task_release, task_complete, and task_fail provide the worker lifecycle.
- Dependencies and parent/child relationships are already persisted and checked.
- Audit events are append-only and survive restarts.

The task plugin now has a dispatcher implementation for headless processes and host sessions, but it does not yet provide an autonomous polling scheduler, durable dispatch-run table, or multi-host coordination. The implementation builds on the existing lifecycle instead of replacing it.

## Implemented slice on feature/worker-dispatch

- WorkerSpecRegistry validates named profiles, modes, plugin labels, model tuples, limits, and workspace policies.
- preflightWorker checks task workspaces, profile or preset availability, launchers, provider/model catalogs, and reasoning efforts without claiming a task.
- WorkerDispatcher performs preflight, atomic claim, launch, start, lease renewal, timeout handling, completion, failure, and launch-failure release.
- createHeadlessProcessLauncher uses structured, non-shell DSH arguments and bounded stdout/stderr capture.
- createSessionLauncher creates a blank host session, selects the validated provider/model/reasoning tuple before prompting, and polls session history for terminal turn events.
- createWorkerLauncher selects the headless or session path from the worker mode; session RPC failures and terminal model errors are surfaced as worker failures.
- The task service exposes worker specifications, resolution, preflight, and dispatcher construction; loopback routes expose worker listing and preflight diagnostics.
- Tests cover normalization, routing, workspace/model failures, claim/start/complete/fail, launch failure, prompt construction, session selection, completion, and terminal errors.

Still pending are installing the Ornith profile into the active DSH_HOME, autonomous polling, durable run records, and live provider smoke tests for the session tiers.

## Two independent routing dimensions

### 1. Composition: what the worker can see and do

A DSH profile or agent preset determines the tool schemas, plugin rows, prompt sections, file-mount behavior, and other runtime capabilities. This is the security and capability boundary.

- The planned Ornith worker composition includes file-mount and small-model-guard.
- A standard worker can use the standard DSH tool composition.
- A specialized worker can add or remove plugins without changing the task record format.

DSH's agent-preset design treats composition as a per-agent concern. A session created with a preset records that choice, and a blank session may select a different preset before its first prompt. Composition is separate from model selection.

### 2. Model: which provider answers

A model selection must be represented as a tuple, not only a model name:

~~~json
{
  "provider": "minimax-cn",
  "model": "MiniMax-M3",
  "reasoningEffort": "high"
}
~~~

The live Web host currently advertises these relevant routes:

| Tier | Provider | Model | Suggested effort |
|---|---|---|---|
| Small bounded work | ollama | ornith-1.5:9b | low |
| General implementation | minimax-cn | MiniMax-M3 | high |
| Difficult reasoning | openai-codex | gpt-5.6-luna | max |

The provider is important: the live catalog contains the Luna model under more than one route, and MiniMax is exposed as minimax-cn. A dispatcher must not infer a provider from a model string.

## Worker-spec registry

Add a validated registry owned by the dispatcher. It may start as plugin configuration and later move to a dedicated settings section.

~~~yaml
workers:
  ornith-filemount:
    mode: headless-profile
    profile: ornith-filemount-worker
    provider: ollama
    model: ornith-1.5:9b
    reasoningEffort: low
    maxConcurrency: 1
    timeoutMs: 900000
    leaseSeconds: 1800
    workspacePolicy: project-only

  minimax-standard:
    mode: session
    agentPreset: standard
    provider: minimax-cn
    model: MiniMax-M3
    reasoningEffort: high
    maxConcurrency: 2
    timeoutMs: 1800000
    leaseSeconds: 3600
    workspacePolicy: project-only

  luna-max:
    mode: session
    agentPreset: standard
    provider: openai-codex
    model: gpt-5.6-luna
    reasoningEffort: max
    maxConcurrency: 1
    timeoutMs: 3600000
    leaseSeconds: 3600
    workspacePolicy: project-only
~~~

The task's worker_profile selects a registry entry. The existing worker_model field can remain an optional explicit override, but overrides must be validated against an allowlist. A later schema revision can add structured worker_provider and worker_reasoning_effort fields if task-level overrides become necessary.

## Recommended execution architecture

### Phase A: process-per-task headless workers

This is the recommended first implementation for exact CLI profiles and strong isolation.

1. Create a dedicated headless profile for each CLI-style worker. The current ornith-filemount profile is a Web profile; create a separate ornith-filemount-worker profile based on @deepseek-ai/dsh-headless.
2. Preserve the file-mount and small-model-guard bundle rows.
3. Add the provider adapter and model-default row required by the selected model.
4. Run one task and exit. The DSH headless bundle is designed to accept one task string, create one Agent, wait for quiescence, print the final response, and exit.
5. Let the dispatcher—not the worker—own claim, lease, completion, and failure reporting.

A worker prompt should contain the task ID, title, description, workspace, acceptance criteria, and restrictions. The worker only needs file/tool capabilities; it does not need unrestricted access to the task database.

### Phase B: session-backed workers

Use the DSH host API for standard, MiniMax, and Luna workers when a shared host is desirable:

1. Call session.create with the task workspace and selected agent preset.
2. Before the first prompt, call session.selectModel with provider, model, and reasoning effort.
3. Call session.prompt with the task envelope.
4. Monitor session events and process/session health.
5. Complete or fail the board task from the dispatcher.

This avoids launching a process per task, but requires every worker composition to exist as a valid agent preset and every provider to be registered in the host serving that session.

### Phase C: long-lived worker pools

Only after the first two phases are stable, consider one long-lived process per worker specification. A pool can reduce startup cost, but it needs strict session reset, workspace isolation, cancellation, memory, and model-state controls. It should not be the first implementation.

## Dispatcher lifecycle

The dispatcher should implement this sequence.

### 1. Select

Poll:

~~~js
task_list({ ready_to_run: true, worker_profile: workerSpecName })
~~~

Filter again in memory against the worker registry. Reject unknown profiles before claiming.

### 2. Preflight

Before consuming a task attempt:

- Confirm the worker specification exists and is enabled.
- Confirm the workspace exists, is allowed by policy, and is not already owned by a conflicting run.
- Confirm the profile or preset composition can be resolved.
- Confirm the provider is active and the model appears in its catalog, or run an explicit provider probe.
- Confirm concurrency capacity.
- Confirm the launcher executable and required profile files are present.

If preflight fails, leave the task in ready and record a non-attempting dispatch diagnostic. Do not silently choose another model.

### 3. Admit and claim

After preflight succeeds, claim atomically with a stable run-specific worker identity, for example:

~~~text
worker = ornith-filemount:<dispatch-run-id>
~~~

If another dispatcher wins the race, discard the candidate without launching it. Start the task only after the worker process or session has been admitted successfully, so an unavailable model does not consume an attempt.

### 4. Launch

The launcher supplies:

- task ID and run ID
- workspace path
- profile or preset name
- provider, model, and reasoning selection
- task description and acceptance criteria
- timeouts and output locations

The launcher must use an allowlisted command template. Never interpolate an arbitrary task field into a shell command without structured argument passing.

### 5. Monitor

While the worker runs:

- Renew the task lease before expiry.
- Track PID or session ID, profile, provider, model, reasoning effort, workspace, start time, and last heartbeat.
- Capture bounded stdout and stderr and structured worker events.
- Detect process exit, session cancellation, model errors, workspace violations, and timeout.
- Stop and clean up the worker on cancellation or lease loss.

### 6. Resolve

On success, call task_complete with the same worker identity and only verified fields: result summary, files changed, tests run, commit SHA if one exists, and remaining blockers.

On a worker error, call task_fail with a concrete error and retry classification. A provider-unavailable preflight should return the task to ready without incrementing attempts; a failure after task_start may consume an attempt according to the configured policy.

## Profile requirements

### Ornith small worker

The current ornith-filemount profile has the desired file-mount and small-model-guard plugins and configures ollama / ornith-1.5:9b, but it is composed with the Web app. It should not be used as the automated one-shot worker directly.

Create ornith-filemount-worker with:

- @deepseek-ai/dsh-headless instead of the Web app bundle
- file-mount
- small-model-guard
- the Ollama/provider adapter and settings required by the runtime
- agent-default-model set to ollama / ornith-1.5:9b
- explicit workspace-write policy appropriate for the worker

The repository template is profiles/ornith-filemount-worker. Its Ollama route uses the OpenAI-compatible protocol at the local /v1 endpoint and reads OLLAMA_API_KEY from the environment; the local Ollama compatibility key can be the non-secret value ollama. A bounded READY smoke test now succeeds through dsh-headless with file-mount and small-model-guard loaded.

The earlier experiment demonstrated why this preflight matters: the isolated profile initially had no active Ollama adapter, then failed on missing protocol and credential configuration before these profile fixes.

### MiniMax standard worker

Use the standard DSH composition with:

- provider minimax-cn
- model MiniMax-M3
- a high reasoning effort for implementation work
- a larger timeout and lease than the small worker

### Luna reasoning worker

Use the standard or a deliberately expanded composition with:

- provider openai-codex
- model gpt-5.6-luna
- reasoning effort max
- strict concurrency and cost controls

The provider and model must be configurable; do not hard-code the model into task logic.

## Task prompt contract

The dispatcher should generate a deterministic worker prompt from the task record:

1. Role: named worker specification and run ID.
2. Workspace: absolute, validated path.
3. Task ID and title.
4. Description.
5. Acceptance criteria in order.
6. Known dependencies and parent context.
7. Restrictions: no unrelated files, no GitHub Issue or PR unless requested, no remote deployment.
8. Required test command.
9. Completion protocol owned by the dispatcher.

The prompt should not include secrets, provider API keys, or the full task database.

## Observability and persistence

Add a dispatch-run record or equivalent append-only events. At minimum capture:

- dispatch run ID
- task ID
- worker specification
- profile or preset
- provider, model, reasoning effort
- workspace
- process PID or session ID
- claimed, started, heartbeat, and completed timestamps
- exit code or terminal error
- retry classification
- bounded log or artifact references

The task event stream remains the user-facing audit trail. A separate run table is preferable once multiple attempts and concurrent workers exist, because one task can have several distinct process or session runs.

## Failure policy

| Failure | Task action | Attempt consumed? |
|---|---|---:|
| Unknown worker spec | Keep ready; operator diagnostic | No |
| Missing profile or preset | Keep ready or explicit blocked state | No |
| Provider/model unavailable during preflight | Keep ready; retry after configuration change | No |
| Claim race lost | Discard candidate | No |
| Launch fails after claim | Release lease; record dispatch error | No |
| Worker crashes after start | Fail or retry according to policy | Yes |
| Lease expires | Recover as expired claim | Depends on recovery policy |
| Tests fail | Complete to in_review or fail with test output | Yes |
| Worker succeeds but report is malformed | Keep in_review or fail for manual inspection | Yes |

## Security and workspace policy

- Worker specs and executable paths are administrator-controlled configuration.
- Tasks may select only named worker specs, never arbitrary commands.
- Workspace paths must be checked against approved project roots.
- A worker should receive only the plugins needed for its tier.
- Keep task APIs loopback-only; do not expose the dispatcher control plane remotely.
- Scrub API keys and credentials from logs and task result fields.
- Enforce per-worker concurrency, timeout, output-size, and cancellation limits.

## Test plan

### Unit tests

- Worker-spec schema validation and unknown-profile rejection.
- Model tuple validation and reasoning-effort validation.
- Workspace allowlist checks.
- Prompt-envelope construction.
- Retry classification.
- No attempt increment on preflight failure.

### Dispatcher integration tests

- Ready-task selection by worker profile.
- Atomic claim race between two dispatcher instances.
- Successful process launch, lease renewal, structured completion, and cleanup.
- Provider-unavailable preflight leaves task ready.
- Process crash produces failure and captured diagnostics.
- Timeout cancels the worker and records the run.
- Expired lease recovery does not duplicate active work.

### Profile smoke tests

- Ornith headless profile starts with file-mount and guard plugins.
- Ollama provider probe succeeds for ornith-1.5:9b.
- MiniMax M3 session is created and selected with minimax-cn.
- Luna session is created with openai-codex and max reasoning.
- Each worker can modify only its assigned workspace.

## Rollout phases

### Phase 0 — documented baseline

The task lifecycle, worker registry, preflight API, and initial process dispatcher are implemented and tested. Autonomous scheduling and production worker profiles are not enabled yet.

### Phase 1 — registry and preflight

Implemented: add validated worker-spec configuration, provider/model preflight, workspace policy, and dry-run diagnostics. Remaining work is configuration loading and operator-facing diagnostics.

### Phase 2 — Ornith headless worker

The dedicated headless profile template and Ollama adapter configuration are implemented and pass a bounded no-op smoke test. Remaining work is installing the profile into the active DSH_HOME and running a real task through the dispatcher process launcher.

### Phase 3 — lifecycle dispatcher

Implemented: claim, start, lease, monitor, complete, fail, launch-failure release, timeout handling, and integration tests. Remaining work is durable run records, autonomous polling, and production cleanup supervision.

### Phase 4 — session-backed model tiers

Implemented generic session-backed launching through session.create, session.selectModel, session.prompt, and history polling. MiniMax and Luna selections are passed from validated worker specs; tests cover model selection, completion, and terminal errors. Live provider smoke tests remain deployment-specific.

### Phase 5 — worker pools and operations

Only if startup cost justifies it, add long-lived worker pools, concurrency controls, cancellation UI, operator diagnostics, and queue metrics.

## Definition of done

The system is ready for general use when:

1. A task with worker_profile=ornith-filemount launches the intended headless composition, uses file-mount and small-model-guard, and selects Ollama ornith-1.5:9b.
2. A standard task can route to MiniMax M3 without changing its plugin composition accidentally.
3. A difficult task can route to Luna with max reasoning.
4. Each dispatch is preflighted, leased, monitored, auditable, and cleaned up.
5. Model/provider failures do not falsely mark work as started.
6. Automated tests cover races, retries, provider failures, process failures, and successful completion.

## References

- Local task lifecycle: src/store.js, src/tools.js, and the dispatcher section of README.md.
- DSH model default service: @deepseek-ai/dsh-agent-default-model.
- DSH one-shot execution: @deepseek-ai/dsh-headless.
- DSH agent preset design: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/README.md
- DSH session preset behavior: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-presets/src/session.ts
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility
