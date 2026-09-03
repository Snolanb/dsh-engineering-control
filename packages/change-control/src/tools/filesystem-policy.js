// @ts-nocheck
import { getGovernanceProvider } from '../service/governance-provider.js';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

/**
 * Deterministic filesystem and tool policy enforcement.
 *
 * Intercepts tool execution at the pre-execute boundary to enforce:
 * - planner/reviewer roles: read-only (all non-change-tool calls denied)
 * - worker role: mutations allowed only in IMPLEMENTING or REPAIR state
 * - unbound sessions: no restriction (backward compatible)
 * - denied actions: audited without raw sensitive arguments or tool content
 */

const CHANGE_TOOL_NAMES = new Set([
  'change_get',
  'change_submit_plan',
  'change_submit_proof',
  'change_submit_review',
  'change_submit_repair',
]);

/**
 * Resolve the binding for a specific session on a specific change.
 * Returns { changeId, role, state } or null if not bound to that change.
 * Throws on storage errors (fail-closed).
 */
async function resolveBinding(store, sessionId, changeId) {
  // Fail-closed: do not swallow storage errors into "unbound" allowance.
  const bindings = await store.listRoleBindings();
  const binding = bindings.find((b) => b.sessionId === sessionId && b.changeId === changeId);
  if (!binding) return null;
  const change = await store.get(binding.changeId);
  return { changeId: binding.changeId, role: binding.role, state: change.state, risk: change.risk };
}

/** Host-effective risk levels, weakest to strongest. */
const RISK_ORDER = { low: 0, normal: 1, high: 2 };

/** Model-argument keys that can carry a risk claim (normalized spelling). */
const RISK_CLAIM_KEYS = new Set(['risk', 'effectiverisk', 'risklevel']);
const normalizeArgKey = (key) => key.toLowerCase().replace(/_/g, '');

/**
 * Recursively collect model-supplied risk claims anywhere in the argument
 * tree (key spellings: risk, effectiveRisk, effective_risk, riskLevel,
 * risk_level). ponytail: depth-capped recursion; model args are JSON.
 */
function findRiskClaims(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return [];
  const found = [];
  if (Array.isArray(value)) {
    for (const item of value) found.push(...findRiskClaims(item, depth + 1));
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (RISK_CLAIM_KEYS.has(normalizeArgKey(key)) && typeof nested === 'string') {
      found.push(nested);
    } else {
      found.push(...findRiskClaims(nested, depth + 1));
    }
  }
  return found;
}

/** Recursively collect truthy approval-style flags in the argument tree. */
function findApprovalClaims(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return [];
  const found = [];
  if (Array.isArray(value)) {
    for (const item of value) found.push(...findApprovalClaims(item, depth + 1));
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (normalizeArgKey(key).includes('approval') && nested) {
      found.push(nested);
    } else if (nested && typeof nested === 'object') {
      found.push(...findApprovalClaims(nested, depth + 1));
    }
  }
  return found;
}

/**
 * Risk-profile enforcement for a bound session. Returns a deny decision or
 * null. Every fact comes from host-owned stores: the effective risk from
 * change.risk and gate satisfaction from the store's append-only records —
 * never from model-supplied arguments.
 * - AC1: risk must be explicit before implementation-capable actions run.
 * - AC2: model args may not claim a weaker risk than the host value.
 * - AC3: configured per-risk gates must be satisfied in host records.
 * - AC4/AC5: human-controlled gates can only be satisfied through the
 *   host/human channel, and gate satisfaction is bound to the risk level it
 *   was recorded under — a risk increase requires fresh, stronger gates.
 */
