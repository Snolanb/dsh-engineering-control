import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { preflightWorker as runPreflight } from './worker-preflight.js'

const DEFAULT_OUTPUT_LIMIT = 16 * 1024

function clip(value, limit = DEFAULT_OUTPUT_LIMIT) {
  const text = value === undefined || value === null ? '' : String(value)
  return text.length <= limit ? text : text.slice(0, limit) + '\n[output clipped]'
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

export class WorkerDispatchError extends Error {
  constructor(message, code = 'WORKER_DISPATCH_FAILED', details = {}) {
    super(message)
    this.name = 'WorkerDispatchError'
    this.code = code
    this.details = details
  }
}

export function buildTaskPrompt(task, spec, runId) {
  const criteria = Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length > 0
    ? task.acceptance_criteria.map((item, index) => (index + 1) + '. ' + item).join('\n')
    : '(none supplied)'
  return [
    'You are worker ' + spec.name + ' for dispatch run ' + runId + '.',
    'Work only on task ' + task.id + ' in the pinned workspace below.',
    '',
    'Workspace: ' + (task.workspace ?? '(missing)'),
    'Title: ' + task.title,
    'Description:',
    task.description || '(none supplied)',
    '',
    'Acceptance criteria:',
    criteria,
    '',
    'Restrictions:',
    '- Do not modify unrelated files or tasks.',
    '- Do not create GitHub issues or pull requests unless the task explicitly requests it.',
    '- Run the required tests before reporting completion.',
    '- Report blockers instead of hiding them in prose.',
  ].join('\n')
}

function appendOutput(state, key, chunk) {
  if (state[key].length >= state.limit) return
  state[key] += String(chunk)
  if (state[key].length > state.limit) state[key] = state[key].slice(0, state.limit)
}

function processHandle(child, outputLimit) {
  const state = { stdout: '', stderr: '', limit: outputLimit }
  child.stdout?.on('data', chunk => appendOutput(state, 'stdout', chunk))
  child.stderr?.on('data', chunk => appendOutput(state, 'stderr', chunk))
  let exited = false
  let exitCode = null
  let signal = null
  const wait = new Promise(resolve => {
    child.once('error', error => {
      if (exited) return
      exited = true
      resolve({ exitCode: null, signal: null, stdout: clip(state.stdout, outputLimit), stderr: clip(errorText(error) + (state.stderr ? '\n' + state.stderr : ''), outputLimit), error: errorText(error) })
    })
    child.once('close', (code, closedSignal) => {
      if (exited) return
      exited = true
      exitCode = code
      signal = closedSignal
      resolve({ exitCode, signal, stdout: clip(state.stdout, outputLimit), stderr: clip(state.stderr, outputLimit) })
    })
  })
  return {
    pid: child.pid ?? null,
    wait: () => wait,
    async terminate(signalName = 'SIGTERM') {
      if (exited || child.killed) return false
      return Boolean(child.kill(signalName))
    },
  }
}

export function createHeadlessProcessLauncher({ spawnImpl = nodeSpawn, env = process.env, outputLimit = DEFAULT_OUTPUT_LIMIT } = {}) {
  return {
    async launch({ task, spec, runId }) {
      if (spec.mode !== 'headless-profile') throw new WorkerDispatchError('worker spec does not support the headless process launcher', 'UNSUPPORTED_WORKER_MODE', { mode: spec.mode })
      const prompt = buildTaskPrompt(task, spec, runId)
      const child = spawnImpl(spec.command, ['--profile', spec.profile, prompt], {
        cwd: task.workspace,
        env: { ...env, DSH_TASK_ID: task.id, DSH_DISPATCH_RUN_ID: runId },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })
      return processHandle(child, outputLimit)
    },
  }
}

function runIdFor(profile, idFactory) {
  return profile + ':' + idFactory()
}

export class WorkerDispatcher {
  constructor({
    store,
    registry,
    launcher = createWorkerLauncher(),
    preflight,
    preDispatch = null,
    preflightOptions = {},
    actor = 'task-dispatcher',
    idFactory = randomUUID,
    clock = () => Date.now(),
    outputLimit = DEFAULT_OUTPUT_LIMIT,
    completionHook = null,
  } = {}) {
    if (!store || typeof store.list !== 'function') throw new TypeError('a task store is required')
    if (!registry || typeof registry.resolve !== 'function') throw new TypeError('a WorkerSpecRegistry is required')
    if (!launcher || typeof launcher.launch !== 'function') throw new TypeError('a worker launcher is required')
    this.store = store
    this.registry = registry
    this.launcher = launcher
    this.preflight = preflight ?? ((request, options) => runPreflight(registry, request, options))
    if (preDispatch !== null && typeof preDispatch !== 'function') throw new TypeError('preDispatch must be a function or null')
    this.preDispatch = preDispatch
    this.preflightOptions = { ...preflightOptions }
    this.actor = actor
    this.idFactory = idFactory
    this.clock = clock
    this.outputLimit = outputLimit
    if (completionHook !== null && typeof completionHook !== 'function') throw new TypeError('completionHook must be a function or null')
    this.completionHook = completionHook
  }

  async dispatchOnce({ workerProfile, limit = 1 } = {}) {
    if (typeof workerProfile !== 'string' || workerProfile.trim() === '') throw new TypeError('workerProfile is required')
    const tasks = this.store.list({ ready_to_run: true, worker_profile: workerProfile, limit })
    for (const task of tasks) {
      const result = await this.dispatchTask(task)
      if (result.reason === 'claim_race') continue
      return result
    }
    return { dispatched: false, reason: 'no_ready_task', worker_profile: workerProfile }
  }

  /**
   * Release a held claim; if the lease expired mid-guard (release throws),
   * revert the task row directly so it can never strand. Returns one of
   * 'released' | 'reverted' | 'failed'.
   */
  releaseOrRevert(taskId, worker) {
    try {
      this.store.release(taskId, worker, { actor: this.actor })
      return 'released'
    } catch {
      // Lease likely expired mid-guard. Atomically RE-claim as this worker
      // (claim() only succeeds if the lease is still expired or the task is
      // claimable — a THIRD party holding a live lease forces already_claimed)
      // then release under the fresh lease. Fully transactional: no window for
      // another owner to be clobbered.
      let reclaim
      try {
        reclaim = this.store.claim(taskId, worker, { actor: this.actor })
      } catch {
        return 'failed'
      }
      if (!reclaim.claimed) {
        if (reclaim.reason === 'already_claimed') return 'held_by_other'
        // For EVERY other failure (blocked_by_dependencies, not_claimable,
        // max_attempts_exceeded, ...) run the atomic owner+expiry-checked
        // release — one conditional SQL UPDATE, no TOCTOU window at all:
        //   - released  → reverted
        //   - not_owner → held_by_other
        //   - lease_active / anything else → failed (someone else deals with it)
        try {
          const expired = this.store.releaseExpiredClaim
            ? this.store.releaseExpiredClaim(taskId, worker, { actor: this.actor })
            : { released: false, reason: 'unavailable' }
          return expired.released
            ? 'reverted'
            : (expired.reason === 'not_owner' ? 'held_by_other' : 'failed')
        } catch {
          return 'failed'
        }
      }
      try {
        this.store.release(taskId, worker, { actor: this.actor })
        return 'reverted'
      } catch {
        return 'failed'
      }
    }
  }

  async dispatchTask(task) {
    const workerProfile = task.worker_profile
    const preflight = await this.preflight({
      worker_profile: workerProfile,
      worker_model: task.worker_model,
      workspace: task.workspace,
    }, this.preflightOptions)
    if (!preflight.ok) return { dispatched: false, reason: 'preflight_failed', task, preflight }
    const spec = preflight.spec ?? this.registry.resolve(workerProfile, task.worker_model)
    const runId = runIdFor(spec.name, this.idFactory)
    const worker = runId
    const claimed = this.store.claim(task.id, worker, { lease_seconds: spec.leaseSeconds, actor: this.actor })
    if (!claimed.claimed) return { dispatched: false, reason: 'claim_race', task: claimed.task, claim: claimed }

    if (this.preDispatch) {
      let verdict
      try {
        verdict = await this.preDispatch({ task: claimed.task ?? task, worker, runId })
      } catch (error) {
        verdict = { ok: false, code: 'GUARD_ERROR', error: errorText(error) }
      } finally {
        // Fail-closed: ONLY the exact plain-object shape { ok: true } counts.
        // Arrays/functions, subclasses, extra enumerable/symbol/non-enumerable
        // or PROTOTYPE-inherited keys, and ok !== true all reject.
        // The guard may hand back ANY value — including a throwing Proxy. All
        // inspection stays in a try/catch and failure to validate = reject.
        // Move the shape judgement INSIDE one try/catch; NEVER retain the
        // caller-provided verdict afterwards (a dynamic Proxy can change its
        // answers between reads). The only thing that leaves the try is a 1-bit
        // boolean decision + one immutable plain-object payload.
        let approved = false
        let finalVerdict = null
        try {
          const proto = typeof verdict !== 'object' || verdict === null ? null : Object.getPrototypeOf(verdict)
          const isPlain = verdict !== null && typeof verdict === 'object' && (proto === Object.prototype || proto === null)
          const soleOk = isPlain && Reflect.ownKeys(verdict).length === 1 && Reflect.ownKeys(verdict)[0] === 'ok'
          if (soleOk && verdict.ok === true) {
            approved = true
            finalVerdict = { ok: true }
          } else if (isPlain && verdict.ok === false) {
            // Structured plain-object failure: copy (never retain) so later
            // re-evaluation cannot flip.
            approved = false
            finalVerdict = { ok: false, code: verdict.code ?? 'GUARD_REJECTED' }
            for (const k of ['preconditions', 'changeId', 'detail', 'error']) {
              const v = verdict[k]
              if (v !== undefined) finalVerdict[k] = v
            }
          } else {
            approved = false
            finalVerdict = { ok: false, code: 'GUARD_REJECTED', detail: typeof verdict === 'object' && verdict !== null ? null : verdict }
          }
        } catch {
          approved = false
          finalVerdict = { ok: false, code: 'GUARD_REJECTED', detail: null }
        }
        if (!approved) {
          const restored = this.releaseOrRevert(task.id, worker)
          return {
            dispatched: false, reason: 'dispatch_not_governed', predispatch: finalVerdict,
            claim_cleanup: restored, task: this.store.get(task.id), run_id: runId, worker,
          }
        }
      }
    }

    let handle
    try {
      handle = await this.launcher.launch({ task: claimed.task ?? task, spec, selection: spec.model, runId, worker })
      this.store.start(task.id, worker, { actor: this.actor })
    } catch (error) {
      await handle?.terminate?.()
      try { this.store.release(task.id, worker, { actor: this.actor }) } catch {}
      return { dispatched: false, reason: 'launch_failed', task: this.store.get(task.id), error: errorText(error), run_id: runId }
    }

    // If a completion hook is configured (governed dispatch), hold the binding
    // before wait() so the hook can validate session identity via completeGovernedTask.
    let governedHoldAcquired = false
    if (this.completionHook) {
      await handle?._governedHold?.()
      governedHoldAcquired = true
    }

    try {
      return await this.monitor(task, spec, handle, { runId, worker })
    } finally {
      // Always release the governed binding when the hold was acquired, regardless
      // of success/failure/lease-lost/timeout — prevents leaked worker role bindings.
      if (governedHoldAcquired) {
        await handle?._governedRelease?.()
      }
    }
  }

  async monitor(task, spec, handle, { runId, worker }) {
    let leaseLost = false
    let renewing = false
    const renew = async () => {
      if (renewing || leaseLost) return
      renewing = true
      try {
        const result = this.store.renewLease(task.id, worker, { lease_seconds: spec.leaseSeconds, actor: this.actor })
        if (!result.renewed) {
          leaseLost = true
          await handle.terminate?.()
        }
      } catch {
        leaseLost = true
        await handle.terminate?.()
      } finally {
        renewing = false
      }
    }
    const intervalMs = Math.max(1000, Math.floor(spec.leaseSeconds * 1000 / 3))
    const renewTimer = setInterval(() => { renew() }, intervalMs)
    renewTimer.unref?.()
    let timeoutTimer
    let timedOut = false
    const wait = Promise.resolve().then(() => handle.wait()).catch(error => ({ exitCode: null, signal: null, stdout: '', stderr: errorText(error), error: errorText(error) }))
    const timeout = new Promise(resolve => {
      timeoutTimer = setTimeout(async () => {
        timedOut = true
        await handle.terminate?.()
        resolve({ timeout: true, exitCode: null, signal: 'SIGTERM', stdout: '', stderr: 'worker timed out' })
      }, spec.timeoutMs)
      timeoutTimer.unref?.()
    })
    const outcome = await Promise.race([wait, timeout])
    clearInterval(renewTimer)
    clearTimeout(timeoutTimer)
    if (leaseLost) return { dispatched: true, status: 'lease_lost', task: this.store.get(task.id), run_id: runId, worker }

    const stdout = clip(outcome.stdout, this.outputLimit)
    const stderr = clip(outcome.stderr, this.outputLimit)
    const summary = timedOut
      ? 'worker timed out\n' + stderr
      : outcome.exitCode === 0
        ? stdout || 'worker completed without a final response'
        : stderr || stdout || outcome.error || 'worker exited with code ' + outcome.exitCode
    const result = {
      result_summary: typeof outcome?.summary === 'string' ? outcome.summary : summary,
      files_changed: [],
      tests_run: [],
      remaining_blockers: timedOut ? ['worker timeout'] : outcome.exitCode === 0 ? [] : ['worker exited unsuccessfully'],
      // Thread the canonical structured completion envelope from the worker's
      // real outcome (session launcher tool/result.meta) into the governed
      // completion hook; fields absent from the outcome stay absent (the hook
      // fails closed rather than substituting fabricated defaults).
      ...(outcome?.commit_sha ? { commit_sha: outcome.commit_sha } : {}),
      ...(Array.isArray(outcome?.files_changed) ? { files_changed: outcome.files_changed } : {}),
      ...(Array.isArray(outcome?.tests_run) ? { tests_run: outcome.tests_run } : {}),
      ...(Array.isArray(outcome?.remaining_blockers) ? { remaining_blockers: outcome.remaining_blockers } : {}),
      ...(outcome?.beforeRevision ? { beforeRevision: outcome.beforeRevision } : {}),
      ...(outcome?.afterRevision ? { afterRevision: outcome.afterRevision } : {}),
      ...(Array.isArray(outcome?.criteria) ? { criteria: outcome.criteria } : {}),
      ...(Array.isArray(outcome?.deviations) ? { deviations: outcome.deviations } : {}),
      ...(Array.isArray(outcome?.workerChecks) ? { workerChecks: outcome.workerChecks } : {}),
      ...(Array.isArray(outcome?.controllerPreflight) ? { controllerPreflight: outcome.controllerPreflight } : {}),
    }
    if (timedOut || outcome.exitCode !== 0 || outcome.error) {
      const failed = this.store.fail(task.id, result, { worker, actor: this.actor })
      return { dispatched: true, status: 'failed', task: failed, run_id: runId, worker, exit_code: outcome.exitCode, stdout, stderr }
    }
    let completed
    const completionOpts = { worker, actor: this.actor }
    // Pin the sessionId from the launcher handle into the completion context
    // so a governed completion hook can validate the actual session identity.
    if (handle && typeof handle.sessionId === 'string') {
      completionOpts.sessionId = handle.sessionId
    }
    if (this.completionHook) {
      try {
        completed = await this.completionHook(task.id, result, completionOpts)
      } catch (error) {
        // Funnel completionHook errors to store.fail so the task lands in failed
        // (not running) and the error propagates to the dispatcher result.
        // TH2-R2-03: Tolerate store.fail lease/owner errors — if the lease is already
        // lost or the worker doesn't match, return a structured result instead of
        // leaving the task stranded in running state.
        try {
          const failed = this.store.fail(task.id, result, { worker, actor: this.actor })
          return { dispatched: true, status: 'failed', task: failed, run_id: runId, worker, error: error.message }
        } catch (leaseError) {
          // Lease/owner mismatch — return structured failure without uncaught rejection.
          return { dispatched: true, status: 'lease_lost', task: this.store.get(task.id), run_id: runId, worker, error: leaseError.message }
        }
      }
    } else {
      completed = this.store.complete(task.id, result, { worker, actor: this.actor })
    }
    return { dispatched: true, status: 'in_review', task: completed, run_id: runId, worker, exit_code: outcome.exitCode, stdout, stderr }
  }
}


export function createSessionRpcClient({ baseUrl = 'http://127.0.0.1:3080/api', fetchImpl = globalThis.fetch, idFactory = randomUUID } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('a fetch implementation is required')
  const prefix = String(baseUrl).replace(/\/$/, '')
  return {
    async call(method, payload = {}) {
      const response = await fetchImpl(prefix + '/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'task-dispatch-' + idFactory(),
          method,
          payload,
        }),
      })
      let envelope
      try { envelope = await response.json() } catch (error) { throw new WorkerDispatchError('session RPC returned invalid JSON: ' + errorText(error), 'SESSION_RPC_INVALID_RESPONSE') }
      const result = envelope?.result
      if (!response.ok || !result?.ok) {
        const failure = result?.error
        throw new WorkerDispatchError(failure?.message ?? 'session RPC failed: ' + response.status, failure?.code ?? 'SESSION_RPC_FAILED', { method })
      }
      return result.value
    },
  }
}

