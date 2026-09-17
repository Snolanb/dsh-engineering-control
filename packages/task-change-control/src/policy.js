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
    'subscription', 'refund', 'refunds', 'credit card', 'chargeback',
  ]),
  CI_RELEASE_AUTOMATION: Object.freeze([
    'github action', 'github actions', 'workflow file', 'ci workflow',
    'release automation', 'publish to npm', 'push to registry',
  ]),
  DESTRUCTIVE_OPERATION: Object.freeze([
    'irreversible', 'rm -rf', 'rm -fr', 'rm -r', 'delete', 'deleted',
    'deleting', 'deletes', 'drop', 'drops', 'dropped', 'truncate',
    'truncated', 'truncating', 'truncates', 'purge', 'purges', 'purged',
    'wipe', 'wipes', 'wiped', 'erase', 'erases', 'erased', 'overwrite',
    'overwrites', 'overwrote', 'unlink', 'unlinks', 'unlinked', 'reset',
    'drop table', 'drop column', 'drop database', 'drop schema',
    'drop index', 'drop the table',
  ]),
  EXTERNAL_MUTATION: Object.freeze([
    'external write', 'external writes', 'external mutation',
    'external mutations', 'external api', 'publish', 'publishes',
    'published', 'third party', 'third-party', 'webhook', 'webhooks',
    'outbound',
  ]),
  PERSISTENT_DATA_MIGRATION: Object.freeze([
    'migration', 'migrations', 'schema change', 'schema migration',
    'schema migrations', 'data migration', 'data migrations', 'alter table',
    'drop column', 'backfill', 'backfills', 'backfilled',
  ]),
  SECRETS_CREDENTIALS: Object.freeze([
    'secret', 'secrets', 'credential', 'credentials', 'api key', 'api keys',
    'apikey', 'oauth', 'password', 'passwords', 'private key',
    'encryption key', 'access token', 'bearer token', 'refresh token',
  ]),
  SECURITY_BOUNDARY: Object.freeze([
    'crypt', 'crypto', 'cryptographic', 'encrypt', 'encrypted', 'encryption',
    'hmac signature', 'signatures', 'certificate', 'tls',
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

// A multi-word phrase separates its words with a space that may appear as a
// space or a hyphen (credit-card, third-party, drop-down, ...). The api-key
// family additionally accepts an underscore (API_KEY).
function phraseSource(phrase) {
  const sep = /^(api keys?|apikey$)/i.test(phrase) ? '[ -_]' : '[ -]';
  return phrase.replaceAll(' ', sep);
}

// ponytail: the hyphen is treated as a word boundary for the destructive /
// migration / external-mutation families so that 'drop-down', 'drag-and-drop'
// and 'third-party' compounds resolve as their own exact phrases instead of
// silently inheriting a bare-stem hit.
function phraseRegExp(phrase) {
  const source = phraseSource(phrase);
  return new RegExp(
    `(?<![a-z0-9-])(${source})(?![a-z0-9-])`,
    'g',
  );
}

// Minimal local context guards for the genuinely ambiguous terms. Each guard
// is a tiny pure function of (text, matchIndex, label); a guarded phrase
// only counts when its guard returns true. No global denylist is introduced.
function wordAfter(text, index, label) {
  const rest = text.slice(index + label.length);
  const m = rest.match(/^\s*([a-z0-9]+(?:-[a-z0-9]+)*)/);
  return m ? m[1] : null;
}
function wordBefore(text, index) {
  const head = text.slice(0, index);
  const m = head.match(/([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/);
  return m ? m[1] : null;
}
function nearbyWord(text, index, label, window) {
  const words = text.slice(0).split(/\s+/).filter(Boolean);
  // Approximate the phrase's word position by counting whitespace up to the
  // index, then the label length in words (1) — good enough for a small
  // guard window and free of regex backtracking.
  const upTo = text.slice(0, index);
  const phraseWord = upTo.split(/\s+/).filter(Boolean).length;
  const around = words.slice(
    Math.max(0, phraseWord - window),
    phraseWord + 1 + window,
  ).filter((w) => w !== label.toLowerCase());
  return around;
}
const hasAny = (words, set) => words.some((w) => set.has(w));

const BILLING_CONTEXT = new Set([
  'paid', 'customer', 'charge', 'renew', 'cancel', 'bill', 'billing',
  'payment', 'payments', 'refund', 'refunds', 'fee',
]);
const WRITE_CONTEXT = new Set([
  'write', 'writes', 'writing', 'mutation', 'mutations', 'webhook',
  'outbound', 'publish', 'publishes', 'published',
]);
const DOC_NOUNS = new Set([
  'guide', 'guides', 'docs', 'documentation', 'book', 'books', 'notes',
  'note', 'page', 'pages', 'article', 'articles', 'readme',
]);
const UI_ELEMENTS = new Set([
  'button', 'form', 'field', 'fields', 'box', 'bar', 'menu', 'panel',
  'tab', 'tabs', 'link', 'toggle', 'switch',
]);

// ponytail: two guarded contexts keep the smallest local reading correct —
// a 'subscription' only governs with billing context, a 'third-party' only
// with an explicit write/mutation operation.
function subscriptionGuard(text, index, label) {
  return hasAny(nearbyWord(text, index, label, 3), BILLING_CONTEXT);
}
function thirdPartyGuard(text, index, label) {
  return hasAny(nearbyWord(text, index, label, 3), WRITE_CONTEXT);
}
// 'migration' / 'migrations' stay ungoverned when they are documentation.
function migrationGuard(text, index, label) {
  const next = wordAfter(text, index, label);
  return next === null || !DOC_NOUNS.has(next);
}
// 'reset' stays ungoverned for UI controls.
function resetGuard(text, index, label) {
  const next = wordAfter(text, index, label);
  return next === null || !UI_ELEMENTS.has(next);
}
// 'drops' (the plural noun) stays ungoverned for network packet loss.
function dropsGuard(text, index) {
  const prev = wordBefore(text, index);
  return prev !== 'network';
}

// [category, label, regExp, guard] in CAPTAIN_REASONS key/label order; the
// four guarded labels are wired to their local guards, everything else is
// a plain exact match.
const GUARDED = new Map([
  ['subscription', subscriptionGuard],
  ['third party', thirdPartyGuard],
  ['third-party', thirdPartyGuard],
  ['migration', migrationGuard],
  ['migrations', migrationGuard],
  ['reset', resetGuard],
  ['drops', dropsGuard],
]);

const MATCHERS = Object.entries(CAPTAIN_REASONS).flatMap(([category, labels]) =>
  labels.map((label) => {
    const guard = GUARDED.get(label) ?? null;
    return [category, label, phraseRegExp(label), guard];
  }));

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
// phrase. A guarded phrase counts only when its guard confirms the local
// reading at that occurrence.
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
