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
    preflightOptions = {},
    actor = 'task-dispatcher',
    idFactory = randomUUID,
    clock = () => Date.now(),
    outputLimit = DEFAULT_OUTPUT_LIMIT,
  } = {}) {
    if (!store || typeof store.list !== 'function') throw new TypeError('a task store is required')
    if (!registry || typeof registry.resolve !== 'function') throw new TypeError('a WorkerSpecRegistry is required')
    if (!launcher || typeof launcher.launch !== 'function') throw new TypeError('a worker launcher is required')
    this.store = store
    this.registry = registry
    this.launcher = launcher
    this.preflight = preflight ?? ((request, options) => runPreflight(registry, request, options))
    this.preflightOptions = { ...preflightOptions }
    this.actor = actor
    this.idFactory = idFactory
    this.clock = clock
    this.outputLimit = outputLimit
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

    let handle
    try {
      handle = await this.launcher.launch({ task, spec, selection: spec.model, runId, worker })
      this.store.start(task.id, worker, { actor: this.actor })
    } catch (error) {
      await handle?.terminate?.()
      try { this.store.release(task.id, worker, { actor: this.actor }) } catch {}
      return { dispatched: false, reason: 'launch_failed', task: this.store.get(task.id), error: errorText(error), run_id: runId }
    }

    return await this.monitor(task, spec, handle, { runId, worker })
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
      result_summary: summary,
      files_changed: [],
      tests_run: [],
      remaining_blockers: timedOut ? ['worker timeout'] : outcome.exitCode === 0 ? [] : ['worker exited unsuccessfully'],
    }
    if (timedOut || outcome.exitCode !== 0 || outcome.error) {
      const failed = this.store.fail(task.id, result, { worker, actor: this.actor })
      return { dispatched: true, status: 'failed', task: failed, run_id: runId, worker, exit_code: outcome.exitCode, stdout, stderr }
    }
    const completed = this.store.complete(task.id, result, { worker, actor: this.actor })
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
      const selection = { provider: spec.model.provider, model: spec.model.model }
      if (spec.model.reasoningEffort !== undefined) selection.reasoningEffort = spec.model.reasoningEffort
      await rpc.call('session.selectModel', { sessionId, ...selection })
      const before = sessionEvents(await rpc.call('session.history', { sessionId, maxMessages: historyMaxMessages }))
      const baselineSeq = before.reduce((max, event) => Math.max(max, Number.isSafeInteger(event.seq) ? event.seq : max), -1)
      await rpc.call('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: buildTaskPrompt(task, spec, runId) }],
      })
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
                if (kind === 'completed') return { exitCode: 0, signal: null, stdout, stderr: '', sessionId }
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
