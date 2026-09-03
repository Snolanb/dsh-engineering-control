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
      const sessionId = handle && typeof handle === 'object' ? handle.sessionId : undefined;
      if (!sessionId) {
        // Session mode but no session materialised → kill + fail closed.
        try { await handle?.terminate?.(); } catch {}
        const err = new Error('session launcher did not return sessionId');
        err.code = 'SESSION_ID_MISSING';
        throw err;
      }
      let change;
      try {
        change = await changeControl.findByWorkItem(WORK_ITEM_SYSTEM, input.task.id);
        if (!change) return handle;
        await changeControl.bindRole(change.id, sessionId, 'worker');
      } catch (error) {
        // On lookup/bind failure, the child session is orphaned. kill before rethrow.
        try { await handle.terminate?.('SIGKILL'); } catch {}
        throw error;
      }
      // Chain-cleanup: whatever consumes wait() gets lifecycle-clean bindings.
      // sessionId is snapshotted once at bind; the returned handle MUST expose
      // the same value we bound — no lazy getter can re-read differently.
      const wait = typeof handle.wait === 'function' ? handle.wait.bind(handle) : null;
      const unbind = async () => {
        try { await changeControl.unbindRole(change.id, sessionId); } catch { /* audited elsewhere */ }
      };
      return {
        ...handle,
        sessionId, // pinned to what we bound
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
