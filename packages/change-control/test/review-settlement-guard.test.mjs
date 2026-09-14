/**
 * T-H12 round-4 (F1) — ChangeStore review-settlement guard contract.
 *
 * The store enforces an OPTIONAL round-settlement guard before any review
 * mutation, at the authoritative tool/store boundary. Standalone stores (no
 * guard registered) keep legacy behavior; a store WITH a guard installed (by
 * the governed integration, via registerChangeTools wiring) rejects whatever
 * session the guard rejects — before touching state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeStore, registerReviewSettlementGuard } from '../src/storage/change-store.js';

const input = {
  title: 'Round-guard probe',
  objective: 'o',
  acceptanceCriteria: ['x'],
  risk: 'normal',
};

const pass = (revision = 'r1') => ({ verdict: 'pass', revision, findings: [] });

async function withReviewStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-guard-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const change = await store.create(input);
    for (const state of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW']) {
      await store.transition(change.id, state);
    }
    await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-1', revision: 'r1', status: 'completed' });
    await store.bindRole(change.id, 'round-session', 'reviewer');
    await store.bindRole(change.id, 'prior-round-session', 'reviewer');
    return await fn(store, change);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('review settlement guard rejects the session it names before any mutation', async () => {
  await withReviewStore(async (store, change) => {
    const { unregister } = registerReviewSettlementGuard(store, async ({ changeId, sessionId }) => {
      if (sessionId !== 'round-session') {
        throw Object.assign(new Error(`session ${sessionId} is not the current review round's reviewer`), { code: 'STALE_ROUND_SESSION' });
      }
    });

    await assert.rejects(
      store.submitReview(change.id, pass(), { sessionId: 'prior-round-session' }),
      (e) => e?.code === 'STALE_ROUND_SESSION',
      'the guard rejection surfaces STALE_ROUND_SESSION at the store boundary',
    );
    assert.equal((await store.get(change.id)).state, 'REVIEW', 'no state leaked through the rejected settlement');

    const settled = await store.submitReview(change.id, pass(), { sessionId: 'round-session' });
    assert.equal(settled.verdict, 'pass', 'the guard-approved session settles normally');

    unregister();
  });
});

test('settlement guard is rechecked under the write lock', async () => {
  await withReviewStore(async (store, change) => {
    const calls = [];
    const { unregister } = registerReviewSettlementGuard(store, async (args) => {
      calls.push(args);
      if (!args.locked) {
        await store.recordAttempt(change.id, { attemptId: 'impl-2', workerId: 'worker-2', revision: 'r2', status: 'completed' });
      }
      if (args.locked) {
        assert.equal(args.currentRevision, 'r2', 'the locked check sees the revision advance');
        throw Object.assign(new Error('locked round changed'), { code: 'STALE_ROUND_SESSION' });
      }
    });
    await assert.rejects(
      store.submitReview(change.id, pass(), { sessionId: 'round-session' }),
      (error) => error?.code === 'STALE_ROUND_SESSION',
    );
    assert.equal(calls.length, 2, 'authorization runs before and inside the write lock');
    assert.equal(calls[1].locked, true, 'the second check receives the locked snapshot');
    assert.equal((await store.get(change.id)).state, 'REVIEW', 'the locked rejection leaves state unchanged');
    unregister();
  });
});

test('no guard registered → standalone submitReview behavior is unchanged', async () => {
  await withReviewStore(async (store, change) => {
    const result = await store.submitReview(change.id, pass(), { sessionId: 'prior-round-session' });
    assert.equal(result.verdict, 'pass', 'legacy role/revision checks remain the complete gate');
    assert.equal((await store.get(change.id)).state, 'APPROVED');
  });
});

test('a guard registration can be disposed with the service that owned it', async () => {
  await withReviewStore(async (store, change) => {
    const { unregister } = registerReviewSettlementGuard(store, async () => {
      throw Object.assign(new Error('always off'), { code: 'STALE_ROUND_SESSION' });
    });
    await assert.rejects(store.submitReview(change.id, pass(), { sessionId: 'round-session' }));
    unregister();
    const result = await store.submitReview(change.id, pass(), { sessionId: 'round-session' });
    assert.equal(result.verdict, 'pass', 'unregistered guard no longer intervenes');
  });
});
