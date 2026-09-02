import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeStore } from '../src/storage/change-store.js';
import { createChangeControlService } from '../src/service/change-control-service.js';

// Phase 3 / T3.1: durable external work-item reference on Change.
// The Change-side workItem is the AUTHORITATIVE task linkage.

const WORK_ITEM = { system: 'dsh-task-orchestrator', id: 'task-0001' };
const input = (over = {}) => ({
  title: 'linked change', objective: 'link test', acceptanceCriteria: ['ok'], ...over,
});

async function fixture(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'work-item-linkage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const store = await ChangeStore.open(file, options);
  return { store, file };
}

test('create with workItem persists it; findByWorkItem resolves it', async (t) => {
  const { store } = await fixture(t);
  const change = await store.create(input({ workItem: WORK_ITEM }));
  assert.deepEqual(change.workItem, WORK_ITEM);
  const found = await store.findByWorkItem(WORK_ITEM.system, WORK_ITEM.id);
  assert.equal(found.id, change.id);
  assert.deepEqual(found.workItem, WORK_ITEM);
});

test('workItem requires {system, id} strings — validation happens before persistence', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    store.create(input({ workItem: { system: 'x' } })),
    (e) => e.code === 'INVALID_WORK_ITEM'
  );
  await assert.rejects(
    store.create(input({ workItem: { system: 1, id: 'a' } })),
    (e) => e.code === 'INVALID_WORK_ITEM'
  );
});

test('linkage generates exactly one WORK_ITEM_LINKED audit event', async (t) => {
  const { store } = await fixture(t);
  const change = await store.create(input({ workItem: WORK_ITEM }));
  const history = await store.history(change.id);
  const linked = history.filter((e) => e.type === 'WORK_ITEM_LINKED');
  assert.equal(linked.length, 1);
  assert.equal(linked[0].workItem.system, WORK_ITEM.system);
  assert.equal(linked[0].workItem.id, WORK_ITEM.id);
});

test('at most one NONTERMINAL Change per (system,id): concurrent find-or-create returns the same Change', async (t) => {
  const { store } = await fixture(t);
  const [a, b] = await Promise.all([
    store.findOrCreateForWorkItem(input({ workItem: WORK_ITEM })),
    store.findOrCreateForWorkItem(input({ workItem: WORK_ITEM })),
  ]);
  assert.equal(a.id, b.id, 'both callers must receive the same changeId');
  const found = await store.findByWorkItem(WORK_ITEM.system, WORK_ITEM.id);
  assert.equal(found.id, a.id);
});

test('terminal (APPROVED) Change frees the slot for a new linkage', async (t) => {
  const { store } = await fixture(t);
  const first = await store.create(input({ workItem: WORK_ITEM }));
  // Walk the legal path to APPROVED: DRAFT→PLANNED→READY→IMPLEMENTING→PREFLIGHT→REVIEW→APPROVED
  for (const s of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW', 'APPROVED']) {
    await store.transition(first.id, s);
  }
  const second = await store.findOrCreateForWorkItem(input({ workItem: WORK_ITEM }));
  assert.notEqual(second.id, first.id);
});

test('persistence across reopen: findByWorkItem and audit survive restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-item-reopen-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const store1 = await ChangeStore.open(file);
  const change = await store1.create(input({ workItem: WORK_ITEM }));
  const store2 = await ChangeStore.open(file);
  const found = await store2.findByWorkItem(WORK_ITEM.system, WORK_ITEM.id);
  assert.equal(found.id, change.id);
  const linked = (await store2.history(change.id)).filter((e) => e.type === 'WORK_ITEM_LINKED');
  assert.equal(linked.length, 1);
});

test('legacy Changes without workItem remain fully valid and unlinked', async (t) => {
  const { store } = await fixture(t);
  const legacy = await store.create(input());
  assert.equal(legacy.workItem, null);
  assert.equal(await store.findByWorkItem(WORK_ITEM.system, WORK_ITEM.id), null);
  const reopenedHistory = await store.history(legacy.id);
  assert.equal(reopenedHistory.filter((e) => e.type === 'WORK_ITEM_LINKED').length, 0);
  // Legacy operations still work
  await store.transition(legacy.id, 'PLANNED');
  assert.equal((await store.get(legacy.id)).state, 'PLANNED');
});

test('service facade exposes findByWorkItem and findOrCreateForWorkItem', async (t) => {
  const { store } = await fixture(t);
  const svc = createChangeControlService(store);
  assert.equal(typeof svc.findByWorkItem, 'function');
  const created = await svc.findOrCreateForWorkItem({ system: WORK_ITEM.system, id: WORK_ITEM.id, change: input() });
  assert.equal(created.workItem.system, WORK_ITEM.system);
  const again = await svc.findOrCreateForWorkItem({ system: WORK_ITEM.system, id: WORK_ITEM.id, change: input() });
  assert.equal(again.id, created.id);
  const found = await svc.findByWorkItem(WORK_ITEM.system, WORK_ITEM.id);
  assert.equal(found.id, created.id);
});
