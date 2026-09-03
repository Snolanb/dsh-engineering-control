// @ts-nocheck
/**
 * T6.1 — Worker session binding lives in the DISPATCH CONTROLLER: the
 * integration package wraps the launcher the dispatcher uses. Every session
 * launch thread: launcher returns handle with the real sessionId →
 * `changeControl.bindRole(changeId, sessionId, 'worker')` runs immediately.
 * When the run settles — success, failure, lease expiry (the dispatcher
 * terminates the handle), operator kill — the unbind fires in `wait`'s
 * finally. No model-facing tool can self-bind; the registration surface
 * remains unbound by design.
 *
 * Only session-mode dispatchers have a sessionId; headless ones skip the
 * hook entirely (no session to bind, governed-only semantics preserved).
 */

/**
 * Wrap a launcher: bind returned sessionId as worker role, unbind on settle.
 * @param {object} launcher
 * @param {object} changeControl
 * @param {string} WORK_ITEM_SYSTEM
 * @returns a launcher honoring the same contract
 */
export function createBindingLauncher(launcher, changeControl, WORK_ITEM_SYSTEM) {
  return {
    async launch(input) {
      const handle = await launcher.launch(input);
      if (input?.spec?.mode !== 'session') return handle; // headless: never bind
      if (!handle || typeof handle !== 'object' || !handle.sessionId) {
        // Session mode but the launcher produced no sessionId → fail closed,
        // terminating whatever leaked so nothing surfaces unbound.
        try { await handle?.terminate?.(); } catch {}
        throw new Error('session launcher did not return sessionId');
      }
      let change;
      try {
        // Task → Change resolution via the canonical Change-side path.
        change = await changeControl.findByWorkItem(WORK_ITEM_SYSTEM, input.task.id);
        if (!change) return handle; // ungoverned: nothing to bind
        await changeControl.bindRole(change.id, handle.sessionId, 'worker');
      } catch (error) {
        // On lookup/bind failure, the child session is orphaned. kill before rethrow.
        try { await handle.terminate?.('SIGKILL'); } catch {}
        throw error;
      }
      // Chain-cleanup: whatever consumes wait() gets lifecycle-clean bindings.
      const wait = typeof handle.wait === 'function' ? handle.wait.bind(handle) : null;
      const unbind = async () => {
        try { await changeControl.unbindRole(change.id, handle.sessionId); } catch { /* record externally */ }
      };
      return {
        ...handle,
        sessionId: handle.sessionId,
        pid: handle.pid ?? null,
        wait: wait
          ? async () => { try { return await wait(); } finally { await unbind(); } }
          : undefined,
        terminate: async (signal) => {
          try { return await (handle.terminate?.(signal) ?? true); } finally { await unbind(); }
        },
      };
    },
  };
}