async function evaluateRisk(policyConfig, store, binding, exec) {
  const args = exec?.arguments ?? {};

  // Explicit opt-in escape hatch for genuinely legacy store paths.
  if (policyConfig?.allowLegacyRisklessChanges === true && binding.risk == null) {
    return null;
  }

  const hostRisk = typeof binding.risk === 'string' ? binding.risk.toLowerCase() : null;
  if (!hostRisk || !(hostRisk in RISK_ORDER)) {
    // Fail closed: no readable explicit host risk decision.
    return deny('RISK_NOT_EXPLICIT', `Change ${binding.changeId} has no explicit effective risk; implementation cannot proceed`);
  }

  // Model-supplied risk claims can never weaken the host decision.
  for (const claimed of findRiskClaims(args)) {
    const claim = claimed.toLowerCase();
    if (claim in RISK_ORDER && RISK_ORDER[claim] < RISK_ORDER[hostRisk]) {
      return deny('RISK_REDUCTION', `Agent session cannot reduce risk: host effective risk is ${hostRisk}, not ${claimed}`);
    }
  }

  // Gate requirements come from host-configured risk profiles. When no
  // profiles are configured at all there is nothing to enforce; when they
  // are configured, an absent/undeclared profile for the effective risk
  // fails closed.
  const profiles = policyConfig?.riskProfiles;
  if (profiles == null || typeof profiles !== 'object') return null;

  // Only implementation-capable actions consume gates: change-tool
  // submissions and worker mutations. Pure reads (change_get) pass through.
  const isGateBearing = (CHANGE_TOOL_NAMES.has(exec.name) && exec.name !== 'change_get')
    || (!CHANGE_TOOL_NAMES.has(exec.name) && binding.role === 'worker');
  if (!isGateBearing) return null;

  const profile = profiles[hostRisk] ?? profiles[hostRisk.toUpperCase()];
  if (!profile || !Array.isArray(profile.requiredChecks)) {
    return deny('RISK_PROFILE_UNDEFINED', `No declared risk profile for ${hostRisk.toUpperCase()}; configure requiredChecks (or an explicit empty list) to proceed`);
  }
  const requiredEntries = profile.requiredChecks;
  const required = requiredEntries.map(checkName).filter(Boolean);
  const humanControlled = requiredEntries
    .filter((entry) => typeof entry === 'object' && entry !== null && entry.control === 'human')
    .map(checkName).filter(Boolean);

  // A model-facing tool must not supply or assert satisfaction of a
  // human-controlled gate — neither via checks payloads nor approval flags.
  if (humanControlled.length > 0) {
    for (const attempt of findCheckAttempts(args)) {
      const names = attempt.map(checkName).filter(Boolean);
      if (humanControlled.some((hc) => names.includes(hc))) {
        return deny('HUMAN_GATE_BYPASS', 'Human-controlled gates cannot be satisfied by model-facing tools; they require the host/human approval channel');
      }
    }
    if (findApprovalClaims(args).length > 0) {
      return deny('HUMAN_GATE_BYPASS', 'Model-facing tools cannot assert human approval for a human-controlled gate');
    }
  }

  if (required.length === 0) return null;

  // Gate satisfaction is evaluated against host-owned recorded state only.
  const satisfaction = typeof store.getGateSatisfaction === 'function'
    ? await store.getGateSatisfaction(binding.changeId)
    : [];
  const satisfied = new Set(
    (Array.isArray(satisfaction) ? satisfaction : [])
      .filter((entry) => entry?.risk === hostRisk && typeof entry?.name === 'string')
      .map((entry) => entry.name)
  );
  const missing = required.filter((name) => !satisfied.has(name));
  if (missing.length > 0) {
    return deny('RISK_GATE_INCOMPLETE', `${hostRisk.toUpperCase()} risk requires host-recorded satisfaction of all configured gates; missing: ${missing.join(', ')}`);
  }
  return null;
}

/**
 * Create a pre-execute policy interceptor suitable for the
 * "tools/pre-execute" waterfall on ctx.events.
 * Returns null when policy is not configured or explicitly disabled.
 */
