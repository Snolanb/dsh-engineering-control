/**
 * M1-S3-R2 — trusted governed handoff producer.
 *
 * Host-only producer that emits the existing `task-change-control/handoff-requested`
 * consumer seam (the PR #35 consumer + service.handoffGovernedDispatch remain the
 * ONLY release/dispatch path). This module owns eligibility/reconciliation only.
 *
 * Identity invariant: the authenticated session S comes exclusively from the
 * trusted R1 controller boundary (`exec.agent.id`). It is kept in activation
 * memory only — `restart()`/`dispose()` clears it. No S, no emission. The
 * producer never derives S from task.claimed_by, planner bindings, captain /
 * AgentTeams metadata, model payload, or persisted state.
 *
 * Wakeups (startup reconciliation after arming, taskOrchestrator.subscribe
 * notifications, `change-control/linkage-created` notifications) are
 * CANDIDATE HINTS only. Every candidate — including no-payload task
 * notifications — triggers a fresh authoritative read: `orch.get(id)` then
 * canonical `cc.findByWorkItem(WORK_ITEM_SYSTEM, id)` and `cc.status(change.id)`.
 * Event payloads may carry a taskId as a hint, but the payload is never
 * trusted for identity or eligibility: each candidate is fresh-read before
 * emission.
 *
 * Eligibility requires: task `status === 'ready'`, `ready_to_run === true`,
 * no active worker claim/execution (`claimed_by === null`,
 * `claimed_at === null`, `lease_expires_at === null`), canonical nonterminal
 * linkage (`change.workItem` present, `change.workItem.system === 'dsh-task-orchestrator'`,
 * `change.workItem.id === taskId`, and `change.id` is a nonblank string) —
 * missing workItem, wrong system, wrong id, or blank Change ID fail closed,
 * Change `state === 'READY'`, a current
 * accepted plan (`acceptedPlan` object with a nonblank `id`), and a
 * resolvable nonblank string `worker_profile` from the fresh task,
 * confirmed by `orch.resolveWorkerSpec` (authoritative public registry
 * resolution — unknown, disabled, name-mismatched, or model-mismatched
 * profiles fail closed; the resolver must be available for any emission to
 * occur; the resolved name is the only profile value emitted).
 *
 * The producer never calls Task Orchestrator `release`, the dispatcher, or
 * `handoffGovernedDispatch` directly. It emits one event and stops.
 */

export const R2_HANDOFF_EVENT = 'task-change-control/handoff-requested';
const WORK_ITEM_SYSTEM = 'dsh-task-orchestrator';

/**
 * @typedef {object} R2Task
 * @property {string} [id]
 * @property {string} [status]
 * @property {boolean} [ready_to_run]
 * @property {string | null} [claimed_by]
 * @property {number | string | null} [claimed_at]
 * @property {number | string | null} [lease_expires_at]
 * @property {string} [worker_profile]
 * @property {string} [worker_model]
 */

/**
 * @typedef {object} R2Change
 * @property {string} [id]
 * @property {string} [state]
 * @property {{ id?: string }} [acceptedPlan]
 * @property {{ system?: string, id?: string }} workItem
 */

/**
 * @typedef {object} R2EvaluationResult
 * @property {0 | 1} emitted
 * @property {string} taskId
 * @property {string} [reason]
 */

/**
 * @typedef {object} R2ArmResult
 * @property {number} emitted
 * @property {string[]} reasons
 */

/**
 * @typedef {object} R2TaskOrchestrator
 * @property {(id: string) => R2Task | Promise<R2Task> | null} get
 * @property {() => Array<{ id: string }> | Promise<Array<{ id: string }>>} list
 * @property {(listener: (event: { taskId?: string }) => void) => (() => void) | Promise<() => void> | void} [subscribe]
 * @property {(profile: string, workerModel?: string) => { enabled?: boolean, name?: string, model?: { provider?: string, model?: string, reasoningEffort?: string } | null, [k: string]: unknown } | Promise<{ enabled?: boolean, name?: string, model?: { provider?: string, model?: string, reasoningEffort?: string } | null, [k: string]: unknown }>} [resolveWorkerSpec]
 */

