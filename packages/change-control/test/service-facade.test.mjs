import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import plugin from '../src/index.js';

// The integration contract: ctx.changeControl exposes the full semantic
// operation surface; ctx.changeStore is gone (no external consumers existed;
// in-package fixtures share the store through the config.store seam).

const OPS = [
  'create', 'get', 'submitPlan', 'acceptPlan', 'bindRole', 'unbindRole',
  'resolveRole', 'submitProof', 'runPreflight', 'submitReview',
  'submitRepair', 'history', 'status', 'setRisk',
  'findByWorkItem', 'findOrCreateForWorkItem',
];

async function host(t) {
  const dir = await mkdtemp(join(tmpdir(), 'service-facade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(plugin, { storePath: join(dir, 'changes.json') });
  return ctx;
}

test('changeControl service exposes exactly the facade operations', async (t) => {
  const ctx = await host(t);
  const service = ctx.get('changeControl');
  for (const op of OPS) assert.equal(typeof service[op], 'function', `missing ${op}`);
  assert.equal(typeof service.findByWorkItem, 'function', 'work-item linkage ops are part of the facade (Phase 3 / T3.1)');
});

test('changeStore is no longer provided', async (t) => {
  const ctx = await host(t);
  assert.equal(ctx.get('changeStore'), undefined);
});

test('service round-trip: create/get/history/status and role bindings', async (t) => {
  const ctx = await host(t);
  const svc = ctx.get('changeControl');
  const change = await svc.create({ title: 'facade', objective: 'exercise service', acceptanceCriteria: ['ok'] });
  assert.equal(change.state, 'DRAFT');
  assert.deepEqual((await svc.get(change.id)).id, change.id);
  await svc.bindRole(change.id, 'planner-a', 'planner');
  assert.equal(await svc.resolveRole(change.id, 'planner-a'), 'planner');
  const plan = await svc.submitPlan(change.id, { steps: ['x'] });
  await svc.acceptPlan(change.id, plan.id, { authorized: true, actor: 'host' });
  await svc.unbindRole(change.id, 'planner-a');
  assert.rejects(svc.resolveRole(change.id, 'planner-a'));
  const status = await svc.status(change.id);
  assert.equal(status.id, change.id);
  assert.ok(Array.isArray(status.bindings));
  const history = await svc.history(change.id);
  assert.ok(history.length > 0);
});