export function createFilesystemPolicy(store, config) {
  const policyConfig = config?.policy;
  // `policy.enabled === false` disables ONLY the legacy (policy-functional)
  // branches below; the T9.1 mandatory-governance branch is deliberately
  // NOT covered by that switch — runtime governance modes (persisted in
  // the store) govern themselves and cannot be shut off from model config.
  const legacyGateDisabled = policyConfig?.enabled === false;
  const isReadOnlyToolName = makeReadOnlyClassifier(policyConfig?.readOnlyToolNames);
  // Not configured at all: STILL return the gate — the T9.1 mandatory
  // governance mode uses this same hook and must be available from runtime
  // state alone. Mode resolution reads the store -> if every scope resolves
  // 'off', the gate is a pure pass-through.


  /**
   * Pre-execute interceptor. Called by the ToolRuntime for every tool call.
   * Signature: (exec, next) => { kind: 'allow' } | { kind: 'deny', reason } | next()
   */
  async function policyGate(exec, next) {
    const agentId = exec?.agent?.id;

    // T9.1: mandatory governance. Mode is resolved from the PERSISTED
    // governance modes map; the default is 'off' (fully backward compatible).
    // Runs BEFORE the unidentifiable-session early return — a missing
    // agent identity is exactly the case where mandatory mode matters.
    const mgDecision = await evaluateMandatoryGovernance(store, exec, agentId, isReadOnlyToolName);
    if (mgDecision) return mgDecision;
    // Mandatory gate approved this required-mode call (all preconditions
    // already verified there) — legacy policy must not re-litigate.
    if (exec?.['__mgHandled']) return next();

    // The legacy policy path requires an agent identity (bindings lookups).
    if (!agentId) return next();
    if (!policyConfig || legacyGateDisabled) return next();

    // Host-owned governance layer: active only when the policy names a
    // governed project. Runs before role/change-tool pass-through so that
    // repository content can never bypass authoritative checks.
    if (policyConfig?.projectId) {
      const decision = await evaluateGovernance(policyConfig, exec);
      await auditGovernance(store, exec, agentId, decision, policyConfig);
      if (decision) {
        // Escalation surfaces at the host boundary as an 'ask' — the human
        // approval channel — while the audit record keeps the internal code.
        if (decision.kind === 'escalate') return { kind: 'ask', reason: decision.reason };
        return decision;
      }
    }

    // Determine target change from tool arguments when available.
    const requestedChangeId = exec?.arguments?.changeId ?? null;

    let binding;
    try {
      binding = await resolveBinding(store, agentId, requestedChangeId);
    } catch {
      // Fail-closed: storage errors deny the action, never fall through to unbound.
      return { kind: 'deny', reason: 'Policy evaluation failed: binding lookup error' };
    }

    // If the caller specified a changeId but has no binding for it, deny.
    if (requestedChangeId && !binding) {
      return { kind: 'deny', reason: `Session ${agentId} is not bound to change ${requestedChangeId}` };
    }

    // If no changeId was specified, the session must have exactly one binding
    // to avoid authorizing based on an unrelated Change.
    if (!requestedChangeId) {
      try {
        const allBindings = await store.listRoleBindings();
        const sessionBindings = allBindings.filter((b) => b.sessionId === agentId);
        if (sessionBindings.length > 1) {
          return { kind: 'deny', reason: `Ambiguous policy context: session ${agentId} is bound to multiple changes; tool must specify changeId` };
        }
        if (sessionBindings.length === 0) {
          // Truly unbound — allow (backward compatible).
          return next();
        }
        // Single binding: use it.
        const singleBinding = sessionBindings[0];
        binding = await resolveBinding(store, agentId, singleBinding.changeId);
      } catch {
        return { kind: 'deny', reason: 'Policy evaluation failed: binding lookup error' };
      }
    }

    if (!binding) return next();

    const { changeId, role, state } = binding;

    // Host-owned risk-profile gate: effective risk and gates are derived from
    // the store and policy config, never from model-supplied arguments.
    const riskDecision = await evaluateRisk(policyConfig, store, binding, exec);
    if (riskDecision) {
      await auditDenial(store, changeId, exec, agentId, role, state, riskDecision.code);
      return riskDecision;
    }

    // Allow change-control tools through — they have their own authorization layer.
    if (CHANGE_TOOL_NAMES.has(exec.name)) return next();

    // Apply role-based restrictions at the pre-execution boundary.
    if (role === 'planner' || role === 'reviewer') {
      await auditDenial(store, changeId, exec, agentId, role, state, 'ROLE_READ_ONLY');
      return { kind: 'deny', reason: `${role} role is read-only; ${exec.name} is denied` };
    }

    if (role === 'worker') {
      if (state !== 'IMPLEMENTING' && state !== 'REPAIR') {
        await auditDenial(store, changeId, exec, agentId, role, state, 'STATE_NOT_ALLOWED');
        return { kind: 'deny', reason: `Worker is not authorized in ${state} state; only IMPLEMENTING or REPAIR allowed` };
      }
    }

    return next();
  }

  return policyGate;
}

// ─── Governance helpers ─────────────────────────────────────────────────────

/** Whether this platform's filesystem compares paths case-insensitively. */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
const fold = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);

/** Argument keys carrying a single path (string) or a list of paths. */
const PATH_KEYS = ['path', 'file_path'];
const PATH_LIST_KEYS = ['paths', 'files'];

