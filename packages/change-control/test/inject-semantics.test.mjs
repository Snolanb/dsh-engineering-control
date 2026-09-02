import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import plugin from '../src/index.js';

// Regression: the default plugin export must NOT inject 'commands'.
// A host that exposes nothing but the tool runtime must start successfully,
// and a malformed commands service must fail loudly rather than silently
// registering nothing.

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
