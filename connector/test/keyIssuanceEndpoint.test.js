'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadFunctions, makeRequest, makeContext, clientVisible, loggedText,
} = require('./helpers/harness');

const DECISION_ID = '18b3e8e7-0812-4bea-9cad-8351c1d2277a';
const RECEIPT = {
  decision_id: DECISION_ID,
  key_id: 'a40ea8ce-6df0-4e9a-8b91-e9f10c16c71a',
  customer_id: '20af8098-42fc-4b50-aa70-cf1718e69c8e',
  scope: 'read',
  secret_name: 'xero-api-key-for-mcp',
  secret_version: '0123456789abcdef',
  reused: false,
};

function load(issueForMcpReadKey) {
  return loadFunctions('functions/keyIssuance.js', {
    'services/keyIssuance.js': { issueForMcpReadKey },
  });
}

test('key issuance is POST and requires Azure Functions admin authentication', () => {
  const { registrations } = load(async () => RECEIPT);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, 'IssueForMcpReadKey');
  assert.equal(registrations[0].kind, 'http');
  assert.equal(registrations[0].options.route, 'admin/keys/for-mcp');
  assert.equal(registrations[0].options.authLevel, 'admin');
  assert.deepEqual(registrations[0].options.methods, ['POST']);
});

test('rejects malformed, unapproved and override bodies without invoking issuance', async () => {
  let calls = 0;
  const { handlers } = load(async () => { calls++; return RECEIPT; });
  const invalid = [
    null, false, DECISION_ID, [], [DECISION_ID], {},
    { decision_id: null }, { decision_id: 18 },
    { decision_id: '18b3e8e7' },
    { decision_id: '18b3e8e7-0812-4bea-9cad-8351c1d2277b' },
    { decision_id: DECISION_ID, scope: 'full' },
    { decision_id: DECISION_ID, customer_id: RECEIPT.customer_id },
    { decision_id: DECISION_ID, vault: 'other-vault' },
  ];
  for (const json of invalid) {
    const result = await handlers.IssueForMcpReadKey(makeRequest({ json }), makeContext());
    assert.equal(result.status, 400, JSON.stringify(json));
  }
  const malformed = await handlers.IssueForMcpReadKey(makeRequest({ body: '{' }), makeContext());
  assert.equal(malformed.status, 400);
  assert.equal(calls, 0);
});

test('passes only pinned decision and returns explicitly allowed receipt fields', async () => {
  const calls = [];
  const { handlers } = load(async (...args) => {
    calls.push(args);
    return { ...RECEIPT, key: 'raw-key', hash: 'hash-material', prefix: 'prefix-material', token: 'raw-token' };
  });
  const context = makeContext();
  const result = await handlers.IssueForMcpReadKey(makeRequest({ json: { decision_id: DECISION_ID } }), context);
  assert.deepEqual(calls, [[DECISION_ID]]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.jsonBody, RECEIPT);
  assert.equal(context.entries.length, 0);
  for (const secret of ['raw-key', 'hash-material', 'prefix-material', 'raw-token']) {
    assert.ok(!clientVisible(result).includes(secret));
  }
});

test('issuance failures are generic in both response and host logs', async () => {
  const secret = 'raw-issued-key-secret-and-SQL-driver-detail';
  const { handlers } = load(async () => { throw new Error(secret); });
  const context = makeContext();
  const result = await handlers.IssueForMcpReadKey(makeRequest({ json: { decision_id: DECISION_ID } }), context);
  assert.equal(result.status, 500);
  assert.equal(result.jsonBody.error, 'Internal server error');
  assert.match(result.jsonBody.correlation_id, /^[0-9a-f-]{36}$/);
  assert.ok(!clientVisible(result).includes(secret));
  assert.ok(!loggedText(context).includes(secret));
});