function extractPaths(args) {
  const out = [];
  for (const key of PATH_KEYS) if (typeof args?.[key] === 'string') out.push(args[key]);
  for (const key of PATH_LIST_KEYS) {
    if (Array.isArray(args?.[key])) {
      for (const value of args[key]) if (typeof value === 'string') out.push(value);
    }
  }
  return out;
}

/** Canonical check name, matching ChangeStore/PreflightRunner normalization. */
const checkName = (entry) => (typeof entry === 'string' ? entry : entry?.name);

/**
 * Recursively find required-checks payloads anywhere in tool arguments
 * (top-level, content-nested, alternate key spellings).
 * ponytail: depth-capped recursion; model arguments are JSON — acyclic.
 */
function findCheckAttempts(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return [];
  const found = [];
  if (Array.isArray(value)) {
    for (const item of value) found.push(...findCheckAttempts(item, depth + 1));
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if ((normalized === 'requiredchecks' || normalized === 'required_checks') && Array.isArray(nested)) {
      found.push(nested);
    } else {
      found.push(...findCheckAttempts(nested, depth + 1));
    }
  }
  return found;
}

/**
 * Resolve symlinks. Fail-closed for non-existent leaves: walk up to the
 * nearest existing ancestor and re-anchor the remaining segments there.
 */
async function canonicalize(path) {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    let dir = dirname(resolved);
    let rest = basename(resolved);
    while (true) {
      try {
        return join(await realpath(dir), rest);
      } catch {
        const up = dirname(dir);
        if (up === dir) return resolved;
        rest = join(basename(dir), rest);
        dir = up;
      }
    }
  }
}

/** Path === base or path nests under base (case-folded where applicable). */
function isWithin(canon, base) {
  const c = fold(canon);
  const b = fold(base);
  return c === b || c.startsWith(b + sep);
}

/**
 * Canonicalize a protected entry: absolute entries as-is, relative entries
 * against each workspace root. Returns the list of canonical protected bases.
 */
async function canonProtectedEntries(entries, canonRoots) {
  const out = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (isAbsolute(entry)) {
      out.push(await canonicalize(entry));
    } else {
      for (const root of canonRoots) out.push(await canonicalize(join(root, entry)));
    }
  }
  return out;
}

/**
 * Protected-entry match. A protected entry protects itself and everything
 * beneath it. With roots, entries match canonically; without roots, relative
 * entries fall back to a path-suffix match.
 */
function isProtected(canon, canonProtected, entries, hasRoots) {
  if (canonProtected.some((base) => isWithin(canon, base))) return true;
  if (!hasRoots) {
    const foldedCanon = fold(canon);
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry.length === 0 || isAbsolute(entry)) continue;
      const suffix = fold(resolve(sep, entry).slice(1));
      if (foldedCanon === suffix || foldedCanon.endsWith(sep + suffix)) return true;
    }
  }
  return false;
}

/**
 * Governance evaluation. Returns null when the call is allowed, or a
 * decision { kind: 'deny' | 'escalate', reason, code } to short-circuit it.
 * Deterministic apart from the fs realpath step: same fs + inputs yield the
 * same decision.
 */
