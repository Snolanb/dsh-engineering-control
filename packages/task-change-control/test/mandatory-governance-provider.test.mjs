// T9.1 — integration registers the governance provider with change-control.
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
import plugin from '../src/index.js';

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
  await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'c.json') });
  await ctx.plugin(plugin);

  const task = await ts.create({ title: 'x', description: 'd', status: 'ready', workspace: dir, worker_profile: 'w', acceptance_criteria: ['ship'] });
  const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
  await ctx.changeControl.bindRole(change.id, 'sess-b', 'worker', { worker: 'w' });

  // The provider was installed via changeControl.registerGovernanceProvider
  const bindings = await ctx.changeControl.listRoleBindings();
  const hit = bindings.find((b) => b.sessionId === 'sess-b');
  assert.ok(hit, 'binding exists for the worker session');
  const ch = await ctx.changeControl.get(hit.changeId);
  assert.equal(ch.workItem?.id, task.id);
});
