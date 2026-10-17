'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadFunctions, DIST } = require('./helpers/harness');

const DECISION_ID = '18b3e8e7-0812-4bea-9cad-8351c1d2277a';
const CUSTOMER_ID = '70fbb207-4249-4385-a2c6-4f1767f5c3e9';
const KEY = `fmcp_${'a'.repeat(43)}`;
const HASH = createHash('sha256').update(KEY).digest('hex');

function fixture() {
  const state = {
    rows: [], secret: undefined, pools: 0, closed: 0, generated: 0,
    saves: 0, reads: 0, commits: 0, rollbacks: 0, activeLocks: 0,
    maxActiveLocks: 0, queries: [], inserts: [], failInsert: false,
    failCommitAfterWrite: false, ready: true,
  };
  let lockTail = Promise.resolve();
  class Transaction {
    constructor(pool) { this.pool = pool; this.pending = []; }
    async begin() {
      if (state.failBegin) throw new Error('Begin failed');
      this.begun = true;
    }
    async lock() {
      const predecessor = lockTail;
      lockTail = new Promise((resolve) => { this.unlock = resolve; });
      await predecessor;
      state.activeLocks++;
      state.maxActiveLocks = Math.max(state.maxActiveLocks, state.activeLocks);
    }
    release() {
      if (this.unlock) { state.activeLocks--; this.unlock(); this.unlock = undefined; }
    }
    async commit() {
      state.rows.push(...this.pending);
      this.pending = [];
      state.commits++;
      this.release();
      if (state.failCommitAfterWrite) {
        state.failCommitAfterWrite = false;
        throw new Error('Commit response lost');
      }
    }
    async rollback() { this.pending = []; state.rollbacks++; this.release(); }
  }
  class Request {
    constructor(tx) { this.tx = tx; this.params = {}; }
    input(name, _type, value) { this.params[name] = value; return this; }
    async query(text) {
      state.queries.push(text);
      if (text.includes('sp_getapplock')) {
        assert.match(text, /@LockMode='Exclusive'/);
        assert.match(text, /@LockOwner='Transaction'/);
        assert.match(text, /COL_LENGTH\('xero\.api_keys','scope'\)/);
        await this.tx.lock();
        return { recordset: [] };
      }
      assert.equal(state.activeLocks, 1, 'database reads/writes occur within transaction lock');
      if (text.includes('FROM xero.customers c')) {
        assert.equal(this.params.customer, CUSTOMER_ID);
        assert.equal(this.params.email, 'b.thomas@forit.io');
        assert.match(text, /cp.status IN \('active','trial'\)/);
        assert.match(text, /xero\.xero_connections/);
        return { recordset: state.ready ? [{ id: CUSTOMER_ID }] : [] };
      }
      if (text.includes('SELECT id,customer_id,key_hash,key_prefix,scope,is_active')) {
        assert.equal(this.params.name, `for-mcp read ${DECISION_ID}`);
        return { recordset: state.rows.map((row) => ({ ...row })) };
      }
      if (text.includes('INSERT INTO xero.api_keys')) {
        state.inserts.push({ ...this.params });
        if (state.failInsert) { state.failInsert = false; throw new Error('Insert failed after vault save'); }
        const row = {
          id: 'a40ea8ce-6df0-4e9a-8b91-e9f10c16c71a',
          customer_id: this.params.customer, key_hash: this.params.hash,
          key_prefix: this.params.prefix, scope: 'read', is_active: true,
        };
        this.tx.pending.push(row);
        return { recordset: [{ id: row.id }] };
      }
      throw new Error('Unexpected SQL query');
    }
  }
  const fakeSql = { Transaction, Request, UniqueIdentifier: 'uuid', NVarChar: 'nvarchar' };
  loadFunctions('services/keyIssuance.js', {
    'services/issuanceDatabase.js': { getIssuancePool: async () => { throw new Error('Default pool used'); } },
  }, {
    mssql: fakeSql,
    '@azure/identity': { ManagedIdentityCredential: class {} },
    '@azure/keyvault-secrets': { SecretClient: class {} },
  });
  const { createReadKeyIssuer } = require(path.join(DIST, 'services/keyIssuance.js'));
  const issuer = createReadKeyIssuer({
    getPool: async () => {
      state.pools++;
      return { close: async () => { state.closed++; } };
    },
    getVault: () => ({
      getSecret: async (name) => {
        assert.equal(name, 'xero-api-key-for-mcp');
        state.reads++;
        if (!state.secret) throw Object.assign(new Error('Not found'), { statusCode: 404 });
        return state.secret;
      },
      setSecret: async (name, value, options) => {
        assert.equal(name, 'xero-api-key-for-mcp');
        state.saves++;
        state.secret = { value, properties: { ...options, version: 'one-vault-version' } };
        if (state.vaultReplyMissingValue) {
          state.vaultReplyMissingValue = false;
          return { properties: state.secret.properties };
        }
        if (state.failVaultSaveAfterWrite) {
          state.failVaultSaveAfterWrite = false;
          throw new Error('Vault response lost');
        }
        return state.secret;
      },
    }),
    generateKey: () => { state.generated++; return KEY; },
  });
  return { state, issuer };
}

test('invalid or short decision performs no database or vault work', async () => {
  const { state, issuer } = fixture();
  for (const id of ['', '18b3e8e7', `${DECISION_ID} `, 'other-decision']) {
    await assert.rejects(issuer(id), /outside this operation/);
  }
  assert.equal(state.pools, 0);
  assert.equal(state.reads, 0);
  assert.equal(state.generated, 0);
});

