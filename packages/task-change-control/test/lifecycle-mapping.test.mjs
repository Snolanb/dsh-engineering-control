import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import changeControlPlugin from 'dsh-change-control';
import {
  ALLOWED_CHANGE_STATES,
  validatePairing,
} from '../src/lifecycle.js';
import plugin from '../src/index.js';

const SYSTEM = 'dsh-task-orchestrator';
const ALL_TASK_STATUSES = ['backlog', 'planning', 'ready', 'claimed', 'running', 'in_review', 'changes_requested', 'blocked', 'failed', 'done', 'cancelled'];
const ALL_CHANGE_STATES = ['DRAFT', 'PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW', 'REPAIR', 'APPROVED'];

test('mapping is total: every task status has a defined permissible set of Change states', () => {
  for (const s of ALL_TASK_STATUSES) {
    assert.ok(Array.isArray(ALLOWED_CHANGE_STATES[s]), `missing mapping for task status ${s}`);
    for (const cs of ALLOWED_CHANGE_STATES[s]) assert.ok(ALL_CHANGE_STATES.includes(cs), `unknown Change state ${cs}`);
  }
});

test('paired lifecycle: coherent pairs validate, incoherent pairs are classified (never mutated)', () => {
  // Coherent spine
  assert.equal(validatePairing('planning', 'DRAFT').ok, true);
  assert.equal(validatePairing('ready', 'READY').ok, true);
  assert.equal(validatePairing('running', 'IMPLEMENTING').ok, true);
  assert.equal(validatePairing('in_review', 'REVIEW').ok, true);
  assert.equal(validatePairing('changes_requested', 'REPAIR').ok, true);
  assert.equal(validatePairing('done', 'APPROVED').ok, true);
  // Incoherent
  const bad = validatePairing('running', 'DRAFT');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'LIFECYCLE_MISMATCH');
  assert.equal(bad.taskStatus, 'running');
  assert.equal(bad.changeState, 'DRAFT');
  assert.deepEqual(bad.allowed, ALLOWED_CHANGE_STATES.running);
});

test('cross-boundary validatePairing: pairing validated against REAL stores, no mutation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tcc-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);

  const task = await taskStore.create({ title: 'governed task' }); // status: backlog
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id); // DRAFT
  assert.equal(validatePairing(task.status, change.state).ok, true, 'backlog × DRAFT must be coherent');

  // Force an incoherent live pairing: run the task while the Change sits in DRAFT.
  await taskStore.update(task.id, { status: 'ready' });
  await taskStore.claim(task.id, 'w', { leaseSeconds: 600 });
  await taskStore.start(task.id, 'w');
  const liveTask = await ctx.taskOrchestrator.get(task.id);
  assert.equal(liveTask.status, 'running');
  const liveChange = await ctx.changeControl.get(change.id);
  assert.equal(liveChange.state, 'DRAFT');
  const verdict = validatePairing(liveTask.status, liveChange.state);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'LIFECYCLE_MISMATCH');
  // No mutation: both states unchanged after validation.
  assert.equal((await ctx.taskOrchestrator.get(task.id)).status, 'running');
  assert.equal((await ctx.changeControl.get(change.id)).state, 'DRAFT');
});
