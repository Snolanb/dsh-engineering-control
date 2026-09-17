// @ts-nocheck
// G1 deterministic automatic-governance policy. Pure: no I/O, no clock, no
// randomness; the input task is never mutated (frozen inputs included).
//
// Design notes (round-3 repair):
// - Multi-word phrases join their tokens with a whitespace run (\s+) so double
//   spaces / tabs agree with the single-space form (rm family included;
//   flag-suffix tolerance on rm -rf / rm -fr: rm -rfv / rm -rfi still match).
// - Destructive operation compounds keep the hyphen-continuation boundary
//   (?![a-z0-9]) so a hyphen after the verb still fires it (delete-account,
//   wipe-cache, purge-cache, reset-sessions, hard-reset). The drop family is
//   excluded: its hyphen compounds (drop-in, drop-off) and space readings
//   (drop down/in/off/zone) are kept out by the smallest local guard, not a
//   global boundary flip.
// - Ambiguous terms carry a guard: a guarded phrase only counts when its guard
//   confirms the local reading (billing subscription with technical
//   realtime/event-stream/websocket suppression, write-mutating third-party /
//   external api(s) with verb-not-noun detection, security-qualified
//   signature(s), doc-only migration, UI reset with article-skipping,
//   network/measure-context drops, local-window rotate+token co-occurrence).

