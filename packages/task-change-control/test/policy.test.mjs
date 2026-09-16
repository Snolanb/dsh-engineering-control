import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTAIN_REASONS,
  GovernancePolicyError,
  resolveGovernancePolicy,
} from '../src/policy.js';

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
    'subscription fee', 'refund', 'refunds', 'credit card', 'chargeback',
  ],
  CI_RELEASE_AUTOMATION: [
    'github action', 'github actions', 'workflow file', 'ci workflow',
    'release automation', 'publish to npm', 'push to registry',
  ],
  DESTRUCTIVE_OPERATION: [
    'delete', 'deleted', 'deleting', 'deletion', 'drop table', 'drop column',
    'drop database', 'drop schema', 'drop index', 'dropped', 'dropping',
    'truncate', 'truncated', 'wipe', 'wiped', 'purge', 'purged', 'erase',
    'erased', 'rm -rf', 'unlink', 'overwrite', 'overwritten', 'irreversible',
  ],
  EXTERNAL_MUTATION: [
    'external write', 'external writes', 'external mutation',
    'external mutations', 'external api', 'publish package', 'webhook',
    'outbound',
  ],
  PERSISTENT_DATA_MIGRATION: [
    'schema change', 'schema migration', 'schema migrations', 'data migration',
    'data migrations', 'alter table', 'drop column',
  ],
  SECRETS_CREDENTIALS: [
    'secret', 'secrets', 'credential', 'credentials', 'api key', 'api keys',
    'apikey', 'oauth', 'password', 'passwords', 'private key',
    'encryption key', 'access token',
  ],
  SECURITY_BOUNDARY: [
    'crypt', 'crypto', 'cryptographic', 'encrypt', 'encrypted', 'encryption',
    'certificate', 'tls',
  ],
  TOKEN_COUNTING: [
    'token budget', 'token count', 'token counting', 'token estimate',
    'token usage', 'count tokens', 'tokenize',
  ],
};

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
    reason: { id: 'PERSISTENT_DATA_MIGRATION', field: 'acceptance_criteria', match: 'schema migration' },
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

test('trigger vocabulary regression matrix covers false negatives and false positives', () => {
  const falseNegatives = [
    ['Deleted rows from the tasks table', 'DESTRUCTIVE_OPERATION', 'deleted'],
    ['Dropped the audit table', 'DESTRUCTIVE_OPERATION', 'dropped'],
    ['Wiped the logs', 'DESTRUCTIVE_OPERATION', 'wiped'],
    ['Deleting the stale records', 'DESTRUCTIVE_OPERATION', 'deleting'],
    ['erased the audit trail', 'DESTRUCTIVE_OPERATION', 'erased'],
    ['Purge the cache', 'DESTRUCTIVE_OPERATION', 'purge'],
    ['Handle encrypted payloads', 'SECURITY_BOUNDARY', 'encrypted'],
  ];
  for (const [description, id, match] of falseNegatives) {
    assert.deepEqual(resolveGovernancePolicy(autoTask(`false-negative-${match}`, { description })), {
      required: true,
      mode: 'auto',
      reasons: [{ id, field: 'description', match }],
    });
  }

  const falsePositives = [
    'Document the method signature',
    'Change the function signature',
    'Tighten the type signature',
    'Add a drop-down menu',
    'Fix the reset button',
    'Subscribe to client events',
    'Bump a third-party devDependency',
    'Update the migration guide',
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

  for (const id of EXPECTED_REASON_IDS) {
    assert.ok(Array.isArray(CAPTAIN_REASONS[id]));
    assert.ok(CAPTAIN_REASONS[id].length > 0);
    for (const phrase of CAPTAIN_REASONS[id]) {
      assert.equal(typeof phrase, 'string');
      assert.equal(phrase, phrase.toLowerCase());
    }
  }
});
