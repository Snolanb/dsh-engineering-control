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

test('cross-instance race: two stores opened BEFORE the link both converge on one Change', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-item-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const s1 = await ChangeStore.open(file);
  const s2 = await ChangeStore.open(file); // both instances pre-date any link
  const [a, b] = await Promise.all([
    s1.findOrCreateForWorkItem(input({ workItem: WORK_ITEM })),
    s2.findOrCreateForWorkItem(input({ workItem: WORK_ITEM })),
  ]);
  assert.equal(a.id, b.id, 'cross-instance find-or-create must converge');
  // And a fresh lookup on the STALE instance sees the link + terminal switch.
  for (const s of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW', 'APPROVED']) {
    await s1.transition(a.id, s);
  }
  assert.equal(await s2.findByWorkItem(WORK_ITEM.system, WORK_ITEM.id), null, 'stale instance must see terminal state');
});

test('direct create() with workItem enforces nonterminal uniqueness', async (t) => {
  const { store } = await fixture(t);
  await store.create(input({ workItem: WORK_ITEM }));
  await assert.rejects(
    store.create(input({ workItem: WORK_ITEM })),
    (e) => e.code === 'WORK_ITEM_ALREADY_LINKED' && typeof e.existingChangeId === 'string'
  );
  // Legacy path is unaffected: unlinked creates always allowed.
  const free = await store.create(input());
  assert.ok(free.id);
});

test('legacy pre-domainState replay tolerates WORK_ITEM_LINKED events missing from/to', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-item-replay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const { writeFile } = await import('node:fs/promises');
  // First-iteration Phase-3 record: no domainState, linkage event without from/to.
  const doc = {
    changes: [{ id: 'c1', title: 'legacy', objective: '', acceptanceCriteria: [], risk: null, acceptedPlanId: null, workItem: WORK_ITEM, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    audit: [
      { eventId: 1, changeId: 'c1', from: null, to: 'DRAFT', ts: '2026-01-01T00:00:00.000Z' },
      { eventId: 2, changeId: 'c1', type: 'WORK_ITEM_LINKED', workItem: WORK_ITEM, ts: '2026-01-01T00:00:00.000Z' },
    ],
  };
  await writeFile(file, JSON.stringify(doc), 'utf8');
  const store = await ChangeStore.open(file);
  const c = await store.get('c1');
  assert.equal(c.state, 'DRAFT');
  assert.deepEqual(c.workItem, WORK_ITEM);
  assert.equal((await store.findByWorkItem(WORK_ITEM.system, WORK_ITEM.id))?.id, 'c1');
});

test('cross-PROCESS race: two host processes linking the same work item converge on one Change', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-item-xproc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const storeImport = new URL('../src/storage/change-store.js', import.meta.url).pathname;
  const childScript = `import { ChangeStore } from '${storeImport}';
const s = await ChangeStore.open(process.argv[1]);
const c = await s.findOrCreateForWorkItem({ title: 'racer', objective: 'o', acceptanceCriteria: [], workItem: { system: 'dsh-task-orchestrator', id: 'xc-task' } });
console.log(c.id);`;
  const runChild = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', childScript, file]);
  const [a, b] = await Promise.all([runChild(), runChild()]);
  const idA = a.stdout.trim(); const idB = b.stdout.trim();
  assert.ok(idA && idB, 'both processes returned an id');
  assert.equal(idA, idB, 'two host processes must converge on the same Change');
  const { readFile } = await import('node:fs/promises');
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(disk.changes.length, 1, 'exactly one Change persisted');
  assert.equal(disk.audit.filter((e) => e.type === 'WORK_ITEM_LINKED').length, 1);
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
