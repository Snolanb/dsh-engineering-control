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
        await changeControl.bindRole(change.id, sessionId, 'worker', {
          worker: input.worker ?? input.runId ?? null,
        });
      } catch (error) {
        // On lookup/bind failure, the child session is orphaned. kill before rethrow.
        try { await handle.terminate?.('SIGKILL'); } catch {}
        throw error;
      }
      // sessionId and worker are snapshotted at bind; the returned handle MUST
      // use those identities for all later cleanup. A replacement dispatch that
      // reuses a session ID must not be unbound by an older handle.
      const wait = typeof handle.wait === 'function' ? handle.wait.bind(handle) : null;
      const expectedWorker = input.worker ?? input.runId ?? null;
      let cleanupPromise = null;
      const unbind = () => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
          // Read the binding before removing it. If this session was rebound
          // to another worker, the old handle has lost ownership of cleanup.
          if (expectedWorker !== null
            && (typeof changeControl.getBindingFromDisk === 'function'
              || typeof changeControl.getBindingSync === 'function'
              || typeof changeControl.getBinding === 'function')) {
            let current;
            try {
              current = typeof changeControl.getBindingFromDisk === 'function'
                ? changeControl.getBindingFromDisk(change.id, sessionId)
                : typeof changeControl.getBindingSync === 'function'
                  ? changeControl.getBindingSync(change.id, sessionId)
                  : await changeControl.getBinding(change.id, sessionId);
            } catch {
              // Fail closed: an unknown binding must not be removed by a stale
              // attempt. Reconciliation can retry once the store is readable.
              return;
            }
            if (!current || current.role !== 'worker' || current.worker !== expectedWorker) return;
          }
          try { await changeControl.unbindRole(change.id, sessionId); } catch { /* audited elsewhere */ }
        })();
        return cleanupPromise;
      };
      // Governed completion holds the worker binding after wait() resolves so
      // completeGovernedTask can validate the actual session identity. Cleanup
      // remains a single promise: release, timeout, and explicit termination
      // are safe to race and safe to repeat.
      let governedHold = false;
      return {
        ...handle,
        sessionId, // pinned to what we bound
        pid: handle.pid ?? null,
        wait: wait
          ? async () => { try { return await wait(); } finally { if (!governedHold) await unbind(); } }
          : undefined,
        terminate: async (signal) => {
          // Termination is always abnormal. Do not retain the governed hold;
          // timeout, lease loss, and operator kill all clean immediately.
          governedHold = false;
          try { return await (handle.terminate?.(signal) ?? true); } finally { await unbind(); }
        },
        // Called BEFORE waiting so governed completion can still read the
        // worker binding; called AFTER completion to remove it.
        _governedHold: () => { governedHold = true; },
        _governedRelease: async () => { governedHold = false; await unbind(); },
      };
    },
  };
}
