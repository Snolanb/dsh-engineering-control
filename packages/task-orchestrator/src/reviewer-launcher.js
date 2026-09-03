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
     *   runId?: string }} input
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
      return session.launch({
        task: input.task,
        spec: input.spec,
        runId: input.runId,
      })
    },
  }
}
