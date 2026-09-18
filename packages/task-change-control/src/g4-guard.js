/**
 * G4 — structured error constants for governed completion.
 *
 * The task-orchestrator lifecycle guard is generic: it only sees the denial
 * object a registered guard returns. The GOVERNED_COMPLETION_PENDING code and
 * the {changeId, changeState} evidence shape are Change Control domain
 * concepts that live ENTIRELY in this package — task-orchestrator source
 * must not import or name them (frozen test greps store.js for
 * GOVERNED_COMPLETION / CHANGE_CONTROL symbols).
 */

/** Structured error code for governed-completion denial. */
export const GOVERNED_COMPLETION_PENDING = 'GOVERNED_COMPLETION_PENDING';
