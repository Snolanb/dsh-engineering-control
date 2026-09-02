const MODES = Object.freeze(['headless-profile', 'session'])
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_LEASE_SECONDS = 30 * 60

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function string(value, name, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined
    throw new WorkerSpecError(name + ' is required', 'INVALID_WORKER_SPEC', { field: name })
  }
  if (typeof value !== 'string' || value.trim() === '') throw new WorkerSpecError(name + ' must be a non-empty string', 'INVALID_WORKER_SPEC', { field: name })
  return value.trim()
}

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new WorkerSpecError(name + ' must be a positive integer', 'INVALID_WORKER_SPEC', { field: name })
  return value
}

function stringArray(value, name) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) throw new WorkerSpecError(name + ' must be an array of non-empty strings', 'INVALID_WORKER_SPEC', { field: name })
  return [...new Set(value.map(item => item.trim()))].sort()
}

function modelSource(input) {
  if (input?.modelSelection !== undefined) return input.modelSelection
  if (input?.model && typeof input.model === 'object') return input.model
  return { provider: input?.provider, model: input?.model, reasoningEffort: input?.reasoningEffort ?? input?.reasoning_effort }
}

export class WorkerSpecError extends TypeError {
  constructor(message, code = 'INVALID_WORKER_SPEC', details = {}) {
    super(message)
    this.name = 'WorkerSpecError'
    this.code = code
    this.details = details
  }
}

export function normalizeModelSelection(input, { requireProvider = true, requireModel = true } = {}) {
  let source = input
  if (typeof source === 'string') {
    const slash = source.indexOf('/')
    source = slash < 1 ? { model: source } : { provider: source.slice(0, slash), model: source.slice(slash + 1) }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new WorkerSpecError('model selection must be an object or provider/model string')
  const provider = string(source.provider, 'provider', { optional: !requireProvider })
  const model = string(source.model, 'model', { optional: !requireModel })
  const reasoningEffort = string(source.reasoningEffort ?? source.reasoning_effort, 'reasoningEffort', { optional: true })
  return freeze({
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  })
}

export function mergeModelSelection(base, override) {
  const normalizedBase = normalizeModelSelection(base)
  if (override === undefined || override === null || override === '') return normalizedBase
  let patch = override
  if (typeof patch === 'string') {
    const slash = patch.indexOf('/')
    patch = slash < 1 ? { model: patch } : { provider: patch.slice(0, slash), model: patch.slice(slash + 1) }
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new WorkerSpecError('worker_model override must be an object or provider/model string', 'INVALID_WORKER_MODEL')
  return normalizeModelSelection({ ...normalizedBase, ...patch, reasoningEffort: patch.reasoningEffort ?? patch.reasoning_effort ?? normalizedBase.reasoningEffort })
}

function normalizeWorkspacePolicy(value) {
  if (value === undefined || value === null || value === 'project-only') return freeze({ type: 'project-only', roots: [] })
  if (value === 'any') return freeze({ type: 'any', roots: [] })
  if (typeof value !== 'object' || Array.isArray(value)) throw new WorkerSpecError('workspacePolicy must be project-only, any, or an object', 'INVALID_WORKER_SPEC', { field: 'workspacePolicy' })
  const type = string(value.type ?? 'project-only', 'workspacePolicy.type')
  if (!['project-only', 'any'].includes(type)) throw new WorkerSpecError('workspacePolicy.type must be project-only or any', 'INVALID_WORKER_SPEC', { field: 'workspacePolicy.type' })
  const roots = stringArray(value.roots, 'workspacePolicy.roots')
  return freeze({ type, roots })
}

export function normalizeWorkerSpec(name, input) {
  const workerName = string(name, 'worker_profile')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkerSpecError('worker spec must be an object', 'INVALID_WORKER_SPEC', { worker_profile: workerName })
  const mode = string(input.mode ?? 'headless-profile', 'mode')
  if (!MODES.includes(mode)) throw new WorkerSpecError('mode must be one of: ' + MODES.join(', '), 'INVALID_WORKER_SPEC', { field: 'mode' })
  const profile = string(input.profile ?? input.cliProfile, 'profile', { optional: true })
  const agentPreset = string(input.agentPreset ?? input.agent_preset, 'agentPreset', { optional: true })
  if (mode === 'headless-profile' && profile === undefined) throw new WorkerSpecError('headless-profile workers require profile', 'INVALID_WORKER_SPEC', { worker_profile: workerName })
  if (mode === 'session' && agentPreset === undefined) throw new WorkerSpecError('session workers require agentPreset', 'INVALID_WORKER_SPEC', { worker_profile: workerName })
  const model = normalizeModelSelection(modelSource(input))
  const command = string(input.command ?? 'dsh', 'command')
  const plugins = stringArray(input.plugins, 'plugins')
  const workspacePolicy = normalizeWorkspacePolicy(input.workspacePolicy ?? input.workspace_policy)
  return freeze({
    name: workerName,
    enabled: input.enabled !== false,
    mode,
    ...(profile === undefined ? {} : { profile }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    model,
    command,
    plugins,
    maxConcurrency: positiveInteger(input.maxConcurrency ?? input.max_concurrency, 'maxConcurrency', 1),
    timeoutMs: positiveInteger(input.timeoutMs ?? input.timeout_ms, 'timeoutMs', DEFAULT_TIMEOUT_MS),
    leaseSeconds: positiveInteger(input.leaseSeconds ?? input.lease_seconds, 'leaseSeconds', DEFAULT_LEASE_SECONDS),
    workspacePolicy,
  })
}

export class WorkerSpecRegistry {
  constructor(input = {}) {
    const entries = Array.isArray(input)
      ? input.map(item => [item?.name ?? item?.worker_profile, item])
      : Object.entries(input ?? {})
    this.specs = new Map()
    for (const [name, value] of entries) {
      const spec = normalizeWorkerSpec(name, value)
      if (this.specs.has(spec.name)) throw new WorkerSpecError('duplicate worker profile: ' + spec.name, 'DUPLICATE_WORKER_PROFILE', { worker_profile: spec.name })
      this.specs.set(spec.name, spec)
    }
  }

  has(name) {
    return this.specs.has(name)
  }

  get(name) {
    const workerName = string(name, 'worker_profile')
    const spec = this.specs.get(workerName)
    if (!spec) throw new WorkerSpecError('unknown worker profile: ' + workerName, 'UNKNOWN_WORKER_PROFILE', { worker_profile: workerName })
    return spec
  }

  list() {
    return [...this.specs.values()]
  }

  resolve(name, workerModel) {
    const spec = this.get(name)
    return freeze({ ...spec, model: mergeModelSelection(spec.model, workerModel) })
  }
}

export { DEFAULT_LEASE_SECONDS, DEFAULT_TIMEOUT_MS, MODES }
