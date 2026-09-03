// @ts-nocheck
/**
 * Canonical Code-level facade over ChangeStore.
 *
 * This is THE integration contract: external packages obtain exactly this
 * object via the Cordis service `changeControl` (ctx.provide('changeControl')).
 * ChangeStore internals are never part of the integration boundary.
 *
 * Operation surface (authoritative, controller-facing — model-facing identity
 * derivation and authorization stay in the tool layer):
 *   create, get, submitPlan, acceptPlan, bindRole, unbindRole, resolveRole,
 *   submitProof, runPreflight, submitReview, submitRepair, history, status
 *
 * findByWorkItem is intentionally absent until the external work-item linkage
 * lands (Phase 3 ticket T3.1).
 *
 * @param {import('../storage/change-store.js').ChangeStore} store
 */
export function createChangeControlService(store) {
  if (!store || typeof store.create !== 'function') {
    throw new TypeError('changeControl service requires a ChangeStore instance');
  }
  return Object.freeze({
    /** Create a Change. Starts in DRAFT. */
    create: (input) => store.create(input),

    /** Get a Change by id (public projection, no private store state). */
    get: (changeId) => store.get(changeId),

    /**
     * Resolve the NONTERMINAL Change linked to an external work item
     * { system, id } — the authoritative task↔Change linkage. Returns null
     * when unlinked. Terminal/legacy Changes are never matched.
     */
    findByWorkItem: (system, id) => store.findByWorkItem(system, id),

    /**
     * Idempotent find-or-create for a work item: at most one nonterminal
     * Change per (system, id). Concurrent calls converge on one Change.
     */
    findOrCreateForWorkItem: ({ system, id, change }) =>
      store.findOrCreateForWorkItem({ ...change, workItem: { system, id } }),

    /** Submit a plan revision. */
    submitPlan: (changeId, content) => store.submitPlan(changeId, content),

    /**
     * Host-side plan acceptance. Callers must prove authority; the tool layer
     * passes the session-derived auth context, host commands pass authorized: true.
     */
    acceptPlan: (changeId, planId, opts) => store.acceptPlan(changeId, planId, opts),

    /** Bind a session identity to a role on a Change. */
    bindRole: (changeId, sessionId, role, opts) => store.bindRole(changeId, sessionId, role, opts),

    /** Remove a session role binding. */
    unbindRole: (changeId, sessionId, opts) => store.unbindRole(changeId, sessionId, opts),

    /** Resolve the role of a session on a Change. */
    resolveRole: (changeId, sessionId) => store.resolveRole(changeId, sessionId),

    /** Submit a proof bundle (IMPLEMENTING → PREFLIGHT). */
    submitProof: (changeId, proof) => store.submitProof(changeId, proof),

    /** Run deterministic controller preflight. */
    runPreflight: (changeId, input) => store.runPreflight(changeId, input),

    /** Submit an independent structured review (REVIEW → APPROVED | REPAIR). */
    submitReview: (changeId, review, opts) => store.submitReview(changeId, review, opts),

    /** Submit a repair (REPAIR → PREFLIGHT). */
    submitRepair: (changeId, repair, opts) => store.submitRepair(changeId, repair, opts),

    /** Append-only audit history for a Change. */
    history: (changeId) => store.history(changeId),

    /**
     * Host-owned risk classification (audit, downgrade protection, gate
     * invalidation). Used by the host /change-new command; mirrors the
     * canonical host risk API.
     */
    setRisk: (changeId, risk) => store.setRisk(changeId, risk),

    transition: (changeId, toState, opts) => store.transition(changeId, toState, opts),

    /**
     * Canonical read-only status projection: state, risk, accepted plan,
     * bindings, revision, proof, preflight, open findings.
     */
    status: (changeId) => statusProjection(store, changeId),
  });
}

/** Canonical status projection (single definition; used by service + host commands). */
async function statusProjection(store, changeId) {
  const change = await store.get(changeId);
  const bindings = (await store.listRoleBindings()).filter((b) => b.changeId === changeId);
  const attempts = await store.listAttempts(changeId);
  const revision = attempts.length > 0 ? attempts[attempts.length - 1].revision ?? null : null;
  const proof = await store.getProof(changeId).catch(() => null);
  const preflight = await store.getPreflight(changeId).catch(() => null);
  const acceptedPlan = change.acceptedPlanId ? await store.getPlan(change.acceptedPlanId).catch(() => null) : null;
  let openFindings = [];
  try {
    openFindings = (await store.getRepairContext(changeId)).unresolvedFindings;
  } catch { /* no reviews yet */ }
  return {
    id: change.id,
    title: change.title,
    objective: change.objective,
    state: change.state,
    risk: change.risk,
    acceptedPlan,
    bindings,
    revision,
    proof,
    preflight,
    openFindings,
  };
}