async function evaluateGovernance(policy, exec) {
  // Fail closed: a governed policy must be explicitly host-owned.
  if (policy.owner !== 'host') {
    return deny('OWNER_NOT_HOST', 'Governance policy must be explicitly host-owned');
  }

  const args = exec?.arguments ?? {};

  // The governed project comes from host-owned config, not model arguments;
  // only an explicitly supplied conflicting projectId is a mismatch.
  const requestedProject = args.projectId ?? null;
  if (requestedProject !== null && requestedProject !== policy.projectId) {
    return deny('PROJECT_MISMATCH', `Action targets project "${requestedProject}", not governed project "${policy.projectId}"`);
  }

  // AC2/AC6: repository or call-site content cannot remove host-required checks.
  const required = (Array.isArray(policy.requiredChecks) ? policy.requiredChecks : [])
    .map(checkName).filter(Boolean);
  if (required.length > 0) {
    for (const attempt of findCheckAttempts(args)) {
      const names = attempt.map(checkName).filter(Boolean);
      const missing = required.filter((name) => !names.includes(name));
      if (missing.length > 0) {
        return deny('REQUIRED_CHECKS_REMOVED', `Cannot remove host-required checks: ${missing.join(', ')}`);
      }
    }
  }

  const paths = extractPaths(args);

  // Command-bearing tools with no extractable path (bash and similar) fail
  // closed under a governed project — their mutation surface is unbounded.
  if (paths.length === 0 && typeof args.command === 'string') {
    return deny('COMMAND_NOT_CONSTRAINABLE', `Tool "${exec.name}" carries a command with no constrainable path; denied under governed project`);
  }

  if (paths.length === 0) return null;

  const roots = Array.isArray(policy.workspaceRoots) ? policy.workspaceRoots : [];
  const canonRoots = [];
  for (const root of roots) canonRoots.push(await canonicalize(root));
  const protectedPaths = Array.isArray(policy.protectedPaths) ? policy.protectedPaths : [];
  const canonProtected = await canonProtectedEntries(protectedPaths, canonRoots);

  for (const path of paths) {
    const canon = await canonicalize(path);
    if (canonRoots.length > 0 && !canonRoots.some((base) => isWithin(canon, base))) {
      return deny('OUTSIDE_WORKSPACE_ROOTS', `Path is outside permitted workspace roots: ${path}`);
    }
    if (protectedPaths.length > 0 && isProtected(canon, canonProtected, protectedPaths, canonRoots.length > 0)) {
      if (policy.protectedPathPolicy === 'escalate') {
        return escalate('PROTECTED_PATH', `Protected path requires human escalation: ${path}`);
      }
      return deny('PROTECTED_PATH', `Protected path is denied: ${path}`);
    }
  }

  return null;
}

function deny(code, reason) {
  return { kind: 'deny', reason, code };
}

function escalate(code, reason) {
  return { kind: 'escalate', reason, code };
}

/** Tracks the last audited policy version per gate instance (closure key). */
const lastAuditedVersion = new WeakMap();

/**
 * Audit governance activity for a governed execution with the governing
 * policy version (AC5): one record per governed execution (allow/deny/
 * escalate), plus a POLICY_VERSION event when the governing version changes.
 * The store assigns eventIds (integer, strictly increasing); metadata only.
 */
async function auditGovernance(store, exec, sessionId, decision, policy) {
  const version = policy.policyVersion ?? policy.version ?? null;
  try {
    const toolName = exec?.name;
    if (lastAuditedVersion.get(store) !== undefined && lastAuditedVersion.get(store) !== version) {
      await store.appendAudit({
        changeId: exec?.arguments?.changeId ?? null,
        projectId: policy.projectId,
        type: 'POLICY_VERSION',
        role: 'governance',
        toolName,
        sessionId,
        from: lastAuditedVersion.get(store),
        to: version,
        ts: new Date().toISOString(),
      });
    }
    lastAuditedVersion.set(store, version);
    await store.appendAudit({
      changeId: exec?.arguments?.changeId ?? null,
      projectId: policy.projectId,
      type: decision ? (decision.kind === 'escalate' ? 'ESCALATION' : 'DENIAL') : 'GOVERNANCE_ALLOW',
      role: 'governance',
      toolName,
      sessionId,
      reason: decision?.code ?? 'ALLOWED',
      policyVersion: version,
      ts: new Date().toISOString(),
    });
  } catch {
    // Non-fatal: audit failures must not break tool execution flow
  }
}

/**
 * Audit a denied action. Records a DENIAL event with metadata only —
 * no raw sensitive arguments or tool content is included.
 */
async function auditDenial(store, changeId, exec, sessionId, role, state, reasonCode) {
  try {
    await store.appendAudit({
      eventId: Date.now() + Math.random(),
      changeId,
      type: 'DENIAL',
      role,
      state,
      toolName: exec.name,
      sessionId,
      reason: reasonCode,
      ts: new Date().toISOString(),
    });
  } catch {
    // Non-fatal: audit failures must not break tool execution flow
  }
}


// ─── T9.1 — mandatory governance mode ───────────────────────────────────────

/**
 * Read-only name shape, not an enumerated allow-list:
 *  - the classic file readers;
 *  - every '*_get', '*_list', '*_read', '*_status', '*_history', '*_events'
 *    tool from task/change/change-control is read-only by construction;
 *  - all other names are treated as mutating-capable by mandatory mode.
 * Fidelity beats a hard-coded whitelist: unknown NEW read tools fall into
 * the deny bucket (fail-closed), never into an erroneous allow.
 */
