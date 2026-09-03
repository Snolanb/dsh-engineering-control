import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import { createReviewerLauncher } from '../../task-orchestrator/lib/reviewer-launcher.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import changeControlPlugin from 'dsh-change-control';
import plugin from '../src/index.js';

function fakeRpc(log) {
  return {
    async call(op, args) {
      log.push({ op, args });
      if (op === 'session.create') return { sessionId: 'sess-real-reviewer' };
      if (op === 'session.history') return { events: [] };
      return {};
    },
  };
}

function makeOrch(dbDir, rpcLog) {
  const store = new TaskStore({ dbPath: join(dbDir, 'o.db') });
  return {
    get: store.get.bind(store),
    update: store.update.bind(store),
    updateIf: (id, e, p) => store.updateIf(id, e, p),
    complete: store.complete.bind(store),
    createReviewerLauncher: (opts) => createReviewerLauncher({ ...(opts ?? {}), rpc: fakeRpc(rpcLog) }),
    _store: store,
  };
}

async function compose(t, dir) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, {});
  const rpcLog = [];
  const orch = makeOrch(dir, rpcLog);
  ctx.provide('taskOrchestrator', Object.freeze(orch));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);
  return { ctx, taskStore: orch._store, rpcLog };
}

test('REAL facade launcher: no reviewer_model → session.create succeeds, selectModel NOT sent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tcc-t81-real-'));
  const { ctx, taskStore, rpcLog } = await compose(t, dir);
  const task = await taskStore.create({ title: 'g', description: 'd', status: 'ready', workspace: dir, worker_profile: 'w', acceptance_criteria: ['a'] });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  const res = await ctx.taskChangeControl.launchReviewer(task.id);
  assert.equal(res.sessionId, 'sess-real-reviewer');
  const ops = rpcLog.map((r) => r.op);
  assert.ok(ops.includes('session.create'));
  assert.ok(!ops.includes('session.selectModel'), 'selectModel must NOT be sent when no model configured');
  // binding proof
  const b = (await ctx.changeControl.listRoleBindings()).find((b2) => b2.changeId === change.id);
  assert.equal(b.role, 'reviewer');
});

test('REAL facade launcher: reviewer_model "prov/m" parsed as {provider, model}', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tcc-t81-real2-'));
  const { ctx, taskStore, rpcLog } = await compose(t, dir);
  const task = await taskStore.create({ title: 'g', description: 'd', status: 'ready', workspace: dir, worker_profile: 'w', reviewer_model: 'ollama/foo-9b', acceptance_criteria: ['a'] });
  await ctx.taskChangeControl.bootstrapTask(task.id);
  await ctx.taskChangeControl.launchReviewer(task.id);
  const sel = rpcLog.find((r) => r.op === 'session.selectModel');
  assert.ok(sel, 'selectModel must be sent');
  assert.deepEqual({ provider: sel.args.provider, model: sel.args.model }, { provider: 'ollama', model: 'foo-9b' });
});

test('SESSION_ID_MISSING path terminates the spawned handle', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tcc-t81-real3-'));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, {});
  const store = new TaskStore({ dbPath: join(dir, 'o.db') });
  let terminated = 0;
  ctx.provide('taskOrchestrator', Object.freeze({
    get: store.get.bind(store),
    update: store.update.bind(store),
    updateIf: (id, e, p) => store.updateIf(id, e, p),
    complete: store.complete.bind(store),
    createReviewerLauncher: () => ({
      async launch() { return { sessionId: '', terminate: async () => { terminated += 1; return true; } }; },
    }),
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);
  const task = await store.create({ title: 'g', description: 'd', status: 'ready', workspace: dir, worker_profile: 'w', acceptance_criteria: ['a'] });
  await ctx.taskChangeControl.bootstrapTask(task.id);
  await assert.rejects(ctx.taskChangeControl.launchReviewer(task.id), (e) => e && e.code === 'SESSION_ID_MISSING');
  assert.equal(terminated, 1);
});

test('reviewer_model as bare name throws REVIEWER_MODEL_MALFORMED', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tcc-t81-real4-'));
  const { ctx, taskStore } = await compose(t, dir);
  const task = await taskStore.create({ title: 'g', description: 'd', status: 'ready', workspace: dir, worker_profile: 'w', reviewer_model: 'bare-no-provider', acceptance_criteria: ['a'] });
  await ctx.taskChangeControl.bootstrapTask(task.id);
  await assert.rejects(
    ctx.taskChangeControl.launchReviewer(task.id),
    (e) => e && e.code === 'REVIEWER_MODEL_MALFORMED',
  );
});
test.rollback = true;

test('setup failure after session.create cancels the session (no orphan)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tcc-t81-real5-'));
  const rpcLog = [];
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, {});
  const store = new TaskStore({ dbPath: join(dir, 'o.db') });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: store.get.bind(store),
    update: store.update.bind(store),
    updateIf: (id, e, p) => store.updateIf(id, e, p),
    complete: store.complete.bind(store),
    createReviewerLauncher: () => createReviewerLauncher({
      rpc: {
        async call(op, args) {
          rpcLog.push({ op, args });
          if (op === 'session.create') return { sessionId: 'sess-will-fail' };
          if (op === 'session.selectModel') throw new Error('model-unavailable');
          if (op === 'session.history') return { events: [] };
          return {};
        },
      },
    }),
  }));
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  await ctx.plugin(plugin);
  const task = await store.create({ title: 'g', description: 'd', status: 'ready', workspace: dir, worker_profile: 'w', reviewer_model: 'x/y', acceptance_criteria: ['a'] });
  await ctx.taskChangeControl.bootstrapTask(task.id);
  await assert.rejects(ctx.taskChangeControl.launchReviewer(task.id));
  assert.ok(rpcLog.some((r) => r.op === 'session.cancel'), 'cancel must be issued');
});
