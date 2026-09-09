// @ts-nocheck — raw node:fs/os/path I/O; same convention as src/binding.js,
// src/governance.js, and src/tools.js.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * T-H5 PR2-01 — durable cross-process reviewer-claim.
 *
 * The claim FILE is the reservation: an exclusive create-and-write claims it
 * atomically across host processes (the same file-backed locking architecture
 * the ChangeStore uses for its cross-process disk lock), and the launched
 * session is recorded in the file BEFORE the binding, so a crashed owner's
 * reviewer is reconciled by the next claim (adopted, never re-launched, never
 * orphaned). A confirmed reviewer binding always wins: it is the durable,
 * cross-process-visible terminal record.
 *
 * Claim-file layout: `<task.workspace>/.dsh-governance/reviewer-claims/
 * reviewer-claim-<changeId>`. The shared task workspace is the stable anchor
 * every host process owning the task sees; hosts without a workspace fall
 * back to the shared host tmpdir (wiped on host reboot, where all sessions
 * are dead anyway and a fresh launch is the correct convergence).
 */

/**
 * Claim lease: the longest a claim owner may hold a reservation without the
 * launched session being bound. A crashed owner's claim goes stale and a
 * waiting successor takes it over, so liveness is inferred from the durable
 * record timestamp, not a heartbeat.
 * ponytail: ceiling — a reviewer launch that outlives the lease can be taken
 * over mid-flight by a waiting process (duplicate-launch window); raise the
 * lease if provider cold-starts run longer than 10 minutes.
 */
export const REVIEWER_CLAIM_LEASE_MS = 10 * 60 * 1000;
const REVIEWER_CLAIM_POLL_MS = 50;
/** Bounded wait: lease + grace, so a corrupt record can never block forever. */
export const REVIEWER_CLAIM_WAIT_MS = REVIEWER_CLAIM_LEASE_MS + 60_000;

/**
 * @param {any} change
 * @param {any} task
 * @returns {string}
 */
export function reviewerClaimFile(change, task) {
  const base = typeof task?.workspace === 'string' && task.workspace.trim() !== ''
    ? task.workspace
    : tmpdir();
  return join(base, '.dsh-governance', 'reviewer-claims', `reviewer-claim-${String(change.id)}`);
}

/** @returns {string} the host-process identity written into claim records. */
export function claimIdentity() {
  return `${hostname()}:${process.pid}`;
}

/**
 * @param {string} file
 * @returns {Promise<{ exists: boolean, incomplete: boolean, value: { claimant?: string, sessionId?: string | null, updatedAt?: number } | null }>}
 */
export async function readClaimRecord(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { exists: false, incomplete: false, value: null };
  }
  if (raw.trim() === '') {
    // The holder exclusive-created the claim but has not finished its
    // initial record write (or died mid-write): incomplete, never stale
    // by content.
    return { exists: true, incomplete: true, value: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { exists: true, incomplete: true, value: null };
    return { exists: true, incomplete: false, value: parsed };
  } catch {
    return { exists: true, incomplete: true, value: null };
  }
}

/**
 * Atomic rewrite of the durable claim record (tmp + rename, as the store's
 * writeJson). The INITIAL claim is NOT written this way — it is a single
 * exclusive open+write (see claimExclusiveWrite) so the claim and its
 * record appear together and a lost claim is the atomic loser, not a
 * reclaimer of an empty file.
 * @param {string} file
 * @param {{ claimant: string, sessionId: string | null, updatedAt: number }} record
 */