/**
 * @typedef {object} R2ChangeControl
 * @property {(system: string, id: string) => R2Change | Promise<R2Change> | null} findByWorkItem
 * @property {(id: string) => { state?: string, acceptedPlan?: { id?: string } } | Promise<{ state?: string, acceptedPlan?: { id?: string } }> | null} status
 */

/**
 * @typedef {object} R2Events
 * @property {(name: string, payload?: object) => void} emit
 * @property {(name: string, listener: (payload: object) => void) => (() => void) | void} [on]
 */

/**
 * @typedef {object} R2ProducerDeps
 * @property {R2TaskOrchestrator} taskOrchestrator
 * @property {R2ChangeControl} changeControl
 * @property {R2Events} events
 * @property {() => Array<{ id: string }> | Promise<Array<{ id: string }>>} [list]
 */

/**
 * @typedef {object} R2Producer
 * @property {(trustedSessionId: string, options?: { taskIds?: string[] }) => Promise<R2ArmResult>} arm
 * @property {(taskId: string) => Promise<R2EvaluationResult>} wake
 * @property {() => void} restart
 * @property {() => void} dispose
 */

/**
 * @param {R2ProducerDeps} deps
 * @returns {R2Producer}
 */
export function createR2HandoffProducer({ taskOrchestrator: orch, changeControl: cc, events, list: listFn } = /** @type {R2ProducerDeps} */ ({})) {
  /** Trusted S — activation memory only. No persisted state. */
  let armedS = '';
  /** Per-task in-flight coalescing: taskId → shared evaluation promise. */
  const inFlight = new Map(/** @type {[string, Promise<R2EvaluationResult>][]} */ ([]));
  /** Cross-activation dedup: taskId → emitted this activation. */
  const emitted = new Set(/** @type {string[]} */ ([]));
  /** Idempotency guard: prevents double subscription on re-arm. */
  let subscribed = false;
  /**
   * Callable disposers collected from subscribe/events.on.
   * @type {Array<(() => void) | void>}
   */
  const disposers = [];

  /**
   * Authoritative candidate discovery: use public list (listFn or orch.list)
   * when available; fall back to the provided taskIds. Each candidate is
   * fresh-read before eligibility evaluation.
   * @param {string[]} fallbackIds
   * @returns {Promise<string[]>}
   */
  async function discoverCandidates(fallbackIds) {
    const listFn2 = listFn ?? (typeof orch.list === 'function' ? orch.list : null);
    if (listFn2) {
      try {
        const rows = /** @type {Array<{ id: string }>} */ (await Promise.resolve(listFn2()));
        const ids = rows
          .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id.trim() !== '')
          .map((r) => /** @type {string} */ (r.id));
        if (ids.length > 0) return ids;
      } catch { /* fall back to provided ids */ }
    }
    return (fallbackIds ?? []).filter((id) => typeof id === 'string' && id.trim() !== '');
  }

  /**
   * Evaluate a candidate task: fresh authoritative reads, fail-closed
   * eligibility, emit at most one handoff request per activation.
   * @param {string} taskId
   * @returns {Promise<R2EvaluationResult>}
   */
  async function evaluate(taskId) {
    // Fails closed: no trusted S, no reconciliation request or mutation.
    if (!armedS) return { emitted: 0, taskId, reason: 'NO_TRUSTED_SESSION' };
    // Dedup: already emitted this activation → coalesce.
    if (emitted.has(taskId)) return { emitted: 0, taskId, reason: 'ALREADY_EMITTED' };
    // Fresh authoritative task read.
    let t = /** @type {R2Task | null} */ (null);
    try {
      t = /** @type {R2Task | null} */ (await Promise.resolve(orch.get(taskId)));
    } catch { t = null; }
    if (!t || typeof t !== 'object') return { emitted: 0, taskId, reason: 'TASK_NOT_FOUND' };
    // Malformed task shape fails closed.
    if (typeof t.status !== 'string' || typeof t.ready_to_run !== 'boolean') {
      return { emitted: 0, taskId, reason: 'MALFORMED_TASK' };
    }
    // Eligibility: task eligible for handoff (no active worker claim).
    if (t.status !== 'ready' || t.ready_to_run !== true) {
      return { emitted: 0, taskId, reason: `UNSUPPORTED_TASK_STATE:${t.status}` };
    }
    // No active worker claim/execution.
    const claimedBy = t.claimed_by ?? null;
    const claimedAt = t.claimed_at ?? null;
    const leaseExpiresAt = t.lease_expires_at ?? null;
    if (claimedBy !== null || claimedAt !== null || leaseExpiresAt !== null) {
      return { emitted: 0, taskId, reason: 'WORKER_CLAIM_PRESENT' };
    }
    // Authoritative worker-profile resolution: the fresh task's worker_profile
    // must be a nonblank string that is confirmed by the public orchestrator
    // registry (resolveWorkerSpec). Unknown, disabled, blank, non-string, or
    // resolver-error profiles fail closed — arbitrary nonblank strings are
    // never accepted as hints.
    const rawProfile = t.worker_profile;
    const profile = typeof rawProfile === 'string' ? rawProfile.trim() : '';
    if (profile === '') return { emitted: 0, taskId, reason: 'NON_RESOLVABLE_PROFILE' };
    if (typeof orch.resolveWorkerSpec !== 'function') {
      // No public resolver available: fail closed — an arbitrary string must
      // not be emitted when the registry cannot authoritatively confirm it.
      return { emitted: 0, taskId, reason: 'NON_RESOLVABLE_PROFILE' };
    }
    /** @type {unknown} */
    let resolvedSpec;
    try {
      resolvedSpec = await Promise.resolve(orch.resolveWorkerSpec(profile, t.worker_model));
    } catch {
      return { emitted: 0, taskId, reason: 'NON_RESOLVABLE_PROFILE' };
    }
    // R2-VER-007: the resolved spec must be an object that is enabled, whose
    // name exactly equals the requested fresh worker_profile (no alias
    // substitution), and whose exposed model matches every explicitly requested
    // worker_model field after the repository's provider/model normalization.
    const spec = /** @type {{ name?: unknown, enabled?: unknown, model?: { provider?: unknown, model?: unknown } | null } | null} */ (
      resolvedSpec && typeof resolvedSpec === 'object' ? resolvedSpec : null
    );
    if (
      !spec
      || spec.enabled === false
      || spec.name !== profile
    ) {
      return { emitted: 0, taskId, reason: 'NON_RESOLVABLE_PROFILE' };
    }
    // Verify the resolved model matches the explicitly requested worker_model.
    // The task's worker_model is an optional string that may encode a
    // "provider/model" pair (slash < 1 means bare model name).
    // A mismatch in provider or model means the resolver substituted a
    // different model — fail closed.
    if (typeof t.worker_model === 'string' && t.worker_model.trim() !== '') {
      const requested = t.worker_model;
      const rm = /** @type {{ provider?: unknown, model?: unknown } | null | undefined} */ (
        spec.model && typeof spec.model === 'object' ? spec.model : null
      );
      if (!rm) {
        // Task requested a model but the resolved spec has no model: fail closed.
        return { emitted: 0, taskId, reason: 'NON_RESOLVABLE_PROFILE' };
      }
      const slash = requested.indexOf('/');
      const reqProvider = slash < 1 ? undefined : requested.slice(0, slash);
      const reqModel = slash < 1 ? requested : requested.slice(slash + 1);
      if (
        (reqProvider !== undefined && rm.provider !== reqProvider)
        || rm.model !== reqModel
      ) {
        return { emitted: 0, taskId, reason: 'NON_RESOLVABLE_PROFILE' };
      }
    }
    // Canonical nonterminal linkage: one Change per task, with a valid system/id.
    let change = /** @type {R2Change | null} */ (null);
    try {
      change = /** @type {R2Change | null} */ (await Promise.resolve(cc.findByWorkItem(WORK_ITEM_SYSTEM, taskId)));
    } catch { change = null; }
    if (!change || typeof change !== 'object') return { emitted: 0, taskId, reason: 'MISSING_LINKAGE' };
    // Enforce the exact canonical task-to-Change linkage: the returned Change
    // must carry a present workItem object whose system is the canonical
    // orchestrator system AND whose id equals the candidate taskId. Missing,
    // malformed, wrong-system, or wrong-id linkage fails closed.
    const wi = change.workItem;
    if (!wi || typeof wi !== 'object') {
      return { emitted: 0, taskId, reason: 'MALFORMED_LINKAGE' };
    }
    if (wi.system !== WORK_ITEM_SYSTEM) {
      return { emitted: 0, taskId, reason: 'LINKAGE_SYSTEM_MISMATCH' };
    }
    if (wi.id !== taskId) {
      return { emitted: 0, taskId, reason: 'LINKAGE_TASK_MISMATCH' };
    }
    const changeId = typeof change.id === 'string' ? change.id.trim() : '';
    if (changeId === '') return { emitted: 0, taskId, reason: 'MALFORMED_CHANGE_ID' };
    /** @type {{ state?: string, acceptedPlan?: { id?: string } } | null} */
    let status = null;
    try {
      status = await Promise.resolve(cc.status(changeId));
    } catch { status = null; }
    if (!status || typeof status !== 'object') return { emitted: 0, taskId, reason: 'MISSING_CHANGE_STATUS' };
    if (status.state !== 'READY') {
      return { emitted: 0, taskId, reason: `CHANGE_NOT_READY:${status.state ?? 'NONE'}` };
    }
    if (!status.acceptedPlan || typeof status.acceptedPlan.id !== 'string' || status.acceptedPlan.id.trim() === '') {
      return { emitted: 0, taskId, reason: 'ABSENT_ACCEPTED_PLAN' };
    }
    // All eligibility confirmed. Emit the single handoff request.
    emitted.add(taskId);
    events.emit(R2_HANDOFF_EVENT, {
      taskId,
      runtimeContext: { authenticatedSessionId: armedS, workerProfile: profile },
    });
    return { emitted: 1, taskId, reason: 'EMITTED' };
  }

  /**
   * Per-task coalescing: concurrent wakeups for the same task share one
   * evaluation; distinct tasks evaluate independently.
   * @param {string} taskId
   * @returns {Promise<R2EvaluationResult>}
   */
  function wake(taskId) {
    if (!armedS) return Promise.resolve({ emitted: 0, taskId, reason: 'NO_TRUSTED_SESSION' });
    const existing = inFlight.get(taskId);
    if (existing) return existing;
    const op = evaluate(taskId).finally(() => inFlight.delete(taskId));
    inFlight.set(taskId, op);
    return op;
  }

  return {
    /**
     * Arm the producer with the trusted S and run startup reconciliation:
     * discover candidate task ids via public list/listFn (authoritative) or
     * fall back to the provided taskIds, then evaluate each candidate with
     * a fresh authoritative read.
     *
     * Also subscribes to taskOrchestrator.subscribe notifications (no-payload
     * task notifications are treated as candidate wakeups, not trusted
     * payloads) and `change-control/linkage-created` events (optional hints).
     *
     * @param {string} trustedSessionId
     * @param {{ taskIds?: string[] }} [options]
     * @returns {Promise<R2ArmResult>}
     */
    async arm(trustedSessionId, options = {}) {
      armedS = typeof trustedSessionId === 'string' ? trustedSessionId.trim() : '';
      const taskIds = (options?.taskIds ?? []).filter((id) => typeof id === 'string' && id.trim() !== '');
      const reasons = [];
      let emittedCount = 0;
      // Authoritative candidate discovery via public list/listFn.
      const candidates = await discoverCandidates(taskIds);
      // Startup reconciliation: evaluate every candidate task.
      for (const id of candidates) {
        const r = await wake(id);
        if (r.emitted === 1) emittedCount += 1;
        if (r.reason && r.emitted === 0) reasons.push(r.reason);
      }
      // Idempotency guard: arm() is the host's R1 controller-boundary hook.
      // A second arm() call in the same activation is rejected with no
      // re-subscribe, so no listener is ever registered twice.
      if (subscribed) return { emitted: emittedCount, reasons: ['ALREADY_ARMED'] };
      subscribed = true;
      // Subscribe to task notifications: payloads are optional hints.
      // No-payload notifications trigger authoritative list-based discovery.
      if (typeof orch.subscribe === 'function') {
        /** @type {(() => void) | void | Promise<() => void>} */
        let subResult;
        try {
          subResult = orch.subscribe((/** @type {{ taskId?: string }} */ event) => {
            // Payload is an optional hint: if a taskId is present, use it as
            // a candidate; otherwise (no-payload notification) fall back to
            // authoritative list-based discovery.
            const hintId = event?.taskId;
            if (typeof hintId === 'string' && hintId.trim() !== '') {
              void wake(hintId);
            } else {
              // No-payload notification: authoritative candidate discovery.
              void discoverCandidates([]).then((ids) => {
                for (const id of ids) void wake(id);
              });
            }
          });
          // Handle sync or async subscription results.
          if (subResult && typeof subResult === 'object' && typeof subResult.then === 'function') {
            Promise.resolve(subResult).then((fn) => {
              if (typeof fn === 'function') disposers.push(fn);
            }).catch(() => { /* async subscribe failure: no disposer, no leak */ });
          } else if (typeof subResult === 'function') {
            disposers.push(subResult);
          }
        } catch { /* sync subscribe failure: no disposer, no leak */ }
      }
      // Subscribe to linkage-created notifications (optional hints only).
      if (typeof events?.on === 'function') {
        try {
          /** @type {(() => void) | void} */
          const linkResult = events.on('change-control/linkage-created', (/** @type {{ taskId?: string }} */ payload) => {
            const hintId = payload?.taskId;
            if (typeof hintId === 'string' && hintId.trim() !== '') {
              void wake(hintId);
            }
            // No-payload / no-taskId: authoritative discovery.
            else {
              void discoverCandidates([]).then((ids) => {
                for (const id of ids) void wake(id);
              });
            }
          });
          if (typeof linkResult === 'function') disposers.push(linkResult);
        } catch { /* noop */ }
      }
      return { emitted: emittedCount, reasons };
    },

    /**
     * Candidate wakeup hint (from taskOrchestrator.subscribe / linkage-created).
     * @param {string} taskId
     * @returns {Promise<R2EvaluationResult>}
     */
    wake,

    /**
     * Restart clears the trusted S (activation memory only). No emission,
     * no mutation; re-arm to re-establish S.
     */
    restart() {
      armedS = '';
      inFlight.clear();
      emitted.clear();
      subscribed = false; // allow re-arm after restart
    },

    /**
     * Dispose: clear activation memory and release all subscriptions.
     * Handles both sync and async disposers; a throwing disposer does not
     * prevent the remaining disposers from running.
     */
    dispose() {
      armedS = '';
      inFlight.clear();
      emitted.clear();
      subscribed = false; // allow re-arm after dispose
      const fns = /** @type {Array<(() => void) | void>} */ (disposers.splice(0, disposers.length));
      for (const fn of fns) {
        if (typeof fn === 'function') {
          try { fn(); } catch { /* noop: one bad disposer must not prevent the rest */ }
        }
      }
    },
  };
}
