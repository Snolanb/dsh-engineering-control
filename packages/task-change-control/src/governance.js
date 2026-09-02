// @ts-nocheck
/**
 * Integration-side preDispatch guard factory.
 *
 * Semantics per T5.2: a task is GOVERNED iff a Change-side workItem link
 * exists. Governed tasks require: linked Change (by definition), an accepted
 * plan, Change in READY state, and a valid task claim (the dispatcher guard
 * runs post-claim, so the claim context is already present).
 * Ungoverned tasks pass untouched: the guard is a pure pass-through.
 *
 * All verification reads go through ctx.changeControl's canonical projections
 * (status, findByWorkItem) — NO store code here.
 */

/**
 * @param {object} changeControl the ctx.changeControl service
 * @param {string} WORK_ITEM_SYSTEM the Change-side work-item system id
 */
export function createGovernanceGuard(changeControl, WORK_ITEM_SYSTEM) {
  return async function governanceGuard({ task }) {
    const change = await changeControl.findByWorkItem(WORK_ITEM_SYSTEM, task.id);
    if (!change) return { ok: true }; // ungoverned → pass-through

    const status = await changeControl.status(change.id);
    const preconditions = [
      { name: 'linked_change', satisfied: true, detail: change.id },
      { name: 'accepted_plan', satisfied: Boolean(status.acceptedPlan) },
      { name: 'change_ready', satisfied: status.state === 'READY' },
      // The guard runs after the dispatcher's claim; a reached guard means a
      // valid claim context exists. Still asserted for defense in depth.
      { name: 'task_claimed', satisfied: task.status === 'claimed' || task.status === 'running' },
    ];
    const failed = preconditions.filter((p) => !p.satisfied);
    if (failed.length === 0) return { ok: true };
    return {
      ok: false,
      code: 'DISPATCH_NOT_GOVERNED',
      changeId: change.id,
      preconditions,
    };
  };
}
