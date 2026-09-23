import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { WorkerSpecError } from './worker-specs.js'

function check(name, ok, code, message, details = {}) {
  return { name, ok, ...(ok ? {} : { code, message }), ...details }
}

function failure(workerProfile, checks, selection = null, spec = null) {
  return {
    ok: false,
    worker_profile: workerProfile,
    ...(spec === null ? {} : { spec }),
    selection,
    checks,
    blockers: checks.filter(item => !item.ok).map(item => ({ code: item.code, message: item.message })),
  }
}

async function resourceCheck(name, resource, checker, unavailableCode) {
  if (typeof checker === 'function') {
    try {
      const result = await checker(resource)
      return result ? check(name, true) : check(name, false, 'MISSING_' + unavailableCode, 'worker resource is not available: ' + resource)
    } catch (error) {
      return check(name, false, 'RESOURCE_CHECK_FAILED', error instanceof Error ? error.message : String(error))
    }
  }
  if (checker instanceof Set || Array.isArray(checker)) {
    return checker.has?.(resource) || checker.includes?.(resource)
      ? check(name, true)
      : check(name, false, 'MISSING_' + unavailableCode, 'worker resource is not available: ' + resource)
  }
  return check(name, false, unavailableCode + '_CHECK_UNAVAILABLE', 'no checker was provided for worker resource: ' + resource)
}

function workspaceCheck(workspace, policy, workspaceRoots) {
  if (typeof workspace !== 'string' || workspace.trim() === '') return check('workspace', false, 'WORKSPACE_REQUIRED', 'task workspace is required')
  if (!isAbsolute(workspace)) return check('workspace', false, 'WORKSPACE_MUST_BE_ABSOLUTE', 'task workspace must be an absolute path')
  if (!existsSync(workspace)) return check('workspace', false, 'WORKSPACE_NOT_FOUND', 'task workspace does not exist: ' + workspace)
  let workspaceReal
  try {
    if (!statSync(workspace).isDirectory()) return check('workspace', false, 'WORKSPACE_NOT_DIRECTORY', 'task workspace is not a directory: ' + workspace)
    workspaceReal = realpathSync(workspace)
  } catch (error) {
    return check('workspace', false, 'WORKSPACE_UNREADABLE', error instanceof Error ? error.message : String(error))
  }
  if (policy.type === 'any') return check('workspace', true, undefined, undefined, { path: workspaceReal })
  const roots = [...new Set([...(workspaceRoots ?? []), ...policy.roots])]
  if (roots.length === 0) return check('workspace', false, 'WORKSPACE_ROOTS_UNCONFIGURED', 'project-only workspace policy has no approved roots')
  for (const root of roots) {
    if (typeof root !== 'string' || root.trim() === '') continue
    const rootPath = resolve(root)
    if (!existsSync(rootPath)) continue
    let rootReal
    try { rootReal = realpathSync(rootPath) } catch { continue }
    const child = relative(rootReal, workspaceReal)
    if (child === '' || (!child.startsWith('..') && !isAbsolute(child))) return check('workspace', true, undefined, undefined, { path: workspaceReal, root: rootReal })
  }
  return check('workspace', false, 'WORKSPACE_OUTSIDE_ROOTS', 'task workspace is outside the approved project roots: ' + workspaceReal)
}

async function modelCheck(selection, llm) {
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.resolveCallConfig !== 'function') return check('model', false, 'MODEL_SERVICE_UNAVAILABLE', 'an LLM service with exact-model validation is required for preflight')
  let providers
  try { providers = await llm.listProviders() } catch (error) { return check('model', false, 'MODEL_PROVIDER_LIST_FAILED', error instanceof Error ? error.message : String(error)) }
  if (!providers?.some(provider => provider?.id === selection.provider)) return check('model', false, 'PROVIDER_UNAVAILABLE', 'provider is not active: ' + selection.provider)
  try {
    await llm.resolveCallConfig({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) })
  } catch (error) {
    const code = error?.code === 'UNKNOWN_MODEL' ? 'MODEL_UNAVAILABLE'
      : error?.code === 'UNSUPPORTED_REASONING_EFFORT' ? 'REASONING_EFFORT_UNAVAILABLE'
        : 'MODEL_RESOLUTION_FAILED'
    return check('model', false, code, error instanceof Error ? error.message : String(error))
  }
  return check('model', true, undefined, undefined, { provider: selection.provider, model: selection.model })
}

export async function preflightWorker(registry, request = {}, options = {}) {
  if (!registry || typeof registry.resolve !== 'function') throw new TypeError('a WorkerSpecRegistry is required')
  const workerProfile = request.worker_profile ?? request.workerProfile
  let spec
  try {
    spec = registry.resolve(workerProfile, request.worker_model ?? request.workerModel)
  } catch (error) {
    if (!(error instanceof WorkerSpecError)) throw error
    return failure(workerProfile, [check('worker_spec', false, error.code, error.message)], null)
  }
  const checks = []
  if (!spec.enabled) checks.push(check('worker_spec', false, 'WORKER_DISABLED', 'worker profile is disabled: ' + spec.name))
  else checks.push(check('worker_spec', true))
  checks.push(workspaceCheck(request.workspace, spec.workspacePolicy, options.workspaceRoots))
  if (spec.mode === 'headless-profile') {
    checks.push(await resourceCheck('profile', spec.profile, options.profileExists ?? options.profiles, 'PROFILE_UNAVAILABLE'))
    if (options.requireLauncher !== false) checks.push(await resourceCheck('launcher', spec.command, options.launcherExists ?? options.launchers, 'LAUNCHER_UNAVAILABLE'))
  } else {
    checks.push(await resourceCheck('agent_preset', spec.agentPreset, options.presetExists ?? options.presets, 'PRESET_UNAVAILABLE'))
  }
  checks.push(await modelCheck(spec.model, options.llm))
  return {
    ok: checks.every(item => item.ok),
    worker_profile: spec.name,
    spec,
    selection: spec.model,
    checks,
    blockers: checks.filter(item => !item.ok).map(item => ({ code: item.code, message: item.message })),
  }
}