test('SQL failure after vault save retries with one generation and one vault version', async () => {
  const { state, issuer } = fixture();
  state.failInsert = true;
  await assert.rejects(issuer(DECISION_ID), /Insert failed/);
  assert.equal(state.rows.length, 0);
  assert.equal(state.secret.value, KEY);
  assert.equal(state.rollbacks, 1);
  assert.equal(state.closed, 1);

  const receipt = await issuer(DECISION_ID);
  assert.equal(receipt.reused, true);
  assert.equal(receipt.secret_version, 'one-vault-version');
  assert.equal(state.generated, 1);
  assert.equal(state.saves, 1);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].key_hash, HASH);
  assert.equal(state.rows[0].key_prefix, 'fmcp_read');
  assert.equal(state.closed, 2);
  assert.equal(state.activeLocks, 0);
  assert.ok(!JSON.stringify(receipt).includes(KEY));
  assert.ok(!JSON.stringify(receipt).includes(HASH));
  assert.ok(!JSON.stringify(state.inserts).includes(KEY));
  assert.ok(!JSON.stringify(state.inserts).includes(KEY.substring(0, 12)));
});

test('concurrent calls serialize before vault read and create one durable credential', async () => {
  const { state, issuer } = fixture();
  const receipts = await Promise.all([issuer(DECISION_ID), issuer(DECISION_ID), issuer(DECISION_ID)]);
  assert.equal(state.maxActiveLocks, 1);
  assert.equal(state.generated, 1);
  assert.equal(state.saves, 1);
  assert.equal(state.rows.length, 1);
  assert.equal(state.inserts.length, 1);
  assert.deepEqual(receipts.map((r) => r.reused), [false, true, true]);
  assert.equal(new Set(receipts.map((r) => r.key_id)).size, 1);
  assert.equal(state.closed, 3);
});

test('unknown commit outcome recovers existing matching row without a second insert', async () => {
  const { state, issuer } = fixture();
  state.failCommitAfterWrite = true;
  await assert.rejects(issuer(DECISION_ID), /Commit response lost/);
  assert.equal(state.rows.length, 1);
  const receipt = await issuer(DECISION_ID);
  assert.equal(receipt.reused, true);
  assert.equal(state.saves, 1);
  assert.equal(state.inserts.length, 1);
  assert.equal(state.closed, 2);
  assert.equal(state.activeLocks, 0);
});

test('missing or lost setSecret response recovers the saved vault version on retry', async () => {
  for (const mode of ['vaultReplyMissingValue', 'failVaultSaveAfterWrite']) {
    const { state, issuer } = fixture();
    state[mode] = true;
    await assert.rejects(issuer(DECISION_ID), /does not match|Vault response lost/);
    assert.equal(state.rows.length, 0);
    assert.equal(state.closed, 1);
    const receipt = await issuer(DECISION_ID);
    assert.equal(receipt.reused, true);
    assert.equal(state.generated, 1);
    assert.equal(state.saves, 1);
    assert.equal(state.rows.length, 1);
    assert.equal(state.closed, 2);
  }
});

test('failure to begin a transaction still closes its dedicated pool', async () => {
  const { state, issuer } = fixture();
  state.failBegin = true;
  await assert.rejects(issuer(DECISION_ID), /Begin failed/);
  assert.equal(state.closed, 1);
  assert.equal(state.rollbacks, 0);
  assert.equal(state.reads, 0);
});

test('missing exact entitled connected customer closes transaction before any vault work', async () => {
  const { state, issuer } = fixture();
  state.ready = false;
  await assert.rejects(issuer(DECISION_ID), /readiness not proven/);
  assert.equal(state.reads, 0);
  assert.equal(state.generated, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(state.closed, 1);
});

test('vault metadata mismatch or disabled key fails closed without minting again', async () => {
  for (const mutate of [
    (s) => { s.properties.tags.decision_id = 'other'; },
    (s) => { s.properties.tags.scope = 'full'; },
    (s) => { s.properties.tags.customer_id = 'other'; },
    (s) => { s.properties.enabled = false; },
    (s) => { delete s.properties.version; },
  ]) {
    const { state, issuer } = fixture();
    await issuer(DECISION_ID);
    mutate(state.secret);
    await assert.rejects(issuer(DECISION_ID), /does not match/);
    assert.equal(state.generated, 1);
    assert.equal(state.saves, 1);
    assert.equal(state.rows.length, 1);
    assert.equal(state.closed, 2);
    assert.equal(state.activeLocks, 0);
  }
});

test('database mismatch, duplicate row and missing vault all fail closed', async () => {
  for (const mutate of [
    (s) => { s.rows[0].key_hash = 'other'; },
    (s) => { s.rows[0].scope = 'full'; },
    (s) => { s.rows[0].customer_id = 'other'; },
    (s) => { s.rows[0].is_active = false; },
    (s) => { s.rows.push({ ...s.rows[0], id: 'another-row' }); },
    (s) => { s.secret = undefined; },
  ]) {
    const { state, issuer } = fixture();
    await issuer(DECISION_ID);
    mutate(state);
    await assert.rejects(issuer(DECISION_ID), /disagree|Duplicate|no vault version/);
    assert.equal(state.generated, 1);
    assert.equal(state.saves, 1);
    assert.equal(state.inserts.length, 1);
    assert.equal(state.closed, 2);
    assert.equal(state.activeLocks, 0);
  }
});
