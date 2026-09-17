import test from 'node:test';
import assert from 'node:assert/strict';
import { GovernancePolicyError, resolveGovernancePolicy } from '../src/policy.js';

const G1_CATEGORY_ORDER = [
  'AUTHORIZATION',
  'BILLING_FINANCIAL',
  'CI_RELEASE_AUTOMATION',
  'DESTRUCTIVE_OPERATION',
  'EXTERNAL_MUTATION',
  'PERSISTENT_DATA_MIGRATION',
  'SECRETS_CREDENTIALS',
  'SECURITY_BOUNDARY',
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
    id: 'read-only-status',
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

test('absent governance mode defaults to auto', () => {
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

test('all nested specification string leaves are scanned without schema assumptions', () => {
  const task = autoTask('nested-specification', {
    specification: {
      invariants: [
        { name: 'opaque-invariant', text: 'No secrets are written to disk.' },
        { enabled: false, threshold: 3, nested: [{ ignored: null }] },
      ],
      scope: {
        include: ['The scope is interpreted as data.'],
        exclude: 17,
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
    id: 'token budget migration oauth secrets',
    metadata: {
      text: 'authorization payment migration webhook',
      governance: { mode: 'auto' },
    },
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

test('API key matching accepts hyphen, underscore, and case forms', () => {
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

test('prompt token counting is not a governance category', () => {
  for (const description of [
    'Count tokens in the prompt before sending',
    'Estimate token usage for the request',
    'Use tokenizer fixtures in tests',
  ]) {
    assert.deepEqual(resolveGovernancePolicy(autoTask(`ordinary-token-work-${description}`, { description })), {
      required: false,
      mode: 'auto',
      reasons: [],
    });
  }
});

const requiredTriggerCases = [
  ['Require authentication before account access', 'AUTHORIZATION', 'authentication'],
  ['Require authorization from the provider', 'AUTHORIZATION', 'authorization'],
  ['Enforce access control checks', 'AUTHORIZATION', 'access control'],
  ['Check permissions before proceeding', 'AUTHORIZATION', 'permissions'],
  ['Update the billing details', 'BILLING_FINANCIAL', 'billing'],
  ['Review the financial report', 'BILLING_FINANCIAL', 'financial'],
  ['Process a customer payment', 'BILLING_FINANCIAL', 'payment'],
  ['Create an invoice for the customer', 'BILLING_FINANCIAL', 'invoice'],
  ['Apply a refund to the charge', 'BILLING_FINANCIAL', 'refund'],
  ['Store a credit-card payment method', 'BILLING_FINANCIAL', 'credit card'],
  ['Create a paid subscription', 'BILLING_FINANCIAL', 'subscription'],
  ['Cancel the customer subscription', 'BILLING_FINANCIAL', 'subscription'],
  ['Charge the subscription fee', 'BILLING_FINANCIAL', 'subscription'],
  ['Renew the customer subscription', 'BILLING_FINANCIAL', 'subscription'],
  ['Add a GitHub Actions workflow', 'CI_RELEASE_AUTOMATION', 'github actions'],
  ['Add release automation for the package', 'CI_RELEASE_AUTOMATION', 'release automation'],
  ['Update the CI workflow', 'CI_RELEASE_AUTOMATION', 'ci workflow'],
  ['Delete the stale rows', 'DESTRUCTIVE_OPERATION', 'delete'],
  ['Deleted rows from the tasks table', 'DESTRUCTIVE_OPERATION', 'deleted'],
  ['Deleting the stale records', 'DESTRUCTIVE_OPERATION', 'deleting'],
  ['The cron job deletes stale rows', 'DESTRUCTIVE_OPERATION', 'deletes'],
  ['Drop the users table', 'DESTRUCTIVE_OPERATION', 'drop'],
  ['Dropped the audit table', 'DESTRUCTIVE_OPERATION', 'dropped'],
  ['The job drops expired rows', 'DESTRUCTIVE_OPERATION', 'drops'],
  ['Purge the cache', 'DESTRUCTIVE_OPERATION', 'purge'],
  ['The cron purges expired sessions', 'DESTRUCTIVE_OPERATION', 'purges'],
  ['Wipe the temporary files', 'DESTRUCTIVE_OPERATION', 'wipe'],
  ['The job wipes temp files', 'DESTRUCTIVE_OPERATION', 'wipes'],
  ['Erase old records', 'DESTRUCTIVE_OPERATION', 'erase'],
  ['The job erases old records', 'DESTRUCTIVE_OPERATION', 'erases'],
  ['Overwrite the config', 'DESTRUCTIVE_OPERATION', 'overwrite'],
  ['The job overwrites the config', 'DESTRUCTIVE_OPERATION', 'overwrites'],
  ['Unlink the stale symlink', 'DESTRUCTIVE_OPERATION', 'unlink'],
  ['The job unlinks the stale symlink', 'DESTRUCTIVE_OPERATION', 'unlinks'],
  ['Run a hard reset on the prod queue', 'DESTRUCTIVE_OPERATION', 'reset'],
  ['rm -rf /tmp/x', 'DESTRUCTIVE_OPERATION', 'rm -rf'],
  ['rm -fr /tmp/x', 'DESTRUCTIVE_OPERATION', 'rm -fr'],
  ['rm -r /tmp/x', 'DESTRUCTIVE_OPERATION', 'rm -r'],
  ['The job publishes the artifact', 'EXTERNAL_MUTATION', 'publishes'],
  ['Publish the package to the public npm registry', 'EXTERNAL_MUTATION', 'publish'],
  ['npm publish the package', 'EXTERNAL_MUTATION', 'publish'],
  ['Perform an external write', 'EXTERNAL_MUTATION', 'external write'],
  ['Apply an external mutation', 'EXTERNAL_MUTATION', 'external mutation'],
  ['Send the outbound request', 'EXTERNAL_MUTATION', 'outbound'],
  ['Register the webhook callback', 'EXTERNAL_MUTATION', 'webhook'],
  ['Backfill the production rows', 'PERSISTENT_DATA_MIGRATION', 'backfill'],
  ['The job backfills the reporting table', 'PERSISTENT_DATA_MIGRATION', 'backfills'],
  ['Apply the schema migration', 'PERSISTENT_DATA_MIGRATION', 'migration'],
  ['Run the data migration', 'PERSISTENT_DATA_MIGRATION', 'migration'],
  ['Apply a schema change', 'PERSISTENT_DATA_MIGRATION', 'schema change'],
  ['Run the schema migrations', 'PERSISTENT_DATA_MIGRATION', 'migrations'],
  ['Perform data migrations', 'PERSISTENT_DATA_MIGRATION', 'migrations'],
  ['Alter table users to add the column', 'PERSISTENT_DATA_MIGRATION', 'alter table'],
  ['Store a secret in the vault', 'SECRETS_CREDENTIALS', 'secret'],
  ['Rotate the credential', 'SECRETS_CREDENTIALS', 'credential'],
  ['Rotate the credentials', 'SECRETS_CREDENTIALS', 'credentials'],
  ['Rotate the OAuth client credentials', 'SECRETS_CREDENTIALS', 'oauth'],
  ['Set a password for the account', 'SECRETS_CREDENTIALS', 'password'],
  ['Load the private key', 'SECRETS_CREDENTIALS', 'private key'],
  ['Use an access token', 'SECRETS_CREDENTIALS', 'access token'],
  ['Rotate the bearer token', 'SECRETS_CREDENTIALS', 'bearer token'],
  ['Refresh the refresh token', 'SECRETS_CREDENTIALS', 'refresh token'],
  ['Use crypto for the key exchange', 'SECURITY_BOUNDARY', 'crypto'],
  ['Encrypt the payload', 'SECURITY_BOUNDARY', 'encrypt'],
  ['Use encryption for payloads', 'SECURITY_BOUNDARY', 'encryption'],
  ['Verify the HMAC signature', 'SECURITY_BOUNDARY', 'hmac signature'],
  ['Verify the HMAC signatures', 'SECURITY_BOUNDARY', 'signatures'],
  ['Rotate the certificate', 'SECURITY_BOUNDARY', 'certificate'],
  ['Require TLS for the connection', 'SECURITY_BOUNDARY', 'tls'],
];

for (const [description, id, match] of requiredTriggerCases) {
  test(`material trigger requires governance: ${description}`, () => {
    assert.deepEqual(resolveGovernancePolicy(autoTask(`required-${id}-${match}`, { description })), {
      required: true,
      mode: 'auto',
      reasons: [{ id, field: 'description', match }],
    });
  });
}

const ordinaryFalsePositiveCases = [
  'Dropbox integration',
  'Add a dropdown menu',
  'Add a drop-down menu',
  'Enable drag-and-drop support',
  'Handle network drops gracefully',
  'Add publisher metadata',
  'Update Realtime subscription events',
  'Monitor event-stream subscription updates',
  'Document the method signature',
  'Change the function signature',
  'Tighten the type signature',
  'Update the migration guide',
  'Read the migration docs',
  'Fix the reset button',
  'Fix the reset form',
  'Bump a third-party devDependency',
  'Coordinate with a third-party vendor',
  'Read from the third-party API',
  'Call the third-party API',
  'Create an event-stream subscription',
  'Create an ordinary subscription',
];

for (const description of ordinaryFalsePositiveCases) {
  test(`ordinary text stays ungoverned: ${description}`, () => {
    assert.deepEqual(resolveGovernancePolicy(autoTask(`ordinary-${description}`, { description })), {
      required: false,
      mode: 'auto',
      reasons: [],
    });
  });
}

test('third-party API text requires an explicit external mutation operation', () => {
  assert.deepEqual(resolveGovernancePolicy(autoTask('third-party-write', {
    description: 'Write to the third-party API',
  })), {
    required: true,
    mode: 'auto',
    reasons: [
      { id: 'EXTERNAL_MUTATION', field: 'description', match: 'third-party' },
    ],
  });
});

test('reasons are ordered by category id, not text occurrence', () => {
  assert.deepEqual(resolveGovernancePolicy(autoTask('ordered-reasons', {
    description: 'Verify the HMAC signature, rotate the OAuth credential, and require authentication.',
  })), {
    required: true,
    mode: 'auto',
    reasons: [
      { id: 'AUTHORIZATION', field: 'description', match: 'authentication' },
      { id: 'SECRETS_CREDENTIALS', field: 'description', match: 'oauth' },
      { id: 'SECURITY_BOUNDARY', field: 'description', match: 'hmac signature' },
    ],
  });
});

test('reasons use the highest-precedence field independently per category', () => {
  assert.deepEqual(resolveGovernancePolicy(autoTask('field-precedence', {
    title: 'OAuth release metadata',
    description: 'Require authorization and apply the schema migration.',
    acceptance_criteria: ['Publish the artifact after payment.'],
    specification: { check: 'No password is written to disk.' },
  })), {
    required: true,
    mode: 'auto',
    reasons: [
      { id: 'AUTHORIZATION', field: 'description', match: 'authorization' },
      { id: 'BILLING_FINANCIAL', field: 'acceptance_criteria', match: 'payment' },
      { id: 'EXTERNAL_MUTATION', field: 'acceptance_criteria', match: 'publish' },
      { id: 'PERSISTENT_DATA_MIGRATION', field: 'description', match: 'migration' },
      { id: 'SECRETS_CREDENTIALS', field: 'title', match: 'oauth' },
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

test('invalid top-level tasks fail closed with INVALID_TASK', () => {
  for (const task of [null, undefined, {}, { id: '' }, { id: 7 }, [], 'task']) {
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

test('all eight G1 categories have observable reason ids', () => {
  const task = autoTask('all-g1-categories', {
    title: 'Require authentication',
    description: 'Charge the payment and run GitHub Actions.',
    acceptance_criteria: [
      'Delete the old rows and publish the artifact.',
      'Apply the schema migration and rotate the OAuth credentials.',
    ],
    specification: {
      security: 'Require TLS for the connection.',
    },
  });
  const result = resolveGovernancePolicy(task);
  assert.deepEqual(result.reasons.map(({ id }) => id), G1_CATEGORY_ORDER);
  assert.equal(result.required, true);
  assert.equal(result.mode, 'auto');
  assert.ok(result.reasons.every(({ field, match }) => typeof field === 'string' && typeof match === 'string'));
});