function sessionEvents(value) {
  return (Array.isArray(value?.events) ? value.events : [])
    .map(entry => entry?.event ?? entry)
    .filter(event => event && typeof event.type === 'string')
}

function sessionAssistantText(events, afterSeq = -1) {
  return events
    .filter(event => event.seq > afterSeq && event.type === 'assistant/message')
    .map(event => event.data?.message?.content ?? [])
    .flatMap(content => content.map(block => block?.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('')
}

// ─── Canonical worker-completion protocol (T-H9) ──────────────────────────
//
// The DSH-native structured result carrier: a worker-scoped ToolRuntime
// completion tool whose `output.presentationMeta()` returns the envelope below.
// DSH appends that meta verbatim to the durable `tool/result` SessionEvent
// (`data.meta`), which the host `session.history` RPC returns as a raw event.
// We correlate the completion result's `toolCallId` with a `tool/call`'s
// `callId` in the same post-baseline window so the proof is attributed to this
// session's own completion call — never parsed from assistant prose, never
// fabricated. Exactly one valid envelope is required whenever a completion was
// attempted; duplicate/missing/malformed/partial/stale/replayed results fail
// closed.
const WORKER_COMPLETION_PROTOCOL = 'dsh.worker-completion.v1'
const WORKER_COMPLETION_TOOL = 'worker_complete'

const REQUIRED_STRING_FIELDS = ['protocol', 'beforeRevision', 'afterRevision', 'commit_sha', 'summary']
const REQUIRED_STRING_ARRAY_FIELDS = ['files_changed', 'tests_run', 'remaining_blockers', 'workerChecks', 'controllerPreflight']
const REQUIRED_ARRAY_FIELDS = ['deviations']

function completionError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Strictly validate the worker-owned completion envelope. All keys required
 * (no additionalProperties), types checked, required strings non-empty. Empty
 * revisions/commit ids are semantically invalid even though the DSH JSON-schema
 * subset lacks `minLength`, so we reject them here explicitly.
 */
function validateWorkerCompletion(meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw completionError('WORKER_COMPLETION_INVALID', 'worker completion meta must be an object')
  }
  const allowed = new Set(['protocol', 'beforeRevision', 'afterRevision', 'commit_sha', 'files_changed', 'tests_run', 'remaining_blockers', 'criteria', 'deviations', 'workerChecks', 'controllerPreflight', 'summary'])
  for (const key of Object.keys(meta)) {
    if (!allowed.has(key)) throw completionError('WORKER_COMPLETION_INVALID', 'worker completion meta has unexpected field: ' + key)
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof meta[field] !== 'string' || meta[field].trim() === '') {
      throw completionError('WORKER_COMPLETION_INVALID', 'worker completion requires a non-empty ' + field)
    }
  }
  if (meta.protocol !== WORKER_COMPLETION_PROTOCOL) {
    throw completionError('WORKER_COMPLETION_INVALID', 'worker completion protocol must be ' + WORKER_COMPLETION_PROTOCOL)
  }
  for (const field of REQUIRED_STRING_ARRAY_FIELDS) {
    if (!Array.isArray(meta[field]) || meta[field].some(item => typeof item !== 'string')) {
      throw completionError('WORKER_COMPLETION_INVALID', 'worker completion ' + field + ' must be an array of strings')
    }
  }
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(meta[field])) {
      throw completionError('WORKER_COMPLETION_INVALID', 'worker completion ' + field + ' must be an array')
    }
  }
  if (!Array.isArray(meta.criteria)) {
    throw completionError('WORKER_COMPLETION_INVALID', 'worker completion criteria must be an array')
  }
  for (const criterion of meta.criteria) {
    if (criterion === null || typeof criterion !== 'object' || typeof criterion.id !== 'string' || criterion.id.trim() === '' || typeof criterion.satisfied !== 'boolean') {
      throw completionError('WORKER_COMPLETION_INVALID', 'worker completion criteria entries must be { id: non-empty string, satisfied: boolean }')
    }
  }
  return meta
}

