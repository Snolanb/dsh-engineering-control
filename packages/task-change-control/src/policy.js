// @ts-nocheck
// G1 deterministic automatic-governance policy. Pure: no I/O, no clock, no
// randomness; the input task is never mutated (frozen inputs included).
//
// Design notes (round-2 repair):
// - Multi-word phrases join their tokens with a whitespace run (\s+) so double
//   spaces / tabs agree with the single-space form (rm family included).
// - Destructive verbs use a hyphen-continuation boundary (?![a-z0-9]) so a
//   hyphen after the verb still fires it (delete-account, wipe-cache,
//   hard-reset) and hyphen/underscore/space forms agree. Known false-positive
//   compounds (drop-down, drag-and-drop, network drops) are kept out by
//   smallest local context guards, not a global denylist.
// - Ambiguous terms carry a guard: a guarded phrase only counts when its guard
//   confirms the local reading (billing subscription, write-mutating
//   third-party / external api, security-qualified signatures, doc-only
//   migration, UI reset, network-context drops, rotate+token co-occurrence).

const CAPTAIN_REASONS = Object.freeze({
  AUTHORIZATION: Object.freeze([
    'auth', 'authorization', 'authentication', 'authorize', 'authorized',
    'privileged', 'permission', 'permissions', 'access control', 'admin role',
  ]),
  BILLING_FINANCIAL: Object.freeze([
    'billing', 'payment', 'payments', 'invoice', 'invoices', 'financial',
    'subscription', 'refund', 'refunds', 'refunded', 'refunding',
    'credit card', 'chargeback',
  ]),
  CI_RELEASE_AUTOMATION: Object.freeze([
    'github action', 'github actions', 'workflow file', 'ci workflow',
    'release automation', 'publish to npm', 'push to registry',
  ]),
  DESTRUCTIVE_OPERATION: Object.freeze([
    'irreversible', 'rm -rf', 'rm -fr', 'rm -r',
    'delete', 'deleted', 'deleting', 'deletes', 'deletion',
    'drop', 'drops', 'dropped', 'dropping',
    'truncate', 'truncated', 'truncating', 'truncates',
    'purge', 'purges', 'purged', 'purging',
    'wipe', 'wipes', 'wiped', 'wiping',
    'erase', 'erases', 'erased', 'erasing',
    'overwrite', 'overwrites', 'overwrote', 'overwriting', 'overwritten',
    'unlink', 'unlinks', 'unlinked', 'reset',
  ]),
  EXTERNAL_MUTATION: Object.freeze([
    'external write', 'external writes', 'external mutation',
    'external mutations', 'external api', 'external apis',
    'publish', 'publishes', 'published', 'third-party', 'webhook',
    'webhooks', 'outbound',
  ]),
  PERSISTENT_DATA_MIGRATION: Object.freeze([
    'migration', 'migrations', 'schema change', 'schema migration',
    'schema migrations', 'data migration', 'data migrations', 'alter table',
    'backfill', 'backfills', 'backfilled',
  ]),
  SECRETS_CREDENTIALS: Object.freeze([
    'secret', 'secrets', 'credential', 'credentials', 'api key', 'api keys',
    'apikey', 'oauth', 'oauth2', 'password', 'passwords', 'private key',
    'private keys', 'encryption key', 'access token', 'access tokens',
    'bearer token', 'bearer tokens', 'refresh token', 'refresh tokens',
    'token', 'tokens',
  ]),
  SECURITY_BOUNDARY: Object.freeze([
    'crypt', 'crypto', 'cryptographic', 'encrypt', 'encrypted', 'encrypting',
    'encryption', 'hmac signature', 'signatures', 'certificate', 'tls',
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

// --- phrase source / boundary construction -------------------------------
// A hyphen-optional phrase (api key, credit card, third-party) accepts either
// a space or a hyphen between its words. The rm family accepts a whitespace
// run (space or tab) between "rm" and the flag token.
const SEP_OVERRIDES = new Map([
  ['api key', 'api[ -]key'],
  ['api keys', 'api[ -]keys'],
  ['credit card', 'credit[ -]card'],
  ['third-party', 'third[ -]party'],
]);
const RM_LABELS = new Set(['rm -rf', 'rm -fr', 'rm -r']);
const DESTRUCTIVE_VERBS = new Set([
  'delete', 'deleted', 'deleting', 'deletes', 'deletion',
  'drop', 'drops', 'dropped', 'dropping',
  'truncate', 'truncated', 'truncating', 'truncates',
  'purge', 'purges', 'purged', 'purging',
  'wipe', 'wipes', 'wiped', 'wiping',
  'erase', 'erases', 'erased', 'erasing',
  'overwrite', 'overwrites', 'overwrote', 'overwriting', 'overwritten',
  'unlink', 'unlinks', 'unlinked', 'reset',
]);

function sourceOf(label) {
  const override = SEP_OVERRIDES.get(label);
  if (override) return override;
  return label.split(' ').join('\\s+');
}

function phraseRegExp(label) {
  const source = sourceOf(label);
  // Destructive verbs: a hyphen is a word continuation, so it still fires.
  // Everything else: a hyphen is a compound boundary, so it does not fire.
  const lead = DESTRUCTIVE_VERBS.has(label) ? '(?<![a-z0-9])' : '(?<![a-z0-9-])';
  const trail = DESTRUCTIVE_VERBS.has(label) ? '(?![a-z0-9])' : '(?![a-z0-9-])';
  return new RegExp(`${lead}(${source})${trail}`, 'g');
}

// --- local context guards --------------------------------------------------
// tokens() splits on any non-alphanumeric run, so punctuation (comma, period,
// hyphen, slash, colon, parens, quotes) acts as a word boundary. This is what
// lets "write, via a third-party API" and "paid, subscription" resolve.
function tokens(text) {
  return text.split(/[^a-z0-9]+/).filter(Boolean);
}
function wordsBefore(text, index, n) {
  return tokens(text.slice(0, index)).slice(-n);
}
function wordsAfter(text, index, label, n) {
  return tokens(text.slice(index + label.length)).slice(0, n);
}
function nextWord(text, index, label) {
  return wordsAfter(text, index, label, 1)[0] ?? null;
}
function clauseHas(text, set) {
  return tokens(text).some((w) => set.has(w));
}

const NETWORK_WORDS = new Set([
  'network', 'networks', 'connection', 'connections', 'packet', 'packets',
  'latency', 'throughput', 'loss',
]);
const UI_ELEMENTS = new Set([
  'button', 'buttons', 'form', 'forms', 'field', 'fields', 'box', 'boxes',
  'bar', 'menu', 'panel', 'tab', 'tabs', 'link', 'links', 'toggle',
  'switch', 'css', 'file', 'files',
]);
const DOC_NOUNS = new Set([
  'guide', 'guides', 'doc', 'docs', 'documentation', 'book', 'books',
  'note', 'notes', 'page', 'pages', 'article', 'articles', 'readme',
  'manual', 'manuals',
]);
const WRITE_CONTEXT = new Set([
  'write', 'writes', 'writing', 'mutation', 'mutations', 'mutate', 'mutates',
  'webhook', 'webhooks', 'outbound', 'publish', 'publishes', 'published',
  'export', 'exports', 'post', 'posts',
]);
const BILLING_CONTEXT = new Set([
  'paid', 'customer', 'charge', 'charges', 'renew', 'renewal', 'renewals',
  'cancel', 'cancellation', 'cancellations', 'bill', 'billing',
  'payment', 'payments', 'refund', 'refunds', 'fee', 'fees',
]);
const SECURITY_QUALIFIERS = new Set([
  'hmac', 'request', 'requests', 'cryptographic', 'crypto', 'crypt',
  'signing', 'signature', 'sign', 'verify', 'verifies',
]);
const ROTATE_WORDS = new Set(['rotate', 'rotates', 'rotated', 'rotation']);
const SPECIFIC_TOKEN_PHRASES = [
  'bearer token', 'refresh token', 'access token', 'oauth token',
  'private key', 'private keys',
];
const BILLING_TRIGGER = new Set([
  'bill', 'billing', 'charge', 'charges', 'charged', 'charging', 'fee',
  'fees', 'paid', 'invoice', 'invoices', 'refund', 'refunds',
  'chargeback',
]);

// ponytail: each guard is the smallest local reading check for one ambiguous
// term. A guard returns true when the occurrence should count.
const GUARDS = new Map([
  // drop compounds: block drop-down and the drag-and-drag family.
  ['drop', (text, index) => {
    if (nextWord(text, index, 'drop') === 'down') return false;
    const before = wordsBefore(text, index, 2);
    if (before.length === 2 && before[0] === 'drag' && before[1] === 'and') return false;
    return true;
  }],
  // network-context drops/dropped/dropping stay ungoverned.
  ['drops', (text, index, label) => {
    const around = [...wordsBefore(text, index, 4), ...wordsAfter(text, index, label, 4)];
    return !around.some((w) => NETWORK_WORDS.has(w));
  }],
  ['dropped', (text, index, label) => {
    const around = [...wordsBefore(text, index, 4), ...wordsAfter(text, index, label, 4)];
    return !around.some((w) => NETWORK_WORDS.has(w));
  }],
  ['dropping', (text, index, label) => {
    const around = [...wordsBefore(text, index, 4), ...wordsAfter(text, index, label, 4)];
    return !around.some((w) => NETWORK_WORDS.has(w));
  }],
  // UI-control resets stay ungoverned; hard/data resets govern.
  ['reset', (text, index) => {
    const next = nextWord(text, index, 'reset');
    return next === null || !UI_ELEMENTS.has(next);
  }],
  // third-party / external api(s) govern only with an explicit write/mutation
  // operation over the local clause; reads/calls/fetches stay ungoverned.
  ['third-party', (text) => clauseHas(text, WRITE_CONTEXT)],
  ['external api', (text) => clauseHas(text, WRITE_CONTEXT)],
  ['external apis', (text) => clauseHas(text, WRITE_CONTEXT)],
  // signatures govern only with a security qualifier.
  ['signatures', (text) => clauseHas(text, SECURITY_QUALIFIERS)],
  // subscription governs only with billing context (renewal/renew included).
  ['subscription', (text, index, label) => {
    const around = [...wordsBefore(text, index, 4), ...wordsAfter(text, index, label, 4)];
    if (around.some((w) => BILLING_CONTEXT.has(w))) return true;
    const next = wordsAfter(text, index, label, 1)[0] ?? null;
    const prev = wordsBefore(text, index, 1)[0] ?? null;
    return (next !== null && BILLING_TRIGGER.has(next))
      || (prev !== null && BILLING_TRIGGER.has(prev));
  }],
  // migration family governs unless it names documentation.
  ['migration', (text, index, label) => {
    const next = nextWord(text, index, label);
    return next === null || !DOC_NOUNS.has(next);
  }],
  ['migrations', (text, index, label) => {
    const next = nextWord(text, index, label);
    return next === null || !DOC_NOUNS.has(next);
  }],
  ['schema migration', (text, index, label) => {
    const next = nextWord(text, index, label);
    return next === null || !DOC_NOUNS.has(next);
  }],
  ['schema migrations', (text, index, label) => {
    const next = nextWord(text, index, label);
    return next === null || !DOC_NOUNS.has(next);
  }],
  ['data migration', (text, index, label) => {
    const next = nextWord(text, index, label);
    return next === null || !DOC_NOUNS.has(next);
  }],
  ['data migrations', (text, index, label) => {
    const next = nextWord(text, index, label);
    return next === null || !DOC_NOUNS.has(next);
  }],
  // bare token/tokens govern only on rotate co-occurrence and only when no
  // more-specific token phrase is present; prompt token counting stays out.
  ['token', (text, index, label) => {
    if (!clauseHas(text, ROTATE_WORDS)) return false;
    return !SPECIFIC_TOKEN_PHRASES.some((p) => text.includes(p));
  }],
  ['tokens', (text, index, label) => {
    if (!clauseHas(text, ROTATE_WORDS)) return false;
    return !SPECIFIC_TOKEN_PHRASES.some((p) => text.includes(p));
  }],
]);

const MATCHERS = Object.entries(CAPTAIN_REASONS).flatMap(([category, labels]) =>
  labels.map((label) => [category, label, phraseRegExp(label), GUARDS.get(label) ?? null]));

const CATEGORY_ORDER = Object.keys(CAPTAIN_REASONS);

function specificationStrings(node, out, onStack) {
  if (typeof node === 'string') {
    if (node.trim() !== '') out.push(node);
    return;
  }
  if (!isPlainObject(node) && !Array.isArray(node)) return;
  // Fail closed on a cyclic specification: an object already on the active
  // recursion stack means the input is not a DAG; throw the typed error at
  // the validation boundary rather than crash with a raw RangeError.
  if (onStack.has(node)) throw new GovernancePolicyError('INVALID_TASK');
  onStack.add(node);
  try {
    for (const value of Array.isArray(node) ? node : Object.values(node)) {
      specificationStrings(value, out, onStack);
    }
  } finally {
    onStack.delete(node); // released once fully walked, so DAG re-visits are safe
  }
}

// Rule B/C: among this category's phrases hitting the normalized text, report
// the one whose FINAL WORD starts earliest; ties prefer the shorter phrase. A
// guarded phrase counts only when its guard confirms the local reading.
function selectMatch(text, category) {
  let best = null; // [finalWordPos, labelLength, label]
  for (const [cat, label, re, guard] of MATCHERS) {
    if (cat !== category) continue;
    re.lastIndex = 0;
    let match = re.exec(text);
    while (match !== null) {
      if (guard !== null && !guard(text, match.index, label)) {
        match = re.exec(text);
        continue;
      }
      const finalWordPos = match.index + label.lastIndexOf(' ') + 1;
      if (
        best === null
        || finalWordPos < best[0]
        || (finalWordPos === best[0] && label.length < best[1])
      ) {
        best = [finalWordPos, label.length, label];
        break; // earliest final-word position dominates
      }
      match = re.exec(text);
    }
  }
  return best === null ? null : { phrase: best[2] };
}

export function resolveGovernancePolicy(task) {
  if (!isPlainObject(task) || typeof task.id !== 'string' || task.id === '') {
    throw new GovernancePolicyError('INVALID_TASK');
  }

  // Fail closed on a cyclic specification at the validation boundary.
  const onStack = new WeakSet();
  const probeStrings = [];
  specificationStrings(task.specification, probeStrings, onStack);

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
  fields.push(['specification', probeStrings]);

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
