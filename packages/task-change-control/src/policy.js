// @ts-nocheck
// G1 deterministic automatic-governance policy. Pure: no I/O, no clock, no
// randomness; the input task is never mutated (frozen inputs included).
//
// Design notes (round-3 repair):
// - Multi-word phrases join their tokens with a whitespace run (\s+) so double
//   spaces / tabs agree with the single-space form (rm family included;
//   flag-suffix tolerance on rm -rf / rm -fr: rm -rfv / rm -rfi still match).
// - Hyphenated compounds are boundaries unless an explicit destructive
//   compound label is listed (delete-account, purge-cache, reset-sessions,
//   hard-reset). The drop family keeps its local guards for space readings
//   (drop down/in/off/zone) and measurement context.
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
    'delete-account',
    'drop', 'drops', 'dropped', 'dropping',
    'drop-table', 'drop-column', 'drop-database', 'drop-schema', 'drop-index',
    'truncate', 'truncated', 'truncating', 'truncates',
    'purge', 'purges', 'purged', 'purging', 'purge-cache',
    'wipe', 'wipes', 'wiped', 'wiping', 'wipe-cache',
    'erase', 'erases', 'erased', 'erasing',
    'overwrite', 'overwrites', 'overwrote', 'overwriting', 'overwritten',
    'unlink', 'unlinks', 'unlinked', 'reset', 'reset-sessions', 'hard-reset',
  ]),
  EXTERNAL_MUTATION: Object.freeze([
    'external write', 'external writes', 'external mutation',
    'external mutations', 'external api', 'external apis',
    'publish', 'publishes', 'published', 'publishing',
    'third-party', 'third party', 'webhook', 'webhooks', 'outbound',
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

function isObjectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isTopLevelTask(value) {
  if (!isObjectLike(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
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
function sourceOf(label) {
  const override = SEP_OVERRIDES.get(label);
  if (override) return override;
  return label.split(' ').join('\\s+');
}

function phraseRegExp(label) {
  // A hyphen is a boundary unless it is part of the explicitly listed
  // compound label itself. This keeps delete-key / reset-to-form ordinary
  // compounds out while retaining delete-account / hard-reset coverage.
  return new RegExp(`(?<![a-z0-9-])(${sourceOf(label)})(?![a-z0-9-])`, 'g');
}

// --- local context guards --------------------------------------------------
// tokens() splits on any non-alphanumeric run, so punctuation (comma, period,
// hyphen, slash, colon, parens, quotes) acts as a word boundary. This is what
// lets "write, via a third-party API" and "paid, subscription" resolve.
function tokens(text) {
  return text.split(/[^a-z0-9]+/).filter(Boolean);
}
function tokenRecords(text) {
  const result = [];
  const re = /[a-z0-9]+/g;
  let match = re.exec(text);
  while (match !== null) {
    result.push({ word: match[0], start: match.index, end: match.index + match[0].length });
    match = re.exec(text);
  }
  return result;
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
function hasHardBoundary(text, start, end, includeComma = false) {
  const separators = includeComma ? /[,.!?;()[\]{}]/ : /[.!?;()[\]{}]/;
  return separators.test(text.slice(Math.min(start, end), Math.max(start, end)));
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
const DROP_MEASURE_NOUNS = new Set([
  'packet', 'packets', 'frame', 'frames', 'fps', 'rate', 'rates',
  'price', 'prices', 'temperature', 'temperatures',
]);
const DROP_METRIC_CONTINUATIONS = new Set([
  'under', 'during', 'while', 'in', 'by', 'from', 'at', 'over', 'per',
  'below', 'above', 'occur', 'occurs', 'occurred', 'continue', 'continues',
  'continued', 'gracefully', 'sharply', 'suddenly', 'significantly',
  'intermittently', 'overnight', 'unexpectedly',
]);

// UI elements for the reset guard. "file" / "files" are destructive targets,
// not UI elements; "css" still covers the reset.css reading.
const UI_ELEMENTS = new Set([
  'button', 'buttons', 'form', 'forms', 'field', 'fields', 'box', 'boxes',
  'bar', 'menu', 'panel', 'tab', 'tabs', 'link', 'links', 'toggle',
  'switch', 'css',
]);
const ARTICLES = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'my', 'our', 'your', 'its', 'his', 'her', 'all', 'any', 'each', 'every',
]);
const DROP_FOLLOWERS = new Set(['down', 'in', 'off', 'zone']);
const DOC_NOUNS = new Set([
  'guide', 'guides', 'doc', 'docs', 'documentation', 'book', 'books',
  'note', 'notes', 'page', 'pages', 'article', 'articles', 'readme',
  'manual', 'manuals', 'nav', 'navigation', 'changelog',
]);
// Outbound-mutation verb family: the write/mutation/publish/export families
// plus send / upload / push / sync / transmit / forward / stream / emit.
// Used as the local context that turns "third-party" or "external api(s)"
// into an EXTERNAL_MUTATION reading.
const WRITE_CONTEXT = new Set([
  'write', 'writes', 'writing', 'written',
  'mutation', 'mutations', 'mutate', 'mutates',
  'webhook', 'webhooks', 'outbound',
  'publish', 'publishes', 'published', 'publishing',
  'export', 'exports', 'post', 'posts', 'posted', 'posting',
  'send', 'sends', 'sending', 'sent',
  'upload', 'uploads', 'uploaded', 'uploading',
  'push', 'pushes', 'pushed', 'pushing',
  'sync', 'syncs', 'synced', 'syncing', 'synchronizing',
  'transmit', 'transmits', 'transmitted', 'transmitting',
  'forward', 'forwards', 'forwarded', 'forwarding',
  'stream', 'streams', 'streamed', 'streaming',
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
  'my', 'our', 'your', 'its', 'his', 'her', 'all', 'any', 'each', 'every',
]);
const CLAUSE_WORDS = new Set(['and', 'or', 'but', 'then', 'while', 'although']);
const PREPOSITIONS = new Set([
  'to', 'via', 'through', 'using', 'over', 'into', 'onto', 'against', 'from',
]);
const LOCAL_TARGET_WORDS = new Set([
  'local', 'localhost', 'cache', 'caches', 'filesystem', 'file', 'files',
  'disk', 'buffer', 'buffers', 'queue', 'queues', 'memory', 'temporary', 'temp',
]);
const PUBLISH_TARGETS = new Set([
  'artifact', 'artifacts', 'package', 'packages', 'release', 'releases',
  'version', 'versions', 'registry', 'npm', 'repository', 'repositories',
  'bundle', 'bundles', 'image', 'images', 'feed', 'feeds',
]);
const BILLING_CONTEXT = new Set([
  'paid', 'customer', 'charge', 'charges', 'renew', 'renewal', 'renewals',
  'cancel', 'cancellation', 'cancellations', 'bill', 'billing',
  'payment', 'payments', 'refund', 'refunds', 'fee', 'fees',
]);
// Technical subscription context that suppresses the billing reading:
// realtime / event-stream / websocket plumbing, not money.
const TECHNICAL_SUBSCRIPTION = new Set([
  'realtime', 'websocket', 'stream', 'streams', 'streaming', 'sse',
]);
const SECURITY_QUALIFIERS = new Set([
  'hmac', 'request', 'requests', 'cryptographic', 'crypto', 'crypt',
  'signing', 'sign', 'signed', 'verify', 'verifies', 'verified', 'verification',
  'certificate', 'certificates', 'tls',
]);
const ROTATE_WORDS = new Set([
  'rotate', 'rotates', 'rotated', 'rotating', 'rotation',
]);
const BILLING_TRIGGER = new Set([
  'bill', 'billing', 'charge', 'charges', 'charged', 'charging', 'fee',
  'fees', 'paid', 'invoice', 'invoiced', 'invoicing', 'invoices',
  'refund', 'refunds', 'chargeback', 'chargebacks',
]);

// An external/third-party API phrase governs only when a nearby outbound
// action is syntactically related to it. The relation is deliberately local:
// clause conjunctions and parenthetical boundaries stop it from becoming a
// whole-field co-occurrence test.
const AMBIGUOUS_WRITE_NOUNS = new Set([
  'write', 'writes', 'post', 'posts', 'export', 'exports',
]);
function hasWriteContext(text, index, label, span) {
  const records = tokenRecords(text);
  const before = records.filter((record) => record.end <= index);
  const after = records.filter((record) => record.start >= index + span);
  const nearbyBefore = before.slice(-8);
  const nearbyAfter = after.slice(0, 8);
  const nearby = [...nearbyBefore, ...nearbyAfter];
  const isThirdParty = label === 'third-party' || label === 'third party';

  // A bare third-party vendor/local reference is not enough. The API phrase
  // must be present in the same local window; webhook has its own matcher.
  if (isThirdParty && !nearby.some(({ word }) => word === 'api' || word === 'apis')) {
    return false;
  }
  if (isThirdParty && nearbyAfter.slice(0, 4).some(({ word }) => LOCAL_TARGET_WORDS.has(word))) {
    return false;
  }

  for (const action of nearby) {
    if (!WRITE_CONTEXT.has(action.word)) continue;
    const actionIndex = records.indexOf(action);
    const actionBefore = records[actionIndex - 1]?.word ?? null;
    const actionAfter = records[actionIndex + 1]?.word ?? null;
    if (DETERMINERS.has(actionBefore) || READ_VERBS.has(actionBefore)) continue;
    if (action.word === 'publishing' && !PUBLISH_TARGETS.has(actionAfter)) continue;
    if (AMBIGUOUS_WRITE_NOUNS.has(action.word)
      && nearbyBefore.some(({ word }) => READ_VERBS.has(word))) continue;

    if (action.end <= index) {
      const between = records.filter((record) => record.start >= action.end && record.end <= index);
      if (between.some(({ word }) => CLAUSE_WORDS.has(word))) continue;
      if (hasHardBoundary(text, action.end, index)) continue;
      const prepositionIndex = between.findIndex(({ word }) => PREPOSITIONS.has(word));
      if (prepositionIndex !== -1
        && between.slice(prepositionIndex + 1).some(({ word }) => LOCAL_TARGET_WORDS.has(word))) {
        continue;
      }
      return true;
    }

    if (action.start >= index + span) {
      const between = records.filter((record) => record.start >= index + span && record.end <= action.start);
      if (between.some(({ word }) => CLAUSE_WORDS.has(word))) continue;
      if (hasHardBoundary(text, index + span, action.start)) continue;
      const following = records.slice(actionIndex + 1, actionIndex + 5);
      const prepositionIndex = following.findIndex(({ word }) => PREPOSITIONS.has(word));
      if (prepositionIndex !== -1
        && following.slice(prepositionIndex + 1).some(({ word }) => LOCAL_TARGET_WORDS.has(word))) {
        continue;
      }
      if (following.slice(0, 2).some(({ word }) => LOCAL_TARGET_WORDS.has(word))) continue;
      return true;
    }
  }
  return false;
}

// A bare token is material only when a rotate-family word is before the same
// token occurrence. This handles adjectives while rejecting reverse-order and
// cross-clause prose such as "Count tokens and rotate the dashboard".
function rotateTokenGuard(text, index, label, span) {
  const records = tokenRecords(text);
  const tokenIndex = records.findIndex((record) => record.start === index);
  if (tokenIndex === -1) return false;
  const previous = records.slice(Math.max(0, tokenIndex - 7), tokenIndex);
  const rotateIndex = previous.findIndex(({ word }) => ROTATE_WORDS.has(word));
  if (rotateIndex === -1) return false;
  const rotate = previous[rotateIndex];
  const between = previous.slice(rotateIndex + 1);
  if (between.some(({ word }) => CLAUSE_WORDS.has(word))) return false;
  if (hasHardBoundary(text, rotate.end, index)) return false;
  const prior = records[tokenIndex - 1]?.word ?? null;
  return !['bearer', 'refresh', 'access', 'oauth'].includes(prior);
}

function dropGuard(text, index, label, span) {
  const after = wordsAfter(text, index, label, span, 4);
  const next = after.find((word) => !DETERMINERS.has(word)) ?? null;
  if (next !== null && DROP_FOLLOWERS.has(next)) return false;
  const before = wordsBefore(text, index, 3);
  if (before.slice(-2).join(' ') === 'drag and') return false;
  // A metric noun is the object/subject of a loss measurement, not a
  // destructive target. Context after a non-metric object is intentionally
  // ignored: "drops events from the frame queue" must still govern.
  if (next !== null && DROP_MEASURE_NOUNS.has(next)) return false;
  if ((next === null || DROP_METRIC_CONTINUATIONS.has(next))
    && before.some((word) => DROPS_CONTEXT.has(word))) {
    return false;
  }
  return true;
}

function hasLocalQualifier(text, index, span, qualifiers) {
  const records = tokenRecords(text);
  const before = records.filter((record) => record.end <= index).slice(-5);
  const after = records.filter((record) => record.start >= index + span).slice(0, 5);
  for (const candidate of [...before, ...after]) {
    if (!qualifiers.has(candidate.word)) continue;
    if (hasHardBoundary(text, candidate.end, index, true)
      || hasHardBoundary(text, index + span, candidate.start, true)) continue;
    const between = records.filter((record) => (
      candidate.end <= record.start && record.end <= index
    ) || (
      index + span <= record.start && record.end <= candidate.start
    ));
    if (between.some(({ word }) => CLAUSE_WORDS.has(word))) continue;
    return true;
  }
  return false;
}

function subscriptionGuard(text, index, label, span) {
  const around = [...wordsBefore(text, index, 5), ...wordsAfter(text, index, label, span, 5)];
  if (around.some((word) => TECHNICAL_SUBSCRIPTION.has(word))) return false;
  if (around.some((word) => BILLING_CONTEXT.has(word))) return true;
  const next = nextWord(text, index, label, span);
  const prev = wordsBefore(text, index, 1)[0] ?? null;
  return (next !== null && BILLING_TRIGGER.has(next))
    || (prev !== null && BILLING_TRIGGER.has(prev));
}

function migrationGuard(text, index, label, span) {
  const after = wordsAfter(text, index, label, span, 4);
  let position = 0;
  while (position < after.length && ARTICLES.has(after[position])) position += 1;
  return !DOC_NOUNS.has(after[position]);
}

function publishingGuard(text, index, label, span) {
  const after = wordsAfter(text, index, label, span, 5);
  let position = 0;
  while (position < after.length && DETERMINERS.has(after[position])) position += 1;
  if (PUBLISH_TARGETS.has(after[position])) return true;
  if (PREPOSITIONS.has(after[position])) return true;
  return after.some((word, offset) => PREPOSITIONS.has(word)
    && after.slice(offset + 1).some((target) => PUBLISH_TARGETS.has(target)));
}

// ponytail: each guard is the smallest local reading check for one ambiguous
// term. A guard returns true when the occurrence should count. Guards receive
// (text, index, label, span) where span is the actual matched span length.
const GUARDS = new Map([
  ['drop', dropGuard],
  ['drops', dropGuard],
  ['dropped', dropGuard],
  ['dropping', dropGuard],
  ['wipe', (text, index, label, span) => nextWord(text, index, label, span) !== 'down'],
  ['reset', (text, index, label, span) => {
    const after = wordsAfter(text, index, label, span, 4);
    let position = 0;
    while (position < after.length && ARTICLES.has(after[position])) position += 1;
    return !UI_ELEMENTS.has(after[position]);
  }],
  ['third-party', hasWriteContext],
  ['third party', hasWriteContext],
  ['external api', hasWriteContext],
  ['external apis', hasWriteContext],
  ['signature', (text, index, label, span) => hasLocalQualifier(text, index, span, SECURITY_QUALIFIERS)],
  ['signatures', (text, index, label, span) => hasLocalQualifier(text, index, span, SECURITY_QUALIFIERS)],
  ['subscription', subscriptionGuard],
  ['migration', migrationGuard],
  ['migrations', migrationGuard],
  ['migrate', migrationGuard],
  ['migrates', migrationGuard],
  ['migrated', migrationGuard],
  ['schema migration', migrationGuard],
  ['schema migrations', migrationGuard],
  ['data migration', migrationGuard],
  ['data migrations', migrationGuard],
  ['publishing', publishingGuard],
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
  if (!isObjectLike(node) && !Array.isArray(node)) return;
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
  if (!isTopLevelTask(task) || typeof task.id !== 'string' || task.id === '') {
    throw new GovernancePolicyError('INVALID_TASK');
  }

  // Fail closed on a cyclic specification at the validation boundary.
  const onStack = new WeakSet();
  const probeStrings = [];
  specificationStrings(task.specification, probeStrings, onStack);

  // Absent mode (undefined) defaults to 'auto'; any present non-member value
  // (null, 5, false, 'sometimes', ...) fails closed with the raw value.
  const rawMode = isObjectLike(task.metadata) && isObjectLike(task.metadata.governance)
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
