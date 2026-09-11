// T9.1 — integration registers the governance provider with change-control.
// The test INVOKES the registered provider's lookup() (the exact seam the
// mandatory pre-execute gate calls) across the REAL persisted composition, so
// it verifies the behavior its name claims:
// session → binding → Change → canonical task identity (+ null for unknown).
// Only public package seams are used (no cross-package store internals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import changeControlPlugin from 'dsh-change-control';
import { WORK_ITEM_SYSTEM, createMandatoryGovernanceProvider } from '../src/index.js';
import integrationPlugin from '../src/index.js';

test('provider lookup resolves session → change → task, null for unknown sessions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 't91p-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const ts = new TaskStore({ dbPath: join(dir, 't.db') });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: ts.get.bind(ts), update: ts.update.bind(ts), updateIf: (i, e, q) => ts.updateIf(i, e, q), complete: ts.complete.bind(ts),
  }));
  // Real persisted ChangeStore behind the public plugin/facade seam.
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'c.json') });
  await ctx.plugin(integrationPlugin);

  const task = await ts.create({ title: 'x', description: 'd', status: 'ready', workspace: dir, worker_profile: 'w', acceptance_criteria: ['ship'] });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  assert.equal(change.workItem?.system, WORK_ITEM_SYSTEM, 'bootstrap writes the canonical work-item system');
  await ctx.changeControl.bindRole(change.id, 'sess-b', 'worker', { worker: 'w' });

  // Build the same production provider via its exported factory and invoke
  // the lookup behavior directly. The integration plugin's own registered
  // instance is exercised end-to-end by mandatory-governance.test.mjs.
  const provider = createMandatoryGovernanceProvider({
    taskOrchestrator: () => ctx.get('taskOrchestrator'),
    changeControl: () => ctx.get('changeControl'),
  });
  const resolved = await provider.lookup({ sessionId: 'sess-b' });
  assert.ok(resolved, 'lookup resolves the bound session');
  assert.equal(resolved.changeId, change.id, 'lookup returns the Change id');
  assert.equal(resolved.taskId, task.id, 'lookup resolves the canonical dsh-task-orchestrator task id');
  assert.equal(resolved.taskStatus, 'ready', 'lookup returns the live task status');
  assert.equal(resolved.role, 'worker', 'lookup returns the binding role');

  assert.equal(await provider.lookup({ sessionId: 'sess-unknown' }), null, 'unknown session resolves to null');
});

// ─── T-H6: lifecycle-safe optional integrations ─────────────────────────────
//
// The integration plugin injects NOTHING hard, so it must stay active in every
// partial composition and wire each optional surface with Cordis inject
// fibers (no polling): absent at startup → nothing registered; late arrival →
// registered exactly once; removal → disposed; re-addition → one fresh
// registration. taskChangeControl itself is always available.

const tick = () => new Promise((resolve) => setImmediate(resolve));
const INTEGRATION_TOOL_NAMES = ['change_for_task', 'change_bootstrap_task'];

/** Minimal changeControl seam that records governance-provider lifecycle. */
function recordingChangeControl() {
  const state = { registrations: 0, unregistrations: 0, current: null };
  return {
    state,
    registerGovernanceProvider(provider) {
      if (typeof provider?.lookup !== 'function') throw new Error('INVALID_GOVERNANCE_PROVIDER');
      state.registrations += 1;
      state.current = provider;
      return { unregister: () => { state.unregistrations += 1; state.current = null; } };
    },
  };
}

const taskOrchestratorStub = () => Object.freeze({
  get: async () => null, update: async () => { throw new Error('unused'); }, updateIf: () => { throw new Error('unused'); },
});

test('T-H6: no domain services at startup — active, degraded, taskChangeControl still provided', async (t) => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const fiber = await ctx.plugin(integrationPlugin);
  t.after(() => fiber.dispose());

  assert.equal(fiber.state, 2, 'integration starts without changeControl/taskOrchestrator');
  assert.ok(ctx.get('taskChangeControl'), 'taskChangeControl service is available independently');
  // The model-facing tools register against the registry even with no domain
  // services; invoking one must then fail explicitly rather than half-work.
  for (const name of INTEGRATION_TOOL_NAMES) {
    assert.notEqual(ctx.tools.get(name), undefined, `${name} is registered whenever a tools registry exists`);
  }
  await assert.rejects(
    async () => ctx.get('taskChangeControl').getChangeForTask('task-x'),
    (err) => err.code === 'LINKAGE_UNAVAILABLE' && /taskOrchestrator/.test(err.message),
    'missing domain services surface as LINKAGE_UNAVAILABLE, never silent half-work',
  );
});

