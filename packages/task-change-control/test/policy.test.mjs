import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../src/policy.js';

const {
  CAPTAIN_REASONS,
  GovernancePolicyError,
  PREFIX_STEMS,
  resolveGovernancePolicy,
} = policy;

const EXPECTED_REASON_IDS = [
  'AUTHORIZATION',
  'BILLING_FINANCIAL',
  'CI_RELEASE_AUTOMATION',
  'DESTRUCTIVE_OPERATION',
  'EXTERNAL_MUTATION',
  'PERSISTENT_DATA_MIGRATION',
  'SECRETS_CREDENTIALS',
  'SECURITY_BOUNDARY',
  'TOKEN_COUNTING',
];

const EXPECTED_CAPTAIN_REASONS = {
  AUTHORIZATION: [
    'auth', 'authorization', 'authentication', 'authorize', 'permission',
    'permissions', 'access control', 'admin role', 'privilege', 'privileges',
  ],
  BILLING_FINANCIAL: [
    'billing', 'payment', 'payments', 'invoice', 'invoices', 'financial',
    'subscript', 'refund', 'refunds', 'credit card', 'chargeback',
  ],
  CI_RELEASE_AUTOMATION: [
    'github action', 'github actions', 'workflow file', 'ci workflow',
    'release automation', 'publish to npm', 'push to registry',
  ],
  DESTRUCTIVE_OPERATION: [
    'irreversible', 'rm -rf', 'rm -fr', 'rm -r', 'delet', 'drop', 'truncat',
    'purg', 'wipe', 'eras', 'overwrit', 'unlink', 'reset', 'drop table',
    'drop column', 'drop database', 'drop schema', 'drop index',
    'drop the table',
  ],
  EXTERNAL_MUTATION: [
    'external write', 'external writes', 'external mutation',
    'external mutations', 'external api', 'publish', 'third party',
    'third-party', 'webhook', 'outbound',
  ],
  PERSISTENT_DATA_MIGRATION: [
    'migration', 'migrations', 'schema change', 'schema migration',
    'schema migrations', 'data migration', 'data migrations', 'alter table',
    'drop column', 'backfil',
  ],
  SECRETS_CREDENTIALS: [
    'secret', 'secrets', 'credential', 'credentials', 'api key', 'api keys',
    'apikey', 'oauth', 'password', 'passwords', 'private key',
    'encryption key', 'access token',
  ],
  SECURITY_BOUNDARY: [
    'crypt', 'crypto', 'cryptographic', 'encrypt', 'encrypted', 'encryption',
    'hmac signature', 'signatures', 'certificate', 'tls',
  ],
  TOKEN_COUNTING: [
    'token budget', 'token count', 'token counting', 'token estimate',
    'token usage', 'count tokens', 'tokenize',
  ],
};

const EXPECTED_PREFIX_STEMS = [
  'delet', 'drop', 'truncat', 'purg', 'wipe', 'eras', 'overwrit', 'unlink',
  'reset', 'backfil', 'publish', 'subscript', 'signatures',
];

function autoTask(id, overrides = {}) {
  return {
    id,
    metadata: { governance: { mode: 'auto' } },
    title: '',
    description: '',
    acceptance_criteria: [],
    specification: {},
    ...overrides,
  };
}

