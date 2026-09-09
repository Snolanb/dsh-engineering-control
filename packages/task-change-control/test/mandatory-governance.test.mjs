// Regression: the mandatory-governance provider MUST resolve the canonical
// WORK_ITEM_SYSTEM identity so a fully-bound worker can mutate when required
// mode is on. This test crosses the REAL boundary end to end using only the
// public package seams (no cross-package store/internal imports):
//   Task Orchestrator (real TaskStore) → task-change-control plugin bootstrap
//   (which registers the provider through the change-control facade) →
//   changeControl (ChangeStore persisted on disk) →
//   mandatory tools/pre-execute gate (filesystem-policy).
//
// The historical defect compared the Change-side workItem.system against the
// literal 'task-orchestrator' instead of the canonical 'dsh-task-orchestrator',
// so provider.lookup returned taskId=null and every bound worker was denied
// with CHANGE_CONTROL_REQUIRED even in IMPLEMENTING/REPAIR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import changeControlPlugin from 'dsh-change-control';
import { WORK_ITEM_SYSTEM, createMandatoryGovernanceProvider } from '../src/index.js';
import integrationPlugin from '../src/index.js';

async function compose(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tcc-mgreal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);

  // Real Task Orchestrator store + service facade (same shape the host wires).
  const taskStore = new TaskStore({ dbPath: join(dir, 'tasks.db') });
  ctx.provide('taskOrchestrator', Object.freeze({
    get: taskStore.get.bind(taskStore),
    update: taskStore.update.bind(taskStore),
    updateIf: (i, e, q) => taskStore.updateIf(i, e, q),
    complete: taskStore.complete.bind(taskStore),
  }));

  // Real change-control plugin with its OWN persisted ChangeStore on disk.
  // The mandatory gate and the provider the integration plugin registers
  // share that store internally behind the public facade.
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });

  // Install the integration plugin: bootstraps linkage AND registers the
  // REAL governance provider with change-control (production code path the
  // mandatory gate consumes).
  await ctx.plugin(integrationPlugin);

  // Build a matching provider against the same public facades for direct
  // context assertions below. Do not register this second instance: the
  // mandatory gate must consume the provider registered by the integration
  // plugin above, proving the production registration path.
  const provider = createMandatoryGovernanceProvider({
    taskOrchestrator: () => ctx.get('taskOrchestrator'),
    changeControl: () => ctx.get('changeControl'),
  });

  // A real mutating tool name (not in the read-only allow-list) so the
  // mandatory gate must actually authorize it.
  const registry = ctx.get('tools');
  registry.register(defineTool({
    name: 'mutator',
    description: 'fake mutating tool',
    parameters: { data: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
    execute: async () => ({ content: [{ type: 'text', text: 'MUTATED' }] }),
  }));

  return { ctx, dir, taskStore, registry, provider };
}

function execTool(registry, name, sessionId, args = {}) {
  return registry.execute({
    callId: `call-${Math.random().toString(36).slice(2)}`,
    name,
    arguments: args,
    agent: { id: sessionId },
    signal: new AbortController().signal,
  });
}

const asText = (res) => JSON.stringify(res?.content ?? res ?? null);

/**
 * Drive the freshly bootstrapped Change (DRAFT) to a worker-mutable state via
 * legal domain transitions only.
 */
async function moveChangeTo(ctx, change, state) {
  const path = ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW', 'REPAIR'];
  for (const next of path.slice(0, path.indexOf(state) + 1)) {
    await ctx.changeControl.transition(change.id, next, {});
  }
}

for (const state of ['IMPLEMENTING', 'REPAIR']) {
  test(`real boundary: bound worker in ${state} mutates through the mandatory gate`, async (t) => {
    const { ctx, taskStore, registry, provider, dir } = await compose(t);

    // 1. Real Task Orchestrator task bootstrapped through the REAL
    //    integration service (Change persisted on disk with canonical link).
    const task = await taskStore.create({
      title: 'governed', description: 'd', status: 'ready', workspace: dir,
      worker_profile: 'worker', acceptance_criteria: ['a'],
    });
    const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
    assert.equal(change.workItem?.system, WORK_ITEM_SYSTEM, 'Change-side workItem uses canonical system');

    // 2. Bind a REAL worker session identity to the resulting Change.
    await ctx.changeControl.bindRole(change.id, 'sess-worker', 'worker', { worker: 'w' });

    // 3. Walk the Change into the worker-mutable state under test.
    await moveChangeTo(ctx, change, state);
    assert.equal((await ctx.changeControl.get(change.id)).state, state);

    // 4. required governance mode.
    await ctx.changeControl.setGovernanceMode({ workspace: dir, mode: 'required' });

    // 5. The REAL provider resolves the exact governed-task context.
    const taskCtx = await provider.lookup({ sessionId: 'sess-worker' });
    assert.ok(taskCtx, 'provider resolves the bound session');
    assert.equal(taskCtx.changeId, change.id, 'provider returns the changeId');
    assert.equal(taskCtx.taskId, task.id, 'provider returns the canonical taskId');
    assert.equal(taskCtx.taskStatus, 'ready', 'provider returns the task status');
    assert.equal(taskCtx.role, 'worker', 'provider returns the worker role');
    assert.equal(await provider.lookup({ sessionId: 'sess-unknown' }), null, 'unknown session → null');

    // 6. Through the REAL pre-execute gate: the bound worker's permitted
    //    mutating call is authorized. If the provider still compared against
    //    'task-orchestrator', taskId resolves null and this is denied
    //    CHANGE_CONTROL_REQUIRED.
    const out = await execTool(registry, 'mutator', 'sess-worker', { workspace: dir });
    assert.notEqual(out.isError, true, `bound worker must mutate in ${state}; got ${asText(out)}`);
    assert.match(asText(out), /MUTATED/);
  });
}

test('real boundary: unknown/unbound session is denied in required mode', async (t) => {
  const { ctx, taskStore, registry, dir } = await compose(t);

  const task = await taskStore.create({
    title: 'governed', description: 'd', status: 'ready', workspace: dir,
    worker_profile: 'worker', acceptance_criteria: ['a'],
  });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  await ctx.changeControl.bindRole(change.id, 'sess-worker', 'worker', { worker: 'w' });
  await moveChangeTo(ctx, change, 'IMPLEMENTING');
  await ctx.changeControl.setGovernanceMode({ workspace: dir, mode: 'required' });

  // No binding for this session: the provider resolves null and the gate denies.
  const out = await execTool(registry, 'mutator', 'sess-unknown', { workspace: dir });
  assert.ok(out.isError === true || /CHANGE_CONTROL_REQUIRED/.test(asText(out)),
    `unknown session must be denied; got ${asText(out)}`);
});