/**
 * Extract the canonical envelope from post-baseline session events, or return
 * null when no completion was attempted. Throws a structured
 * WORKER_COMPLETION_* error when a completion was attempted but the result is
 * missing/duplicate/malformed/partial/stale (unattributable).
 */
function extractWorkerCompletion(events, afterSeq) {
  const postBaseline = events.filter(event => event && Number.isSafeInteger(event.seq) && event.seq > afterSeq)
  const completionCalls = new Set()
  const results = []
  for (const event of postBaseline) {
    if (event.type === 'tool/call') {
      const callId = event.data?.callId
      if (typeof callId === 'string' && event.data?.name === WORKER_COMPLETION_TOOL) completionCalls.add(callId)
    } else if (event.type === 'tool/result') {
      const block = event.data?.message?.content?.[0]
      const toolCallId = block?.toolCallId
      if (typeof toolCallId === 'string') {
        const meta = event.data?.meta
        if (meta && typeof meta === 'object' && meta.protocol === WORKER_COMPLETION_PROTOCOL) {
          results.push({ toolCallId, meta, failed: event.data?.error != null || block?.isError === true })
        }
      }
    }
  }
  const completionAttempted = completionCalls.size > 0 || results.length > 0
  if (!completionAttempted) return null

  if (results.length === 0) {
    throw completionError('WORKER_COMPLETION_MISSING', 'worker completed but produced no ' + WORKER_COMPLETION_PROTOCOL + ' result')
  }
  if (results.length > 1) {
    throw completionError('WORKER_COMPLETION_DUPLICATE', 'worker produced ' + results.length + ' completion results; exactly one is required')
  }
  const result = results[0]
  if (result.failed) {
    throw completionError('WORKER_COMPLETION_FAILED', 'worker completion tool reported an error')
  }
  // Attribute the result to a completion call in THIS session's window; an
  // orphan/stale/replayed result (no matching call) fails closed.
  if (!completionCalls.has(result.toolCallId)) {
    throw completionError('WORKER_COMPLETION_UNATTRIBUTED', 'worker completion result is not attributable to this session completion call')
  }
  return validateWorkerCompletion(result.meta)
}