function assertGovernanceError(error, code, mode) {
  assert.ok(error instanceof GovernancePolicyError);
  assert.equal(error.code, code);
  assert.equal(error.isGovernancePolicyError, true);
  if (arguments.length === 3) assert.deepEqual(error.mode, mode);
  return true;
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test('AC1: mode off disables automatic governance despite triggers in every scanned field', () => {
  const task = {
    id: 'off-with-triggers',
    metadata: { governance: { mode: 'off' } },
    title: 'Rotate OAuth credentials and publish release automation',
    description: 'Delete the migration and perform an external write',
    acceptance_criteria: ['Require authorization and billing payment'],
    specification: {
      invariants: ['No secrets are written to disk'],
      nested: [{ check: 'The workflow file has a webhook' }],
    },
  };

  assert.deepEqual(resolveGovernancePolicy(task), {
    required: false,
    mode: 'off',
    reasons: [],
  });
});

test('AC2: mode required requires governance without a text trigger', () => {
  const task = {
    id: 'required-without-triggers',
    metadata: { governance: { mode: 'required' } },
    title: 'Read the status output',
    description: 'Print the current value without changing it.',
    acceptance_criteria: ['The command prints the current value.'],
    specification: {},
  };

  assert.deepEqual(resolveGovernancePolicy(task), {
    required: true,
    mode: 'required',
    reasons: [],
  });
});

test('AC3: mode auto returns the OAuth and authorization trigger reasons', () => {
  const task = {
    id: 'oauth-credentials',
    metadata: { governance: { mode: 'auto' } },
    title: 'Rotate the OAuth credentials for the provider client',
    description: 'Requires authorization from the provider.',
    acceptance_criteria: [],
    specification: {},
  };

  assert.deepEqual(resolveGovernancePolicy(task), {
    required: true,
    mode: 'auto',
    reasons: [
      { id: 'AUTHORIZATION', field: 'description', match: 'authorization' },
      { id: 'SECRETS_CREDENTIALS', field: 'title', match: 'oauth' },
    ],
  });
});

test('AC4: mode auto allows an ordinary low-risk read-only feature', () => {
  const task = {
    id: 't2',
    metadata: { governance: { mode: 'auto' } },
    title: 'Add a --dry-run flag to the status command',
    description: 'Print the resolved task status without writing anything.',
    acceptance_criteria: ['The flag prints the same status text the normal path prints.'],
    specification: {},
  };

  assert.deepEqual(resolveGovernancePolicy(task), {
    required: false,
    mode: 'auto',
    reasons: [],
  });
});

test('default mode is auto and a task with only an id has no reasons', () => {
  assert.deepEqual(resolveGovernancePolicy({ id: 'default-task' }), {
    required: false,
    mode: 'auto',
    reasons: [],
  });
});

const fieldAttributionCases = [
  {
    field: 'title',
    value: 'Enable OAuth for the provider',
    reason: { id: 'SECRETS_CREDENTIALS', field: 'title', match: 'oauth' },
  },
  {
    field: 'description',
    value: 'The endpoint requires authorization.',
    reason: { id: 'AUTHORIZATION', field: 'description', match: 'authorization' },
  },
  {
    field: 'acceptance_criteria',
    value: ['The schema migration runs once.'],
    reason: { id: 'PERSISTENT_DATA_MIGRATION', field: 'acceptance_criteria', match: 'migration' },
  },
  {
    field: 'specification',
    value: { invariants: ['No secrets are written to disk.'] },
    reason: { id: 'SECRETS_CREDENTIALS', field: 'specification', match: 'secrets' },
  },
];

for (const { field, value, reason } of fieldAttributionCases) {
  test(`per-field attribution reports only ${field}`, () => {
    assert.deepEqual(resolveGovernancePolicy(autoTask(`field-${field}`, { [field]: value })), {
      required: true,
      mode: 'auto',
      reasons: [reason],
    });
  });
}

test('specification triggers are found through nested objects and arrays', () => {
  const task = autoTask('nested-specification', {
    specification: {
      controls: {
        invariants: [
          { name: 'secrets-check', text: 'No secrets are written to disk.' },
        ],
      },
    },
  });

  assert.deepEqual(resolveGovernancePolicy(task), {
    required: true,
    mode: 'auto',
    reasons: [
      { id: 'SECRETS_CREDENTIALS', field: 'specification', match: 'secrets' },
    ],
  });
});

test('id and metadata are never scanned for trigger phrases', () => {
  const task = {
    id: 'token budget migration',
    metadata: { text: 'oauth secrets migration' },
    title: '',
    description: '',
    acceptance_criteria: [],
    specification: {},
  };

  assert.deepEqual(resolveGovernancePolicy(task), {
    required: false,
    mode: 'auto',
    reasons: [],
  });
});

test('word boundaries match auth but do not treat author as auth', () => {
  assert.deepEqual(resolveGovernancePolicy(autoTask('auth-boundary', {
    description: 'Refactor the auth module',
  })), {
    required: true,
    mode: 'auto',
    reasons: [
      { id: 'AUTHORIZATION', field: 'description', match: 'auth' },
    ],
  });

  assert.deepEqual(resolveGovernancePolicy(autoTask('author-boundary', {
    description: 'Author the release notes',
  })), {
    required: false,
    mode: 'auto',
    reasons: [],
  });
});

test('api key matches accepted hyphen, underscore, and case forms', () => {
  for (const [index, description] of [
    'Rotate the API-KEY',
    'Rotate the API_KEY',
    'Rotate the Api Key',
  ].entries()) {
    assert.deepEqual(resolveGovernancePolicy(autoTask(`api-key-form-${index}`, { description })), {
      required: true,
      mode: 'auto',
      reasons: [
        { id: 'SECRETS_CREDENTIALS', field: 'description', match: 'api key' },
      ],
    });
  }
});

test('AC6 false-negative check detects count tokens', () => {
  assert.deepEqual(resolveGovernancePolicy(autoTask('count-tokens', {
    description: 'Count tokens in the prompt before sending',
  })), {
    required: true,
    mode: 'auto',
    reasons: [
      { id: 'TOKEN_COUNTING', field: 'description', match: 'count tokens' },
    ],
  });
});

test('trigger vocabulary regression matrix covers fail-closed and false-positive cases', () => {
  const mustBeGoverned = [
    ['Deleted rows from the tasks table', 'DESTRUCTIVE_OPERATION', 'deleted'],
    ['Dropped the audit table', 'DESTRUCTIVE_OPERATION', 'dropped'],
    ['Wiped the logs', 'DESTRUCTIVE_OPERATION', 'wiped'],
    ['Deleting the stale records', 'DESTRUCTIVE_OPERATION', 'deleting'],
    ['erased the audit trail', 'DESTRUCTIVE_OPERATION', 'erased'],
    ['Purge the cache', 'DESTRUCTIVE_OPERATION', 'purge'],
    ['Handle encrypted payloads', 'SECURITY_BOUNDARY', 'encrypted'],
    ['The cron job deletes stale rows', 'DESTRUCTIVE_OPERATION', 'deletes'],
    ['The job drops expired rows', 'DESTRUCTIVE_OPERATION', 'drops'],
    ['Run a hard reset on the prod queue', 'DESTRUCTIVE_OPERATION', 'reset'],
    ['Run a staging database reset', 'DESTRUCTIVE_OPERATION', 'reset'],
    ['Factory reset the fixture state', 'DESTRUCTIVE_OPERATION', 'reset'],
    ['Create a paid subscription', 'BILLING_FINANCIAL', 'subscription'],
    ['Cancel the customer subscription', 'BILLING_FINANCIAL', 'subscription'],
    ['Renew the subscription', 'BILLING_FINANCIAL', 'subscription'],
    ['The job publishes the artifact', 'EXTERNAL_MUTATION', 'publishes'],
    ['Publish the package to the public npm registry', 'EXTERNAL_MUTATION', 'publish'],
    ['npm publish the package', 'EXTERNAL_MUTATION', 'publish'],
    ['The cron purges expired sessions', 'DESTRUCTIVE_OPERATION', 'purges'],
    ['The job wipes temp files', 'DESTRUCTIVE_OPERATION', 'wipes'],
    ['truncates the audit log', 'DESTRUCTIVE_OPERATION', 'truncates'],
    ['erases old records', 'DESTRUCTIVE_OPERATION', 'erases'],
    ['overwrites the config', 'DESTRUCTIVE_OPERATION', 'overwrites'],
    ['unlinks the stale symlink', 'DESTRUCTIVE_OPERATION', 'unlinks'],
    ['Backfill the production rows', 'PERSISTENT_DATA_MIGRATION', 'backfill'],
    ['backfills the reporting table', 'PERSISTENT_DATA_MIGRATION', 'backfills'],
    ['Write to the third-party API', 'EXTERNAL_MUTATION', 'third-party'],
    ['Charge the subscription fee', 'BILLING_FINANCIAL', 'subscription'],
    ['Verify the HMAC signature', 'SECURITY_BOUNDARY', 'hmac signature'],
    ['Verify the HMAC signatures', 'SECURITY_BOUNDARY', 'signatures'],
    ['Drop the users table', 'DESTRUCTIVE_OPERATION', 'drop'],
    ['Drop the table X', 'DESTRUCTIVE_OPERATION', 'drop'],
    ['rm -rf /tmp/x', 'DESTRUCTIVE_OPERATION', 'rm -rf'],
    ['rm -fr /tmp/x', 'DESTRUCTIVE_OPERATION', 'rm -fr'],
    ['rm -r /tmp/x', 'DESTRUCTIVE_OPERATION', 'rm -r'],
    // IRREDUCIBLE AMBIGUITIES: resolved toward fail-closed. Governing costs a
    // false positive (a captain gate), while excluding costs a false negative
    // (destructive or third-party work proceeding ungoverned), unacceptable for
    // a governance classifier.
    ['Bump a third-party devDependency', 'EXTERNAL_MUTATION', 'third-party'],
    ['Update the migration guide', 'PERSISTENT_DATA_MIGRATION', 'migration'],
  ];
  // The trailing `(?![a-z0-9]|-)` on a stem is the hyphen guard: it lets the
  // drop stem consume words but refuses the structurally different drop-down.
  for (const [description, id, match] of mustBeGoverned) {
    assert.deepEqual(resolveGovernancePolicy(autoTask(`must-govern-${match}`, { description })), {
      required: true,
      mode: 'auto',
      reasons: [{ id, field: 'description', match }],
    });
  }

  const multiCategoryCases = [
    ['The migration drops the old column', [
      { id: 'DESTRUCTIVE_OPERATION', field: 'description', match: 'drops' },
      { id: 'PERSISTENT_DATA_MIGRATION', field: 'description', match: 'migration' },
    ]],
    ['Delete the migration records', [
      { id: 'DESTRUCTIVE_OPERATION', field: 'description', match: 'delete' },
      { id: 'PERSISTENT_DATA_MIGRATION', field: 'description', match: 'migration' },
    ]],
  ];
  for (const [description, reasons] of multiCategoryCases) {
    assert.deepEqual(resolveGovernancePolicy(autoTask(`multi-category-${description}`, { description })), {
      required: true,
      mode: 'auto',
      reasons,
    });
  }

  // Bare singular 'signature' is deliberately ungoverned because any matcher
  // covering JWT/SAML/event signature verification also covers 'method signature';
  // singular signature verification is a known limitation of this classifier.
  const falsePositives = [
    'Document the method signature',
    'Change the function signature',
    'Tighten the type signature',
    'Add a drop-down menu',
    'Subscribe to client events',
    'Use tokenizer fixtures in tests',
    'Author the release notes',
    'Add a --dry-run flag to the status command',
  ];
  for (const description of falsePositives) {
    assert.deepEqual(resolveGovernancePolicy(autoTask(`false-positive-${description}`, { description })), {
      required: false,
      mode: 'auto',
      reasons: [],
    });
  }

  // The 'reset' stem is needed to govern genuine reset operations ('Factory
  // reset the fixture state', 'Run a staging database reset') and consequently
  // also governs 'Fix the reset button'; this is the accepted fail-closed
  // resolution of an irreducible ambiguity alongside 'Bump a third-party
  // devDependency' and 'Update the migration guide' - governing costs a false
  // positive (one captain gate), excluding costs a false negative (a destructive
  // reset proceeding ungoverned).
  assert.deepEqual(resolveGovernancePolicy(autoTask('accepted-reset-ambiguity', {
    description: 'Fix the reset button',
  })), {
    required: true,
    mode: 'auto',
    reasons: [
      { id: 'DESTRUCTIVE_OPERATION', field: 'description', match: 'reset' },
    ],
  });
});

test('invalid governance modes fail closed with a typed error and code', () => {
  for (const mode of ['sometimes', 5, null, false]) {
    assert.throws(
      () => resolveGovernancePolicy({
        id: `invalid-mode-${String(mode)}`,
        metadata: { governance: { mode } },
      }),
      (error) => assertGovernanceError(error, 'INVALID_GOVERNANCE_MODE', mode),
    );
  }
});

test('invalid tasks fail closed with INVALID_TASK', () => {
  for (const task of [null, undefined, {}, { id: '' }]) {
    assert.throws(
      () => resolveGovernancePolicy(task),
      (error) => assertGovernanceError(error, 'INVALID_TASK'),
    );
  }
});

test('AC5 policy resolution is deterministic and does not mutate inputs', () => {
  const task = {
    id: 'deterministic-task',
    metadata: { governance: { mode: 'auto' } },
    title: 'Rotate OAuth integration',
    description: 'Requires authorization from the provider.',
    acceptance_criteria: ['Print the result.'],
    specification: { nested: [{ check: 'No secrets are written to disk.' }] },
  };
  const before = structuredClone(task);
  const expected = {
    required: true,
    mode: 'auto',
    reasons: [
      { id: 'AUTHORIZATION', field: 'description', match: 'authorization' },
      { id: 'SECRETS_CREDENTIALS', field: 'title', match: 'oauth' },
    ],
  };

  const first = resolveGovernancePolicy(task);
  const second = resolveGovernancePolicy(task);
  const structurallyIdentical = resolveGovernancePolicy(structuredClone(task));

  assert.deepEqual(first, expected);
  assert.deepEqual(second, first);
  assert.deepEqual(structurallyIdentical, first);
  assert.deepEqual(task, before);

  const frozenTask = freezeDeep(structuredClone(task));
  assert.equal(Object.isFrozen(frozenTask.metadata), true);
  assert.equal(Object.isFrozen(frozenTask.metadata.governance), true);
  assert.equal(Object.isFrozen(frozenTask.acceptance_criteria), true);
  assert.equal(Object.isFrozen(frozenTask.specification), true);
  assert.equal(Object.isFrozen(frozenTask.specification.nested), true);
  assert.equal(Object.isFrozen(frozenTask.specification.nested[0]), true);
  const frozenBefore = structuredClone(frozenTask);
  assert.deepEqual(resolveGovernancePolicy(frozenTask), expected);
  assert.deepEqual(frozenTask, frozenBefore);
});

test('reasons are ordered by category id, not text occurrence', () => {
  assert.deepEqual(resolveGovernancePolicy(autoTask('ordered-reasons', {
    description: 'Use auth and then tokenize the prompt',
  })), {
    required: true,
    mode: 'auto',
    reasons: [
      { id: 'AUTHORIZATION', field: 'description', match: 'auth' },
      { id: 'TOKEN_COUNTING', field: 'description', match: 'tokenize' },
    ],
  });
});

test('CAPTAIN_REASONS has the exact frozen ids and documented vocabulary', () => {
  assert.deepEqual(Object.keys(CAPTAIN_REASONS), EXPECTED_REASON_IDS);
  assert.deepEqual(CAPTAIN_REASONS, EXPECTED_CAPTAIN_REASONS);
  assert.equal(Object.isFrozen(CAPTAIN_REASONS), true);
  assert.ok(PREFIX_STEMS instanceof Set);
  assert.deepEqual([...PREFIX_STEMS], EXPECTED_PREFIX_STEMS);

  for (const id of EXPECTED_REASON_IDS) {
    assert.ok(Array.isArray(CAPTAIN_REASONS[id]));
    assert.ok(CAPTAIN_REASONS[id].length > 0);
    for (const phrase of CAPTAIN_REASONS[id]) {
      assert.equal(typeof phrase, 'string');
      assert.equal(phrase, phrase.toLowerCase());
    }
  }
});
