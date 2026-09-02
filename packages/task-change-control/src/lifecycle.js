/**
 * Explicit lifecycle mapping between the Task Orchestrator task lifecycle
 * and the Change Control Change lifecycle. The two state machines stay
 * distinct — this module is ONLY read-side pairing validation applied in
 * the integration layer. NO writes happen here.
 */
export const ALLOWED_CHANGE_STATES = Object.freeze({
  backlog:           Object.freeze(['DRAFT']),
  planning:          Object.freeze(['DRAFT', 'PLANNED']),
  ready:             Object.freeze(['DRAFT', 'PLANNED', 'READY']),
  claimed:           Object.freeze(['READY', 'IMPLEMENTING']),
  running:           Object.freeze(['READY', 'IMPLEMENTING']),
  in_review:         Object.freeze(['PREFLIGHT', 'REVIEW']),
  changes_requested: Object.freeze(['REPAIR']),
  blocked:           Object.freeze(['DRAFT', 'PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW', 'REPAIR']),
  failed:            Object.freeze(['DRAFT', 'PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW', 'REPAIR']),
  done:              Object.freeze(['APPROVED']),
  cancelled:         Object.freeze(['DRAFT', 'PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW', 'REPAIR', 'APPROVED']),
});

/**
 * Validate one (taskStatus, changeState) pairing. Returns a structured
 * result; never mutates anything.
 * @param {string} taskStatus
 * @param {string} changeState
 * @returns {{ ok: true } | { ok: false, code: 'LIFECYCLE_MISMATCH', taskStatus: string, changeState: string, allowed: string[] }}
 */
export function validatePairing(taskStatus, changeState) {
  const allowed = /** @type {Record<string, readonly string[]>} */ (ALLOWED_CHANGE_STATES)[taskStatus];
  if (!allowed) {
    return { ok: false, code: 'LIFECYCLE_MISMATCH', taskStatus, changeState, allowed: [] };
  }
  if (allowed.includes(changeState)) return { ok: true };
  return { ok: false, code: 'LIFECYCLE_MISMATCH', taskStatus, changeState, allowed: [...allowed] };
}