const CAPTAIN_REASONS = Object.freeze({
  AUTHORIZATION: Object.freeze([
    'auth', 'authorization', 'authentication', 'authorize', 'authorized',
    'unauthorized', 'authorizing',
    'privileged', 'privilege', 'privileges',
    'permission', 'permissions', 'access control', 'admin role',
  ]),
  BILLING_FINANCIAL: Object.freeze([
    'billing', 'payment', 'payments', 'invoice', 'invoices', 'invoiced',
    'invoicing', 'financial',
    'subscription', 'refund', 'refunds', 'refunded', 'refunding',
    'credit card', 'chargeback', 'chargebacks',
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
    'publish', 'publishes', 'published', 'publishing',
    'third-party', 'webhook', 'webhooks', 'outbound',
  ]),
  PERSISTENT_DATA_MIGRATION: Object.freeze([
    'migration', 'migrations', 'migrate', 'migrates', 'migrated',
    'schema change', 'schema migration',
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
    'encryption', 'hmac signature', 'signature', 'signatures',
    'certificate', 'certificates', 'tls',
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
// run (space or tab) between "rm" and the flag token, with flag-suffix
// tolerance: "rm -rfv" / "rm -rfi" still match the -rf / -fr labels.
const SEP_OVERRIDES = new Map([
  ['api key', 'api[ -]key'],
  ['api keys', 'api[ -]keys'],
  ['credit card', 'credit[ -]card'],
  ['third-party', 'third[ -]party'],
  ['rm -rf', 'rm\\s+-rf[iv]?'],
  ['rm -fr', 'rm\\s+-fr[iv]?'],
  ['rm -r', 'rm\\s+-r'],
]);
// Destructive operation compounds that must fire through a hyphen
// continuation (delete-account, wipe-cache, hard-reset, ...). The drop
// family is excluded: its compounds are UI / procedural readings handled by
// the local drop guard, so drop keeps the plain hyphen-as-boundary form.
const DESTRUCTIVE_VERBS = new Set([
  'delete', 'deleted', 'deleting', 'deletes', 'deletion',
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
// Guard-local tokenization. Guard call sites pass the actual matched span
// length (match[0].length) instead of label.length, so double-spaced
// multi-word phrases ("data  migration docs") still tokenize correctly
// after the phrase.
function wordsAfter(text, index, label, span, n) {
  return tokens(text.slice(index + span)).slice(0, n);
}
function nextWord(text, index, label, span) {
  return wordsAfter(text, index, label, span, 1)[0] ?? null;
}
function clauseHas(text, set) {
  return tokens(text).some((w) => set.has(w));
}

// Network / measure context that makes the drop family benign: "network
// drops", "price drops", "frame drops", "the fps drops", "rate drops".
const DROPS_CONTEXT = new Set([
  'network', 'networks', 'connection', 'connections', 'packet', 'packets',
  'latency', 'throughput', 'loss',
  'price', 'prices', 'frame', 'frames', 'fps', 'rate', 'rates',
  'temperature', 'temperatures',
]);

// UI elements for the reset guard. "file" / "files" are destructive targets,
// not UI elements; "css" still covers the reset.css reading.
const UI_ELEMENTS = new Set([
  'button', 'buttons', 'form', 'forms', 'field', 'fields', 'box', 'boxes',
  'bar', 'menu', 'panel', 'tab', 'tabs', 'link', 'links', 'toggle',
  'switch', 'css',
]);
const ARTICLES = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those']);
const DROP_FOLLOWERS = new Set(['down', 'in', 'off', 'zone']);
const DOC_NOUNS = new Set([
  'guide', 'guides', 'doc', 'docs', 'documentation', 'book', 'books',
  'note', 'notes', 'page', 'pages', 'article', 'articles', 'readme',
  'manual', 'manuals',
]);
// Outbound-mutation verb family: the write/mutation/publish/export families
// plus send / upload / push / sync / transmit / forward / stream / emit.
// Used as the local context that turns "third-party" or "external api(s)"
// into an EXTERNAL_MUTATION reading.
const WRITE_CONTEXT = new Set([
  'write', 'writes', 'writing',
  'mutation', 'mutations', 'mutate', 'mutates',
  'webhook', 'webhooks', 'outbound',
  'publish', 'publishes', 'published', 'publishing',
  'export', 'exports', 'post', 'posts',
  'send', 'sends', 'sending',
  'upload', 'uploads', 'uploaded', 'uploading',
  'push', 'pushes', 'pushed', 'pushing',
  'sync', 'syncs', 'synced', 'syncing',
  'transmit', 'transmits', 'transmitted', 'transmitting',
  'forward', 'forwards', 'forwarded', 'forwarding',
  'stream', 'streams', 'streaming',
  'emit', 'emits', 'emitted', 'emitting',
]);
// Principled read-vs-write distinction: a WRITE_CONTEXT word is a noun
// reading when a determiner or a read verb sits immediately before it
// ("read the posts", "fetch posts").
const READ_VERBS = new Set([
  'read', 'reads', 'fetch', 'fetches', 'call', 'calls',
  'list', 'lists', 'view', 'views', 'get', 'gets',
  'inspect', 'inspects', 'show', 'shows', 'download', 'downloads',
]);
const DETERMINERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'my', 'our', 'your', 'its', 'his', 'her',
]);
const BILLING_CONTEXT = new Set([
  'paid', 'customer', 'charge', 'charges', 'renew', 'renewal', 'renewals',
  'cancel', 'cancellation', 'cancellations', 'bill', 'billing',
  'payment', 'payments', 'refund', 'refunds', 'fee', 'fees',
]);
// Technical subscription context that suppresses the billing reading:
// realtime / event-stream / websocket plumbing, not money.
const TECHNICAL_SUBSCRIPTION = new Set([
  'realtime', 'websocket', 'event', 'stream',
]);
const SECURITY_QUALIFIERS = new Set([
  'hmac', 'request', 'requests', 'cryptographic', 'crypto', 'crypt',
  'signing', 'sign', 'verify', 'verifies',
]);
const ROTATE_WORDS = new Set([
  'rotate', 'rotates', 'rotated', 'rotating', 'rotation',
]);
const SPECIFIC_TOKEN_PHRASES = [
  'bearer token', 'refresh token', 'access token', 'oauth token',
  'private key', 'private keys',
];
const BILLING_TRIGGER = new Set([
  'bill', 'billing', 'charge', 'charges', 'charged', 'charging', 'fee',
  'fees', 'paid', 'invoice', 'invoiced', 'invoicing', 'invoices',
  'refund', 'refunds', 'chargeback', 'chargebacks',
]);

// Smallest-window write context around a third-party / external api(s)
// phrase: the phrase governs only when an outbound-mutation verb family
// word sits close to it (and is not a noun reading). Reads/calls/fetches
// of posts stay ungoverned; the comma-evasion positive ("write, via a
// third-party API, ...") is preserved.
function hasWriteContext(text, index, label, span) {
  const window = [...wordsBefore(text, index, 5), ...wordsAfter(text, index, label, span, 5)];
  for (let i = 0; i < window.length; i++) {
    if (!WRITE_CONTEXT.has(window[i])) continue;
    const prev = i > 0 ? window[i - 1] : null;
    if (prev !== null && (DETERMINERS.has(prev) || READ_VERBS.has(prev))) continue;
    return true;
  }
  return false;
}

// Rotate + token co-occurrence, local window: a rotate-family word within
// 3 words of the token occurrence. Cross-clause "rotate ... and ...
// tokens" prose does not fire; specific token phrases take precedence.
function rotateTokenGuard(text, index, label, span) {
  if (SPECIFIC_TOKEN_PHRASES.some((p) => text.includes(p))) return false;
  const around = [...wordsBefore(text, index, 3), ...wordsAfter(text, index, label, span, 3)];
  return around.some((w) => ROTATE_WORDS.has(w));
}

// ponytail: each guard is the smallest local reading check for one ambiguous
// term. A guard returns true when the occurrence should count. Guards receive
// (text, index, label, span) where span is the actual matched span length.
const GUARDS = new Map([
  // drop family: only "drag and drop" / "drop down/in/off/zone" are
  // non-destructive readings; "drop the users table" stays governed.
  ['drop', (text, index, label, span) => {
    const next = nextWord(text, index, label, span);
    if (next !== null && DROP_FOLLOWERS.has(next)) return false;
    const before = wordsBefore(text, index, 2);
    if (before.length === 2 && before[0] === 'drag' && before[1] === 'and') return false;
    return true;
  }],
  // network / measure-context drops/dropped/dropping stay ungoverned.
  ['drops', (text, index, label, span) => {
    const around = [...wordsBefore(text, index, 4), ...wordsAfter(text, index, label, span, 4)];
    return !around.some((w) => DROPS_CONTEXT.has(w));
  }],
  ['dropped', (text, index, label, span) => {
    const around = [...wordsBefore(text, index, 4), ...wordsAfter(text, index, label, span, 4)];
    return !around.some((w) => DROPS_CONTEXT.has(w));
  }],
  ['dropping', (text, index, label, span) => {
    const around = [...wordsBefore(text, index, 4), ...wordsAfter(text, index, label, span, 4)];
    return !around.some((w) => DROPS_CONTEXT.has(w));
  }],
  // "wipe-down" is a teardown procedure, not a destructive wipe.
  ['wipe', (text, index, label, span) => nextWord(text, index, label, span) !== 'down'],
  // UI-control resets stay ungoverned; an article between reset and the UI
  // noun is skipped ("reset the form" / "reset a button"); file targets and
  // hard/data resets govern.
  ['reset', (text, index, label, span) => {
    const after = wordsAfter(text, index, label, span, 2);
    if (UI_ELEMENTS.has(after[0])) return false;
    if (ARTICLES.has(after[0]) && UI_ELEMENTS.has(after[1])) return false;
    return true;
  }],
  // third-party / external api(s) govern only with a local write/mutation
  // operation; verb-not-noun detection keeps read/list/fetch/call of posts
  // ungoverned.
  ['third-party', hasWriteContext],
  ['external api', hasWriteContext],
  ['external apis', hasWriteContext],
  // signatures govern only with a security qualifier.
  ['signature', (text) => clauseHas(text, SECURITY_QUALIFIERS)],
  ['signatures', (text) => clauseHas(text, SECURITY_QUALIFIERS)],
  // subscription governs with billing context adjacency; technical
  // realtime / event-stream / websocket context suppresses the reading.
  ['subscription', (text, index, label, span) => {
    const around = [...wordsBefore(text, index, 4), ...wordsAfter(text, index, label, span, 4)];
    if (around.some((w) => TECHNICAL_SUBSCRIPTION.has(w))) return false;
    if (around.some((w) => BILLING_CONTEXT.has(w))) return true;
    const next = wordsAfter(text, index, label, span, 1)[0] ?? null;
    const prev = wordsBefore(text, index, 1)[0] ?? null;
    return (next !== null && BILLING_TRIGGER.has(next))
      || (prev !== null && BILLING_TRIGGER.has(prev));
  }],
  // migration family governs unless it names documentation.
  ['migration', (text, index, label, span) => {
    const next = nextWord(text, index, label, span);
    return next === null || !DOC_NOUNS.has(next);
  }],
  ['migrations', (text, index, label, span) => {
    const next = nextWord(text, index, label, span);
    return next === null || !DOC_NOUNS.has(next);
  }],
  ['schema migration', (text, index, label, span) => {
    const next = nextWord(text, index, label, span);
    return next === null || !DOC_NOUNS.has(next);
  }],
  ['schema migrations', (text, index, label, span) => {
    const next = nextWord(text, index, label, span);
    return next === null || !DOC_NOUNS.has(next);
  }],
  ['data migration', (text, index, label, span) => {
    const next = nextWord(text, index, label, span);
    return next === null || !DOC_NOUNS.has(next);
  }],
  ['data migrations', (text, index, label, span) => {
    const next = nextWord(text, index, label, span);
    return next === null || !DOC_NOUNS.has(next);
  }],
  // bare token/tokens govern only on local rotate co-occurrence and only
  // when no more-specific token phrase is present; prompt token counting
  // stays out.
  ['token', rotateTokenGuard],
  ['tokens', rotateTokenGuard],
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
      if (guard !== null && !guard(text, match.index, label, match[0].length)) {
        match = re.exec(text);
        continue;
      }
      const finalWordPos = match.index + label.lastIndexOf(' ') + 1;
      // Best: [finalWordPos, unguarded (1 beats 0), labelLength, label].
      // On a final-word tie the unguarded (more specific) phrase wins; with
      // equal guard status the shorter phrase wins.
      if (
        best === null
        || finalWordPos < best[0]
        || (finalWordPos === best[0] && (guard === null ? 1 : 0) > (best[1] ? 1 : 0))
        || (
          finalWordPos === best[0]
          && (guard === null ? 1 : 0) === (best[1] ? 1 : 0)
          && label.length < best[2]
        )
      ) {
        best = [finalWordPos, guard === null ? 1 : 0, label.length, label];
        break; // earliest final-word position dominates
      }
      match = re.exec(text);
    }
  }
  return best === null ? null : { phrase: best[3] };
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