export async function writeClaimRecord(file, record) {
  const tmp = `${file}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(record), 'utf8');
  await rename(tmp, file);
}

/**
 * Exclusive create + initial record write in one open (atomic claim).
 * @param {string} file
 * @param {{ claimant: string, sessionId: string | null, updatedAt: number }} record
 * @returns {Promise<boolean>} true when this caller won the claim
 */
export async function claimExclusiveWrite(file, record) {
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, JSON.stringify(record), {
      flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    });
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

/** @param {string} file */
export async function removeClaimFile(file) {
  await rm(file, { force: true }).catch(() => {});
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The claim protocol (see module notes). Never launches a reviewer while a
 * durable claim exists: reuses a confirmed binding, adopts a recorded
 * (launched-but-unbound) session, waits for a live owner, or takes over a
 * stale claim — then hands off to `launch`, which records its session
 * durably before binding.
 *
 * @param {{
 *   c: any, change: any, task: any,
 *   launch: (holder: { file: string, identity: string }) => Promise<string>,
 * }} deps
 * @returns {Promise<string>} the reviewer session id to use
 */
export async function reserveReviewerLaunch({ c, change, task, launch }) {
  const file = reviewerClaimFile(change, task);
  const identity = claimIdentity();
  const deadline = Date.now() + REVIEWER_CLAIM_WAIT_MS;
  for (;;) {
    // 1. Confirmed reviewer binding: durable and visible across processes —
    //    reuse it, never launch.
    const bound = (await c.listRoleBindings()).find((b) => b.changeId === change.id && b.role === 'reviewer');
    if (bound) return bound.sessionId;

    const { exists, incomplete, value: record } = await readClaimRecord(file);

    // 2. No claim yet: claim it atomically, then launch the single reviewer.
    if (!exists) {
      const won = await claimExclusiveWrite(file, { claimant: identity, sessionId: null, updatedAt: Date.now() });
      if (!won) continue; // a concurrent claimer raced us; loop back to steps 1/3
      return await launch({ file, identity });
    }

    // 3. Incomplete claim (holder mid-initial-write, or died mid-write):
    //    wait it out; reclaim only after the wait window (a live holder
    //    finishes its initial write in microseconds, so an incomplete file
    //    that outlives the window is a dead holder's, reclaimable).
    if (incomplete) {
      if (Date.now() > deadline) {
        await removeClaimFile(file);
        continue;
      }
      await sleep(REVIEWER_CLAIM_POLL_MS);
      continue;
    }

    const stale = Date.now() - Number(record.updatedAt || 0) > REVIEWER_CLAIM_LEASE_MS;

    // 4. A launched session is recorded but not yet bound: the owner is
    //    mid-bind (wait for convergence) or crashed (adopt). Adoption binds
    //    the recorded session instead of launching a duplicate — the
    //    orphaned reviewer is reconciled, not re-created.
    if (record.sessionId && typeof record.sessionId === 'string') {
      if (!stale) {
        if (Date.now() > deadline) {
          throw Object.assign(new Error('reviewer claim owner has not bound its session within the wait window'), { code: 'REVIEWER_CLAIM_TIMEOUT' });
        }
        await sleep(REVIEWER_CLAIM_POLL_MS);
        continue;
      }
      // Stale owner: bind the recorded session (a concurrent adopter may
      // have beaten us — ALREADY_BOUND is successful convergence).
      await c.bindRole(change.id, record.sessionId, 'reviewer')
        .catch((err) => { if (err?.code === 'ALREADY_BOUND') return null; throw err; });
      await c.appendAudit({
        kind: 'review_orchestration', changeId: change.id, action: 'reviewer_claim_adopted',
        sessionId: record.sessionId, claimant: record.claimant ?? null,
      });
      return record.sessionId;
    }

    // 5. No recorded session: a live owner is mid-launch (wait) or the claim
    //    is stale (reclaim).
    if (stale) {
      await removeClaimFile(file);
      continue; // retry the exclusive claim (a concurrent reclaimer may win first)
    }
    if (Date.now() > deadline) {
      throw Object.assign(new Error('reviewer claim wait exceeded window'), { code: 'REVIEWER_CLAIM_TIMEOUT' });
    }
    await sleep(REVIEWER_CLAIM_POLL_MS);
  }
}