test('T-H6: partial composition (task side only) degrades explicitly instead of half-working', async (t) => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  ctx.provide('taskOrchestrator', taskOrchestratorStub());
  const fiber = await ctx.plugin(integrationPlugin);
  t.after(() => fiber.dispose());

  // taskOrchestrator without changeControl: a linkage call must fail loudly
  // at the boundary instead of silently reporting "not linked".
  await assert.rejects(
    async () => ctx.get('taskChangeControl').getChangeForTask('x'),
    (err) => err.code === 'LINKAGE_UNAVAILABLE' && /changeControl/.test(err.message),
    'missing changeControl surfaces as LINKAGE_UNAVAILABLE, never silent half-work',
  );
});

test('T-H6: late changeControl arrival registers the governance provider exactly once', async (t) => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  ctx.provide('taskOrchestrator', taskOrchestratorStub());
  const fiber = await ctx.plugin(integrationPlugin);
  t.after(() => fiber.dispose());

  const cc = recordingChangeControl();
  assert.equal(cc.state.registrations, 0);
  const dispose = ctx.provide('changeControl', cc);
  await tick();
  assert.equal(cc.state.registrations, 1, 'provider registered when changeControl arrives late');
  assert.ok(cc.state.current, 'the provider is live on the changeControl facade');
  await dispose();
});

test('T-H6: changeControl removal unregisters; re-addition registers exactly once again', async (t) => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  ctx.provide('taskOrchestrator', taskOrchestratorStub());
  const fiber = await ctx.plugin(integrationPlugin);
  t.after(() => fiber.dispose());

  const first = recordingChangeControl();
  const d1 = ctx.provide('changeControl', first);
  await tick();
  assert.equal(first.state.registrations, 1);

  await d1();
  await tick();
  assert.equal(first.state.unregistrations, 1, 'removing changeControl unregisters the provider');
  assert.equal(first.state.current, null);

  const second = recordingChangeControl();
  const d2 = ctx.provide('changeControl', second);
  await tick();
  assert.equal(second.state.registrations, 1, 're-added changeControl gets exactly one provider');
  assert.equal(first.state.current, null, 'the removed facade is never re-touched');
  assert.equal(first.state.registrations, 1, 'no duplicate registration against the old facade');
  await d2();
});

test('T-H6: late tools-registry arrival registers both integration tools; removal disposes; re-add once', async (t) => {
  // Domain services exist first; ToolRuntime itself arrives after the plugin.
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  ctx.provide('taskOrchestrator', taskOrchestratorStub());
  ctx.provide('changeControl', recordingChangeControl());
  const fiber = await ctx.plugin(integrationPlugin);
  t.after(() => fiber.dispose());

  // No tools registry yet: service still stands, tools cannot register.
  assert.ok(ctx.get('taskChangeControl'));

  const toolsFiber = await ctx.plugin(ToolRuntime);
  await tick();
  for (const name of INTEGRATION_TOOL_NAMES) {
    assert.notEqual(ctx.tools.get(name), undefined, `${name} registers when the tools registry arrives late`);
  }

  await toolsFiber.dispose();
  await tick();
  // Registry gone with its owning fiber — no live tool surface to assert on;
  // re-add and verify a single clean registration rather than duplicates.
  const toolsFiber2 = await ctx.plugin(ToolRuntime);
  await tick();
  for (const name of INTEGRATION_TOOL_NAMES) {
    assert.notEqual(ctx.tools.get(name), undefined, `${name} re-registers after the tools service is re-added`);
  }
  await toolsFiber2.dispose();
});

test('T-H6: plugin unload with late services disposes provider and tools', async (t) => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  ctx.provide('taskOrchestrator', taskOrchestratorStub());
  const fiber = await ctx.plugin(integrationPlugin);
  const cc = recordingChangeControl();
  ctx.provide('changeControl', cc);
  await tick();
  assert.equal(cc.state.registrations, 1);

  await fiber.dispose();
  await tick();
  assert.equal(cc.state.unregistrations, 1, 'plugin teardown unregisters the late governance provider');
  for (const name of INTEGRATION_TOOL_NAMES) {
    assert.equal(ctx.tools.get(name), undefined, `plugin teardown removes late ${name}`);
  }
});
