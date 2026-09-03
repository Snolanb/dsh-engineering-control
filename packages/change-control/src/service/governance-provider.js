/**
 * Shared WeakMap: store → mandatory-governance task-context provider.
 * The integration package installs a provider via
 * `ctx.changeControl.registerGovernanceProvider(provider)`. The pre-execute
 * gate reads the provider for `required`-mode enforcement.
 * In-memory only — never persisted.
 */
/** @type {WeakMap<object, ({ lookup: (args: { sessionId: string }) => Promise<{ taskId: string|null, taskStatus: string|null }|null> })|null>} */
const providers = new WeakMap();

export function registerGovernanceProvider(store, provider) {
  if (!provider || typeof provider !== 'object' || typeof provider.lookup !== 'function') {
    throw Object.assign(new Error('governance provider must expose lookup()'), { code: 'INVALID_GOVERNANCE_PROVIDER' });
  }
  providers.set(store, provider);
  return { unregister: () => providers.set(store, null) };
}

export function getGovernanceProvider(store) {
  return providers.get(store) ?? null;
}