function sessionTerminal(events, afterSeq) {
  return events.filter(event => event.seq > afterSeq && event.type === 'turn/end').at(-1)
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export function createSessionLauncher({ rpc = createSessionRpcClient(), pollIntervalMs = 250, historyMaxMessages = 500 } = {}) {
  if (!rpc || typeof rpc.call !== 'function') throw new TypeError('a session RPC client is required')
  return {
    async launch({ task, spec, runId }) {
      if (spec.mode !== 'session') throw new WorkerDispatchError('worker spec does not support the session launcher', 'UNSUPPORTED_WORKER_MODE', { mode: spec.mode })
      const created = await rpc.call('session.create', { cwd: task.workspace, agentPreset: spec.agentPreset })
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') throw new WorkerDispatchError('session.create returned no session id', 'SESSION_ID_MISSING')
      let baselineSeq = -1
      try {
        if (spec.model) {
          const selection = { provider: spec.model.provider, model: spec.model.model }
          if (spec.model.reasoningEffort !== undefined) selection.reasoningEffort = spec.model.reasoningEffort
          await rpc.call('session.selectModel', { sessionId, ...selection })
        }
        const before = sessionEvents(await rpc.call('session.history', { sessionId, maxMessages: historyMaxMessages }))
        baselineSeq = before.reduce((max, event) => Math.max(max, Number.isSafeInteger(event.seq) ? event.seq : max), -1)
        await rpc.call('session.prompt', {
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: typeof spec.prompt === 'string' && spec.prompt !== '' ? spec.prompt : buildTaskPrompt(task, spec, runId) }],
        })
      } catch (setupError) {
        // Never strand a live session half-configured: cancel it so it does
        // not show up as a live item in the host UI without any work item.
        try { await rpc.call('session.cancel', { sessionId }); } catch { /* best-effort */ }
        throw setupError
      }
      let waitPromise
      const wait = () => {
        if (!waitPromise) {
          waitPromise = (async () => {
            while (true) {
              const events = sessionEvents(await rpc.call('session.history', { sessionId, maxMessages: historyMaxMessages }))
              const terminal = sessionTerminal(events, baselineSeq)
              if (terminal) {
                const kind = terminal.data?.reason?.kind
                const stdout = sessionAssistantText(events, baselineSeq)
                if (kind === 'completed') {
                  // Surface the canonical structured completion envelope when the
                  // worker attempted one; otherwise return a text-only outcome
                  // (the governed hook rejects a proof-less success fail-closed).
                  // A completion that was attempted but is missing/duplicate/
                  // malformed/partial/stale is a structured failure, not a
                  // success, so it funnels to a non-zero exit with a code.
                  try {
                    const completion = extractWorkerCompletion(events, baselineSeq)
                    if (completion) {
                      return {
                        exitCode: 0, signal: null, stdout, stderr: '', sessionId,
                        commit_sha: completion.commit_sha,
                        beforeRevision: completion.beforeRevision,
                        afterRevision: completion.afterRevision,
                        files_changed: completion.files_changed,
                        tests_run: completion.tests_run,
                        remaining_blockers: completion.remaining_blockers,
                        criteria: completion.criteria,
                        deviations: completion.deviations,
                        workerChecks: completion.workerChecks,
                        controllerPreflight: completion.controllerPreflight,
                        summary: completion.summary,
                      }
                    }
                    return { exitCode: 0, signal: null, stdout, stderr: '', sessionId }
                  } catch (completionFailure) {
                    const message = completionFailure instanceof Error ? completionFailure.message : String(completionFailure)
                    return { exitCode: 1, signal: null, stdout, stderr: message, error: message, sessionId, code: completionFailure?.code }
                  }
                }
                const message = terminal.data?.reason?.error?.message ?? 'session turn ended with ' + (kind ?? 'unknown reason')
                return { exitCode: 1, signal: null, stdout, stderr: message, error: message, sessionId }
              }
              await sleep(pollIntervalMs)
            }
          })()
        }
        return waitPromise
      }
      return {
        sessionId,
        pid: null,
        wait,
        async terminate() {
          try { await rpc.call('session.cancel', { sessionId }); return true } catch { return false }
        },
      }
    },
  }
}

export function createWorkerLauncher({ headlessOptions = {}, sessionOptions = {} } = {}) {
  const headless = createHeadlessProcessLauncher(headlessOptions)
  const session = createSessionLauncher(sessionOptions)
  return {
    launch(input) {
      return input.spec.mode === 'session' ? session.launch(input) : headless.launch(input)
    },
  }
}