/**
 * Read-only tool allow-list. STRICT: only explicitly enumerated names classify
 * as read-only — a mutating tool MUST NOT be able to smuggle through with a
 * `-get`-suffix or arbitrary "reader" name. Hosts running extra read-only
 * tools can extend the list via `policy.readOnlyToolNames: string[]`.
 */
const READ_ONLY_TOOL_NAMES = new Set([
  'read', 'grep', 'glob', 'ls', 'cat', 'head', 'tail', 'find', 'search',
  // Read-only change-control / task-orchestrator surface (Phase 9 catalogue):
  'change_get', 'task_get', 'task_list', 'project_get', 'project_list',
  'milestone_get', 'milestone_list', 'task_events', 'task_list_links',
  'task_ready_to_run', 'task_board_list',
  // Actions catalogue confirmed READ-ONLY via task-orchestrator tooling
  'task_list_children', 'task_list_descendants', 'task_blocked_by_dependencies',
  'plan_import_preview',
]);""


function makeReadOnlyClassifier(extraNames) {
  const extras = Array.isArray(extraNames) ? extraNames.filter((n) => typeof n === 'string') : [];
  const names = new Set([...READ_ONLY_TOOL_NAMES, ...extras]);
  return (name) => typeof name === 'string' && name.length > 0 && names.has(name);
}

/**
 * Normalize caller-supplied arg keys — snake_case / camelCase / plain —
 * so scope resolution accepts the actual tool-surface spellings
 * (projectId AND project_id, workdir AND work_dir AND cwd, …).
 */
function normalizeGovernanceArgKey(key) {
  return String(key).toLowerCase().replace(/_/g, '');
}

function pickKey(args, canonical) {
  if (!args || typeof args !== 'object') return undefined;
  for (const [k, v] of Object.entries(args)) {
    if (normalizeGovernanceArgKey(k) === canonical && typeof v === 'string') return v;
  }
  return undefined;
}

/** Resolve the governance scope a tool call is acting on. */
async function resolveGovernanceScope(store, args) {
  const workspace = pickKey(args, 'workspace')
    ?? pickKey(args, 'workspacepath')
    ?? pickKey(args, 'workdir')
    ?? pickKey(args, 'workdirpath')
    ?? pickKey(args, 'cwd')
    ?? null;
  const projectId = pickKey(args, 'projectid') ?? null;
  // A path-bearing mutating tool targets the containing workspace when the
  // mode map configures one whose prefix contains the path.
  const path = pickKey(args, 'path') ?? pickKey(args, 'filepath') ?? null;
  const mode = await store.getGovernanceMode({ projectId, workspace, path });
  return { projectId, workspace, path, mode };
}

const KNOWN_GOVERNANCE_ROLES = new Set(['planner', 'worker', 'reviewer']);


/** Conservative static default (no host-configured extras). */
const isReadOnlyToolByDefault = makeReadOnlyClassifier(null);

/**
 * Mandatory mode enforcement: in 'required' mode every mutating call must
 * satisfy ALL of, in order:
 *   1) governance mode resolution works (fail-closed when the lookup ends
 *      with a store error);
 *   2) the executing session is identifiable (no agent id → not associateable
 *      with a governed task → denied);
 *   3) a task-context provider is registered (integration package);
 *   4) the provider associates this session with a governed task;
 *   5) the session has a KNOWN role binding on an ACTIVE, NON-TERMINAL
 *      Change; unknown roles are denied outright (role confusion).
 * The 'optional' mode is informational: nothing is denied, nothing is
 * required (today).
 */
