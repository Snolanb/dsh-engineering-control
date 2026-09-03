// T9.1 — mandatory governance enforcement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import changeControlPlugin from '../src/index.js';

// ── fixtures ──────────────────────────────────────────────────────────────

async function compose(t, { registerProvider = 'none', policy = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 't91-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json'), ...(policy ? { policy } : {}) });
  if (registerProvider !== 'none') {
    await ctx.changeControl.registerGovernanceProvider(
      registerProvider === 'good'
        ? { lookup: async ({ sessionId }) => (sessionId.startsWith('sess-gov-') ? { taskId: 'task-x', taskStatus: 'running' } : null) }
        : registerProvider,
    );
  }
  return { ctx, dir, registry: ctx.get('tools') };
}

function registerFakeTools(registry) {
  registry.register(defineTool({
    name: 'mutator',
    description: 'fake mutating tool',
    parameters: { data: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
    execute: async () => ({ content: [{ type: 'text', text: 'MUTATED' }] }),
  }));
  registry.register(defineTool({
    name: 'reader',
    description: 'fake read-only tool',
    parameters: { data: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
    execute: async () => ({ content: [{ type: 'text', text: 'READ' }] }),
  }));
}

async function execTool(registry, name, sessionId, args = {}) {
  return registry.execute({
    callId: `call-${Math.random().toString(36).slice(2)}`,
    name,
    arguments: args,
    agent: { id: sessionId },
    signal: new AbortController().signal,
  });
}

const asText = (res) => JSON.stringify(res?.content ?? res ?? null);

// ── shape, precedence and persistence ─────────────────────────────────────

test('setGovernanceMode persists + precedence workspace > project > default', async (t) => {
  const { ctx, dir } = await compose(t);
  await ctx.changeControl.setGovernanceMode({ projectId: 'proj-A', mode: 'required' });
  await ctx.changeControl.setGovernanceMode({ workspace: '/data/ws-comfortable', mode: 'optional' });
  await ctx.changeControl.setGovernanceMode({ workspace: '/data/ws-required', mode: 'required' });

  assert.equal(await ctx.changeControl.getGovernanceMode({ projectId: 'proj-A' }), 'required');
  assert.equal(await ctx.changeControl.getGovernanceMode({ workspace: '/data/ws-comfortable' }), 'optional');
  assert.equal(await ctx.changeControl.getGovernanceMode({ projectId: 'proj-A', workspace: '/data/ws-comfortable' }), 'optional', 'workspace beats project');
  assert.equal(await ctx.changeControl.getGovernanceMode({}), 'off', 'default off');


  // Restart persisted.
  const ctx2 = new Context();
  await ctx2.plugin(SystemPrompt);
  await ctx2.plugin(ToolRuntime);
  await ctx2.plugin(changeControlPlugin, { storePath: join(dir, 'changes.json') });
  assert.equal(await ctx2.changeControl.getGovernanceMode({ projectId: 'proj-A' }), 'required');
  assert.equal(await ctx2.changeControl.getGovernanceMode({}), 'off');
});

test('setGovernanceMode rejects unknown modes and malformed keys', async (t) => {
  const { ctx } = await compose(t);
  await assert.rejects(
    ctx.changeControl.setGovernanceMode({ projectId: 'x', mode: 'weird' }),
    (e) => e.code === 'INVALID_GOVERNANCE_MODE',
  );
  await assert.rejects(
    ctx.changeControl.setGovernanceMode({ workspace: 42, mode: 'required' }),
    (e) => e.code === 'INVALID_GOVERNANCE_MODE' || e.code === 'INVALID_GOVERNANCE_KEY',
  );
});

// ── mode = off: byte-identical behavior (audit surface covered too) ───────

test('mode=off: no extra audit events are emitted for tool calls', async (t) => {
  const { ctx, registry } = await compose(t);
  registerFakeTools(registry);
  await execTool(registry, 'mutator', 'sess-x');
  const change = await ctx.changeControl.create({ title: 'audit-shape' });
  const before = await ctx.changeControl.history(change.id);
  await execTool(registry, 'mutator', 'sess-x');
  await execTool(registry, 'reader', 'sess-x');
  const after = await ctx.changeControl.history(change.id);
  assert.deepEqual(
    after.map((e) => ({ type: e.type, reason: e.reason ?? null })),
    before.map((e) => ({ type: e.type, reason: e.reason ?? null })),
    'mode=off must not add audit entries on tool execution',
  );
});

test('mode=off: full baseline suite unchanged (cat-green-copy)', async (t) => {
  const { ctx, registry } = await compose(t);
  registerFakeTools(registry);
  const change = await ctx.changeControl.create({ title: 'x' });
  await ctx.changeControl.transition(change.id, 'PLANNED', {});
  await ctx.changeControl.transition(change.id, 'READY', {});
  await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
  assert.equal((await ctx.changeControl.get(change.id)).state, 'IMPLEMENTING');
});

// ── required mode enforcement ─────────────────────────────────────────────

test('required + NO provider → deny mutating (fail-closed absent integration)', async (t) => {
  const { ctx, registry } = await compose(t, { registerProvider: 'none' });
  registerFakeTools(registry);
  await ctx.changeControl.setGovernanceMode({ projectId: 'proj-A', mode: 'required' });
  const out = await execTool(registry, 'mutator', 'sess-rogue', { projectId: 'proj-A' });
  const txt = asText(out);
  assert.ok(out.isError === true || out.blocked === true || /CHANGE_CONTROL_REQUIRED|GOVERNANCE_PROVIDER_MISSING/.test(txt),
    `expected denial; got ${txt}`);
  assert.match(txt, /GOVERNANCE_PROVIDER_MISSING|CHANGE_CONTROL_REQUIRED/);
});

test('required + bound session NOT associated with a governed task: denied', async (t) => {
  const { ctx, registry } = await compose(t, { registerProvider: 'good' });
  registerFakeTools(registry);
  await ctx.changeControl.setGovernanceMode({ projectId: 'proj-A', mode: 'required' });
  const out = await execTool(registry, 'mutator', 'sess-rogue', { projectId: 'proj-A' });
  assert.ok(out.isError === true || /CHANGE_CONTROL_REQUIRED/.test(asText(out)));
  assert.match(asText(out), /CHANGE_CONTROL_REQUIRED/);
});

test('required: planner/reviewer remain read-only (role confusion)', async (t) => {
  const { ctx, registry } = await compose(t, { registerProvider: 'good', policy: { enabled: true, owner: 'host', projectId: 'proj-A' } });
  registerFakeTools(registry);
  await ctx.changeControl.setGovernanceMode({ projectId: 'proj-A', mode: 'required' });
  const change = await ctx.changeControl.create({ title: 'x', workItem: { system: 'task-orchestrator', id: 'task-r' } });
  await ctx.changeControl.transition(change.id, 'PLANNED', {});
  await ctx.changeControl.transition(change.id, 'READY', {});
  await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
  await ctx.changeControl.bindRole(change.id, 'sess-gov-plan', 'planner');
  const out = await execTool(registry, 'mutator', 'sess-gov-plan', { changeId: change.id });
  assert.ok(out.isError === true || /ROLE_READ_ONLY|not authorized/i.test(asText(out)));
  assert.match(asText(out), /ROLE_READ_ONLY|read-only|RISK_NOT_EXPLICIT|no explicit effective risk/i);
});

test('required: Change state blocks worker mutation outside IMPLEMENTING/REPAIR', async (t) => {
  const { ctx, registry } = await compose(t, { registerProvider: 'good', policy: { enabled: true, owner: 'host', projectId: 'proj-A' } });
  registerFakeTools(registry);
  await ctx.changeControl.setGovernanceMode({ projectId: 'proj-A', mode: 'required' });
  const change = await ctx.changeControl.create({ title: 'x', workItem: { system: 'task-orchestrator', id: 'task-s' } });
  await ctx.changeControl.bindRole(change.id, 'sess-gov-wride', 'worker');
  const out = await execTool(registry, 'mutator', 'sess-gov-wride', { changeId: change.id });
  assert.ok(out.isError === true || /STATE_NOT_ALLOWED|CHANGE_CONTROL_REQUIRED/.test(asText(out)));
});

test('required: legitimate bound worker in IMPLEMENTING can mutate', async (t) => {
  const { ctx, registry } = await compose(t, { registerProvider: 'good', policy: { enabled: true, owner: 'host', projectId: 'proj-A' } });
  registerFakeTools(registry);
  await ctx.changeControl.setGovernanceMode({ projectId: 'proj-A', mode: 'required' });
  const change = await ctx.changeControl.create({ title: 'x', workItem: { system: 'task-orchestrator', id: 'task-ok' } });
  await ctx.changeControl.transition(change.id, 'PLANNED', {});
  await ctx.changeControl.transition(change.id, 'READY', {});
  await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
  await ctx.changeControl.setRisk(change.id, 'low');
  await ctx.changeControl.bindRole(change.id, 'sess-gov-w', 'worker', { worker: 'w' });
  const out = await execTool(registry, 'mutator', 'sess-gov-w', { changeId: change.id });
  assert.notEqual(out.isError, true, `should allow: ${asText(out)}`);
});

// ── read-only is NEVER denied by the mandatory gate ───────────────────────

test('read-only tools always allowed in required mode (even without binding)', async (t) => {
  const { ctx, registry } = await compose(t, { registerProvider: 'good' });
  registerFakeTools(registry);
  await ctx.changeControl.setGovernanceMode({ projectId: 'proj-A', mode: 'required' });
  const r1 = await execTool(registry, 'reader', 'sess-any', { projectId: 'proj-A' });
  assert.notEqual(r1.isError, true, `reader must pass, got ${asText(r1)}`);
  const r2 = await execTool(registry, 'reader', 'sess-any', { path: '/tmp/nope' });
  assert.notEqual(r2.isError, true);
});
