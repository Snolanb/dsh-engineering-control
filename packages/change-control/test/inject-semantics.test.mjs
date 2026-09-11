import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { ChangeStore } from '../src/storage/change-store.js';
import plugin from '../src/index.js';

// Regression: the default plugin export must NOT inject 'commands'.
// A host that exposes nothing but the tool runtime must start successfully,
// and a malformed commands service must fail loudly rather than silently
// registering nothing.

// T-H6: optional host services ('commands') are lifecycle-safe. The plugin
// stays hard-blocked on 'tools' but must tolerate a commands service that is
// absent at startup, appears later, is removed, and is re-added — registering
// the manual /change-* commands exactly once per activation and disposing them
// on removal/unload. No polling: Cordis inject fibers drive activation.

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeCommandRegistry() {
  const definitions = new Set();
  return {
    definitions,
    register(definition) {
      if (typeof definition?.name !== 'string') throw new Error('malformed command definition');
      definitions.add(definition.name);
      return () => definitions.delete(definition.name);
    },
  };
}

async function toolOnlyHost() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-inject-'));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const store = await ChangeStore.open(join(dir, 'changes.json'), {
    preflightPolicy: { requiredChecks: [], protectedPaths: [] },
  });
  const fiber = await ctx.plugin(plugin, {
    store,
    storePath: join(dir, 'changes.json'),
    preflightPolicy: { requiredChecks: [], protectedPaths: [] },
  });
  return {
    ctx,
    fiber,
    cleanup: async () => {
      try { await fiber.dispose(); } catch { /* host teardown best-effort */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("plugin descriptor injects exactly ['tools']", () => {
  assert.deepEqual(plugin.inject, ['tools']);
});

test('starts on a tool-only host (no commands service)', async () => {
  const c = new Context();
  await c.plugin(SystemPrompt);
  await c.plugin(ToolRuntime);
  const fiber = await c.plugin(plugin);
  assert.equal(fiber.state, 2 /* ACTIVE */);
  await fiber.dispose();
});

test('malformed commands service fails loudly', async () => {
  const c = new Context();
  await c.plugin(SystemPrompt);
  await c.plugin(ToolRuntime);
  c.provide('commands', { register: null });
  await assert.rejects(async () => { await c.plugin(plugin); });
});

// ─── T-H6 lifecycle regressions ─────────────────────────────────────────────

test('commands absent at startup: plugin stays active with model tools only', async (t) => {
  const { ctx, fiber, cleanup } = await toolOnlyHost();
  t.after(cleanup);
  assert.equal(fiber.state, 2 /* ACTIVE */, 'missing optional commands never blocks startup');
  assert.notEqual(ctx.tools.get('change_get'), undefined, 'model-facing tools are registered without commands');
});

test('commands service arriving late registers the manual commands', async (t) => {
  const { ctx, cleanup } = await toolOnlyHost();
  t.after(cleanup);
  const registry = makeCommandRegistry();
  const dispose = ctx.provide('commands', registry);
  await tick();
  assert.ok(registry.definitions.has('change-new'), 'late commands service gets change-new');
  assert.ok(registry.definitions.has('change-preflight'), 'late commands service gets change-preflight');
  assert.equal(registry.definitions.size, 8, 'all eight manual commands register exactly once');
  await dispose();
});

test('commands service removal disposes every manual command', async (t) => {
  const { ctx, cleanup } = await toolOnlyHost();
  t.after(cleanup);
  const registry = makeCommandRegistry();
  const dispose = ctx.provide('commands', registry);
  await tick();
  assert.equal(registry.definitions.size, 8);
  await dispose();
  await tick();
  assert.equal(registry.definitions.size, 0, 'removing the commands service disposes all command registrations');
});

test('commands service re-added after removal re-registers exactly once', async (t) => {
  const { ctx, cleanup } = await toolOnlyHost();
  t.after(cleanup);
  const first = makeCommandRegistry();
  const d1 = ctx.provide('commands', first);
  await tick();
  assert.equal(first.definitions.size, 8);
  await d1();
  await tick();
  assert.equal(first.definitions.size, 0);

  const second = makeCommandRegistry();
  const d2 = ctx.provide('commands', second);
  await tick();
  assert.equal(second.definitions.size, 8, 're-added commands service registers all eight commands');
  assert.equal(first.definitions.size, 0, 'the removed registry is never touched again');
  await d2();
});

test('plugin unload disposes commands registered by a late service', async (t) => {
  const { ctx, fiber, cleanup } = await toolOnlyHost();
  t.after(cleanup);
  const registry = makeCommandRegistry();
  ctx.provide('commands', registry);
  await tick();
  assert.equal(registry.definitions.size, 8);
  await fiber.dispose();
  await tick();
  assert.equal(registry.definitions.size, 0, 'plugin teardown releases late command registrations');
});

test('late malformed commands service fails loudly and registers nothing', async (t) => {
  const { ctx, cleanup } = await toolOnlyHost();
  t.after(cleanup);
  const errors = [];
  ctx.logger.exporter({ export: (message) => { if (message.type === 'error') errors.push(...message.args); } });

  const throwingRegistry = { register: () => { throw new Error('commands registry broken'); } };
  const dispose = ctx.provide('commands', throwingRegistry);
  await tick();
  assert.match(String(errors[0]?.message ?? errors[0]), /commands registry broken/,
    'a late commands registration failure is surfaced as a loud fiber error');

  // Recovering with a healthy service still wires the commands (no poisoned half-state).
  await dispose();
  await tick();
  const healthy = makeCommandRegistry();
  const d2 = ctx.provide('commands', healthy);
  await tick();
  assert.equal(healthy.definitions.size, 8, 'a healthy late service after a broken one registers cleanly');
  await d2();
});

test('plugin reload with a commands service present keeps a single registration', async (t) => {
  const { ctx, fiber, cleanup } = await toolOnlyHost();
  t.after(cleanup);
  const registry = makeCommandRegistry();
  ctx.provide('commands', registry);
  await tick();
  assert.equal(registry.definitions.size, 8);

  await fiber.restart();
  await tick();
  assert.equal(registry.definitions.size, 8, 'plugin reload does not duplicate command registrations');
});
