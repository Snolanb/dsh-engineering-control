import { createSessionLauncher } from './dispatcher.js'

/**
 * T8.1 — Reviewer launcher.
 *
 * Launch an independent reviewer session against the same workspaces a
 * worker would see, WITHOUT exercising any claim/lease/ownership code
 * path. Internally delegates to the session launcher; the face is
 * strictly narrower than `createWorkerLauncher` and rejects anything
 * but `mode: 'session'`.
 *
 * @param {{ rpc?: { call: (op: string, args?: any) => Promise<any> },
 *          sessionOptions?: object }} options
 */
export function createReviewerLauncher({ rpc, sessionOptions = {} } = {}) {
  const session = createSessionLauncher(
    rpc ? { ...sessionOptions, rpc } : sessionOptions,
  )
  return {
    /**
     * @param {{ task?: object, spec: { mode: string, agentPreset?: string,
     *   model?: { provider: string, model: string, reasoningEffort?: string } },
     *   runId?: string, requestId?: string,
     *   recordCreated?: (record: { sessionId: string, requestId?: string }) => Promise<void>,
     *   recordSent?: (record: { sessionId: string, requestId?: string }) => Promise<void> }} input
     * @returns {Promise<{ sessionId: string, wait: () => Promise<any>, terminate: () => Promise<boolean> }>}
     */
    launch(input) {
      const mode = input?.spec?.mode
      if (mode !== 'session') {
        const err = new Error(`reviewer launcher only supports session mode (got: ${String(mode)})`)
        // @ts-expect-error - error code annotation for consumers
        err.code = 'REVIEWER_MODE_UNSUPPORTED'
        return Promise.reject(err)
      }
      // T-H12 round-4: the durable request identity and its pre-send /
      // accepted-send markers flow through to the session launcher verbatim.
      return session.launch({
        task: input.task,
        spec: input.spec,
        runId: input.runId,
        requestId: input.requestId,
        recordCreated: input.recordCreated,
        recordSent: input.recordSent,
      })
    },
    /**
     * T-H12 round-5: reattach turn observation to an EXISTING reviewer
     * session (controller restart / cross-process adoption). Passed through
     * from the session launcher; its wait() resolves on turn end and rejects
     * when the session is unreachable — both are dead-turn proof, never
     * review completion.
     */
    observeSession(sessionId, requestId) {
      return session.observeSession(sessionId, requestId)
    },
    /**
     * T-H12 round-4: prove whether the request carrying `requestId` was ever
     * delivered to `sessionId` (host session history). Passed through from the
     * session launcher; 'unsent' when the session is gone or the request was
     * never recorded.
     */
    probeRequest(sessionId, requestId) {
      return session.probeRequest(sessionId, requestId)
    },
  }
}
