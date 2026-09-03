import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewerLauncher } from '../src/reviewer-launcher.js';

function makeFakeRpc() {
  const calls = [];
  return {
    calls,
    rpc: {
      async call(op, args) {
        calls.push({ op, args });
        if (op === 'session.create') return { sessionId: 'sess-reviewer-1' };
        if (op === 'session.history') return { events: [] };
        return {};
      },
    },
  };
}

test('reviewer launcher rejects headless mode', async () => {
  const { rpc } = makeFakeRpc();
  const launcher = createReviewerLauncher({ rpc });
  await assert.rejects(
    launcher.launch({ spec: { mode: 'headless', command: 'x' } }),
    (e) => e && e.code === 'REVIEWER_MODE_UNSUPPORTED',
  );
});

test('reviewer launcher launches a session without touching any store/claim surface', async () => {
  const { rpc, calls } = makeFakeRpc();
  const launcher = createReviewerLauncher({ rpc });
  const handle = await launcher.launch({
    task: { id: 't1', title: 't', description: 'd', workspace: '/tmp/x' },
    spec: {
      mode: 'session',
      agentPreset: 'reviewer',
      model: { provider: 'p', model: 'm' },
      prompt: 'review it',
    },
    runId: 'run-rv-1',
  });
  assert.equal(handle.sessionId, 'sess-reviewer-1');
  // Proof of no claim semantics: the launcher never issued any op against
  // a task store — only session.* RPC calls exist.
  for (const c of calls) assert.ok(c.op.startsWith('session.'), `unexpected op: ${c.op}`);
  await handle.terminate();
});
