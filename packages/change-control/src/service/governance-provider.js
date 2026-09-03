/**
 * Shared WeakMap: store → mandatory-governance task-context provider.
 * The integration package installs a provider via
 * `ctx.changeControl.registerGovernanceProvider(provider)`. The pre-execute
 * gate reads the provider for `required`-mode enforcement.
 * In-memory only — never persisted.
 */

/** @typedef {{ lookup: (args: { sessionId: string }) => Promise<{ taskId: string|null, taskStatus: string|null, changeId?: string|null, role?: string|null } | null> }} GovernanceProvider */

/** @type {WeakMap<object, GovernanceProvider | null>} */
const providers = new WeakMap();

/**
 * @param {object} store
 * @param {GovernanceProvider} provider
 */
export function registerGovernanceProvider(store, provider) {
  if (!provider || typeof provider !== 'object' || typeof provider.lookup !== 'function') {
    throw Object.assign(new Error('governance provider must expose lookup()'), { code: 'INVALID_GOVERNANCE_PROVIDER' });
  }
  providers.set(store, provider);
  return { unregister: () => providers.set(store, null) };
}

/**
 * @param {object} store
 * @returns {GovernanceProvider | null}
 */
export function getGovernanceProvider(store) {
  return providers.get(store) ?? null;
}