async function evaluateMandatoryGovernance(store, exec, agentId, isReadOnlyToolName = isReadOnlyToolByDefault) {
  // Read-only tools are NEVER gated by mandatory mode (AC of T9.1).
  if (isReadOnlyToolName(exec?.name)) return null;
  // Store API predating T9.1 (legacy test fixtures / compositional callers
  // holding a pre-T9.1 store): mandatory governance is not enforceable.
  if (typeof store.getGovernanceMode !== 'function') return null;
  let mode;
  try {
    const resolved = await resolveGovernanceScope(store, exec?.arguments ?? {});
    mode = resolved.mode;
  } catch (err) {
    // Fail-closed: a store error on mode resolution must not silently open
    // the mutation path.
    return deny('GOVERNANCE_MODE_LOOKUP_FAILED',
      `[GOVERNANCE_MODE_LOOKUP_FAILED] governance mode resolution failed: ${err?.message ?? err}`);
  }
  if (mode !== 'required') return null;

  if (typeof agentId !== 'string' || agentId.length === 0) {
    return deny('CHANGE_CONTROL_REQUIRED',
      '[CHANGE_CONTROL_REQUIRED] mandatory governance: no session identity available; cannot relate this call to a governed task.');
  }

  const provider = getGovernanceProvider(store);
  if (!provider) {
    return deny('GOVERNANCE_PROVIDER_MISSING',
      '[GOVERNANCE_PROVIDER_MISSING] mandatory governance is required but no task-context provider is registered; operation denied (fail-closed).');
  }

  /** @type {{ taskId?: string|null, taskStatus?: string|null, changeId?: string|null, role?: string|null } | null} */
  let taskCtx = null;
  try {
    taskCtx = await provider.lookup({ sessionId: agentId });
  } catch (err) {
    return deny('GOVERNANCE_PROVIDER_FAILURE', `[GOVERNANCE_PROVIDER_FAILURE] task-context provider failed: ${err?.message ?? err}`);
  }
  if (!taskCtx || typeof taskCtx.taskId !== 'string' || !taskCtx.taskId) {
    return deny('CHANGE_CONTROL_REQUIRED',
      '[CHANGE_CONTROL_REQUIRED] session is not associated with a governed task; bind before mutating. nextAction: claim the governed task and complete governed dispatch.');
  }

  // Role + Change-state enforcement. The legacy branches below are skipped
  // in required mode, so this gate OWNS role/state decisions.
  let bindings = [];
  try {
    bindings = await store.listRoleBindings();
  } catch (err) {
    return deny('GOVERNANCE_BINDINGS_LOOKUP_FAILED', `[GOVERNANCE_BINDINGS_LOOKUP_FAILED] ${err?.message ?? err}`);
  }
  const bySession = bindings.filter((b) => b.sessionId === agentId);
  const requestedChangeId = exec?.arguments?.changeId ?? null;
  let binding = null;
  let change = null;
  if (requestedChangeId) {
    binding = bySession.find((b) => b.changeId === requestedChangeId) ?? null;
  } else if (bySession.length === 1) {
    binding = bySession[0];
  } else if (bySession.length > 1) {
    return deny('CHANGE_CONTROL_REQUIRED',
      '[CHANGE_CONTROL_REQUIRED] session is bound to multiple Changes; tool must specify changeId. nextAction: add changeId.');
  }
  if (!binding) {
    return deny('CHANGE_CONTROL_REQUIRED',
      '[CHANGE_CONTROL_REQUIRED] session is not bound to the target Change. nextAction: bindRole as worker/reviewer/planner first.');
  }
  if (typeof binding.role !== 'string' || !KNOWN_GOVERNANCE_ROLES.has(binding.role)) {
    return deny('CHANGE_CONTROL_REQUIRED',
      `[CHANGE_CONTROL_REQUIRED] role "${binding.role}" is invalid; only planner/worker/reviewer may mutate. nextAction: re-bind an allowed role.`);
  }
  try {
    change = await store.get(binding.changeId);
  } catch (err) {
    return deny('GOVERNANCE_CHANGE_LOOKUP_FAILED', `[GOVERNANCE_CHANGE_LOOKUP_FAILED] ${err?.message ?? err}`);
  }
  const state = change?.state;
  if (binding.role === 'planner' || binding.role === 'reviewer') {
    return deny('CHANGE_CONTROL_REQUIRED',
      `[CHANGE_CONTROL_REQUIRED] role "${binding.role}" is read-only in mandatory mode; tool "${exec?.name}" is denied. nextAction: have a worker session execute the mutation.`);
  }
  if (!['IMPLEMENTING', 'REPAIR'].includes(state)) {
    return deny('CHANGE_CONTROL_REQUIRED',
      `[CHANGE_CONTROL_REQUIRED] Change ${change?.id} is in ${state}; workers may mutate only in IMPLEMENTING/REPAIR. nextAction: move the Change to IMPLEMENTING or REPAIR.`);
  }
  // Mark the exec as governance-cleared so the legacy branches skip.
  if (exec && typeof exec === 'object') exec.__mgHandled = true;
  return null;
}
