// @ts-nocheck
// G1 deterministic automatic-governance policy. Pure: no I/O, no clock, no
// randomness; the input task is never mutated (frozen inputs included).

const CAPTAIN_REASONS = Object.freeze({
  AUTHORIZATION: Object.freeze([
    'auth', 'authorization', 'authentication', 'authorize', 'permission',
    'permissions', 'access control', 'admin role', 'privilege', 'privileges',
  ]),
  BILLING_FINANCIAL: Object.freeze([
    'billing', 'payment', 'payments', 'invoice', 'invoices', 'financial',
    'subscription fee', 'refund', 'refunds', 'credit card', 'chargeback',
  ]),
  CI_RELEASE_AUTOMATION: Object.freeze([
    'github action', 'github actions', 'workflow file', 'ci workflow',
    'release automation', 'publish to npm', 'push to registry',
  ]),
  DESTRUCTIVE_OPERATION: Object.freeze([
    'delete', 'deleted', 'deleting', 'deletion', 'deletes', 'drop table',
    'drop column', 'drop database', 'drop schema', 'drop index',
    'drop the table', 'dropped', 'dropping', 'truncate', 'truncated', 'wipe',
    'wiped', 'purge', 'purged', 'erase', 'erased', 'irreversible', 'rm -rf',
    'rm -fr', 'unlink', 'overwrite', 'overwritten', 'hard reset',
  ]),
  EXTERNAL_MUTATION: Object.freeze([
    'external write', 'external writes', 'external mutation',
    'external mutations', 'external api', 'publish package', 'npm publish',
    'third party', 'third-party', 'webhook', 'outbound',
  ]),
  PERSISTENT_DATA_MIGRATION: Object.freeze([
    'schema change', 'schema migration', 'schema migrations', 'migration',
    'migrations', 'data migration', 'data migrations', 'alter table',
    'drop column', 'backfill',
  ]),
  SECRETS_CREDENTIALS: Object.freeze([
    'secret', 'secrets', 'credential', 'credentials', 'api key', 'api keys',
    'apikey', 'oauth', 'password', 'passwords', 'private key',
    'encryption key', 'access token',
  ]),
  SECURITY_BOUNDARY: Object.freeze([
    'crypt', 'crypto', 'cryptographic', 'encrypt', 'encrypted', 'encryption',
    'hmac signature', 'certificate', 'tls',
  ]),
  TOKEN_COUNTING: Object.freeze([
    'token budget', 'token count', 'token counting', 'token estimate',
    'token usage', 'count tokens', 'tokenize',
  ]),
});

class GovernancePolicyError extends Error {
  constructor(code, mode) {
    super(code === 'INVALID_GOVERNANCE_MODE'
      ? `invalid governance mode: ${String(mode)}`
      : 'invalid task');
    this.name = 'GovernancePolicyError';
    this.code = code;
    this.isGovernancePolicyError = true;
    if (mode !== undefined) this.mode = mode;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalize(value) {
  return String(value).toLowerCase().replaceAll('_', ' ');
}

// ponytail: zero-width lookarounds keep match.index anchored on the phrase
// start, so Rule C (final-word position) compares on the right index.
function phraseRegExp(phrase) {
  return new RegExp(
    `(?<![a-z0-9])(${phrase.replaceAll(' ', '[ -]')})(?![a-z0-9])`,
    'g',
  );
}

// [category, phrase, regExp] in CAPTAIN_REASONS key/phrase order.
const MATCHERS = Object.entries(CAPTAIN_REASONS).flatMap(([category, phrases]) =>
  phrases.map((phrase) => [category, phrase, phraseRegExp(phrase)]),
);

const CATEGORY_ORDER = Object.keys(CAPTAIN_REASONS);

function specificationStrings(node, out) {
  if (typeof node === 'string') {
    if (node.trim() !== '') out.push(node);
    return;
  }
  if (!isPlainObject(node) && !Array.isArray(node)) return;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    specificationStrings(value, out);
  }
}

// Rule B/C: among this category's phrases hitting the normalized text,
// report the one whose FINAL WORD starts earliest; ties prefer the shorter
// phrase.
function selectMatch(text, category) {
  let best = null; // [finalWordPos, phraseLength, phrase]
  for (const [cat, phrase, re] of MATCHERS) {
    if (cat !== category) continue;
    re.lastIndex = 0;
    const match = re.exec(text);
    if (!match) continue;
    const finalWordPos = match.index + phrase.lastIndexOf(' ') + 1;
    const length = phrase.length;
    if (
      best === null
      || finalWordPos < best[0]
      || (finalWordPos === best[0] && length < best[1])
    ) {
      best = [finalWordPos, length, phrase];
    }
  }
  return best === null ? null : { phrase: best[2] };
}

export function resolveGovernancePolicy(task) {
  if (!isPlainObject(task) || typeof task.id !== 'string' || task.id === '') {
    throw new GovernancePolicyError('INVALID_TASK');
  }

  // Absent mode (undefined) defaults to 'auto'; any present non-member value
  // (null, 5, false, 'sometimes', ...) fails closed with the raw value.
  const rawMode = isPlainObject(task.metadata) && isPlainObject(task.metadata.governance)
    ? task.metadata.governance.mode
    : undefined;
  const mode = rawMode === undefined ? 'auto' : rawMode;
  if (mode === 'off') return { required: false, mode: 'off', reasons: [] };
  if (mode === 'required') return { required: true, mode: 'required', reasons: [] };
  if (mode !== 'auto') {
    throw new GovernancePolicyError('INVALID_GOVERNANCE_MODE', mode);
  }

  // id and metadata are never scanned. Field precedence: title, description,
  // acceptance_criteria, specification.
  const fields = [
    ['title', typeof task.title === 'string' && task.title.trim() !== '' ? [task.title] : []],
    ['description', typeof task.description === 'string' && task.description.trim() !== '' ? [task.description] : []],
  ];
  const criteria = Array.isArray(task.acceptance_criteria)
    ? task.acceptance_criteria.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : [];
  fields.push(['acceptance_criteria', criteria]);
  const specificationTexts = [];
  specificationStrings(task.specification, specificationTexts);
  fields.push(['specification', specificationTexts]);

  // Rule A: exactly one entry per category; the surviving field is the
  // highest-precedence field where a phrase of that category hits; Rule B/C
  // selects the phrase within that field. One field may host hits for
  // several different categories.
  const reasons = [];
  for (const category of CATEGORY_ORDER) {
    for (const [field, texts] of fields) {
      let claim = null;
      for (const text of texts) {
        const match = selectMatch(normalize(text), category);
        if (match !== null) {
          claim = { field, phrase: match.phrase };
          break; // first matching text of this field claims the category
        }
      }
      if (claim !== null) {
        reasons.push({ id: category, field: claim.field, match: claim.phrase });
        break; // category already claimed; stop scanning lower-precedence fields
      }
    }
  }

  return {
    required: reasons.length > 0,
    mode: 'auto',
    reasons,
  };
}

export { CAPTAIN_REASONS, GovernancePolicyError };
