'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadFunctions, DIST } = require('./helpers/harness');

function loadDatabase({ getToken, connectError } = {}) {
  const state = { identities: [], scopes: [], pools: [] };
  class ManagedIdentityCredential {
    constructor(options) { state.identities.push(options); }
    async getToken(scope) {
      state.scopes.push(scope);
      return getToken ? getToken() : {
        token: `sql-token-${state.scopes.length}`,
        expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
      };
    }
  }
  class ConnectionPool {
    constructor(config) {
      this.config = config;
      this.closed = false;
      this.listeners = [];
      state.pools.push(this);
    }
    on(event, handler) { this.listeners.push({ event, handler }); return this; }
    async connect() { if (connectError) throw connectError; return this; }
    async close() { this.closed = true; }
  }
  loadFunctions('services/issuanceDatabase.js', {}, {
    '@azure/identity': { ManagedIdentityCredential },
    mssql: { ConnectionPool, connect: () => { throw new Error('Global pool forbidden'); } },
  });
  return {
    ...require(path.join(DIST, 'services/issuanceDatabase.js')),
    state,
  };
}

test('issuance uses managed identity SQL tokens and fresh dedicated pools on each call', async () => {
  const previous = process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID;
  delete process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID;
  try {
    const { getIssuancePool, state } = loadDatabase();
    const first = await getIssuancePool();
    const second = await getIssuancePool();
    assert.notEqual(first, second);
    assert.deepEqual(state.identities, [undefined, undefined]);
    assert.deepEqual(state.scopes, [
      'https://database.windows.net/.default',
      'https://database.windows.net/.default',
    ]);
    for (const [index, pool] of state.pools.entries()) {
      assert.deepEqual(pool.config.authentication, {
        type: 'azure-active-directory-access-token',
        options: { token: `sql-token-${index + 1}` },
      });
      assert.equal('password' in pool.config, false);
      assert.equal('user' in pool.config, false);
      assert.equal(pool.listeners[0].event, 'error');
      await pool.close();
    }
  } finally {
    if (previous === undefined) delete process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID;
    else process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID = previous;
  }
});

test('explicit user-assigned managed identity is selected without a credential fallback', async () => {
  const previous = process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID;
  process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID = '  identity-client-id  ';
  try {
    const { getIssuancePool, state } = loadDatabase();
    const pool = await getIssuancePool();
    assert.deepEqual(state.identities, [{ clientId: 'identity-client-id' }]);
    await pool.close();
  } finally {
    if (previous === undefined) delete process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID;
    else process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID = previous;
  }
});

test('non-secret configuration preserves ForIT defaults and ignores password settings', () => {
  const { buildIssuanceSqlConfig } = loadDatabase();
  const config = buildIssuanceSqlConfig({ SAAS_DB_USER: 'admin', SAAS_DB_PASSWORD: 'secret' });
  assert.equal(config.server, 'forit-saas-sql.database.windows.net');
  assert.equal(config.database, 'forit');
  assert.deepEqual(config.options, { encrypt: true, trustServerCertificate: false });
  assert.equal('user' in config, false);
  assert.equal('password' in config, false);
  assert.equal('authentication' in config, false);
  assert.equal(buildIssuanceSqlConfig({ SAAS_DB_SERVER: 'configured-server', SAAS_DB_NAME: 'configured-db' }).server, 'configured-server');
  assert.equal(buildIssuanceSqlConfig({ SAAS_DB_NAME: 'configured-db' }).database, 'configured-db');
});

test('unavailable or near-expiry tokens never open a SQL pool or expose credential errors', async () => {
  for (const getToken of [
    () => null,
    () => ({ token: 'stale-sensitive-token', expiresOnTimestamp: Date.now() + 1000 }),
    () => { throw new Error('sensitive-credential-detail'); },
  ]) {
    const { getIssuancePool, state } = loadDatabase({ getToken });
    await assert.rejects(getIssuancePool(), { message: 'Managed identity SQL token unavailable' });
    assert.equal(state.pools.length, 0);
  }
});

test('failed connections close their pool and hide SQL/login details', async () => {
  const { getIssuancePool, state } = loadDatabase({ connectError: new Error('sql-token-1 login failure') });
  await assert.rejects(getIssuancePool(), { message: 'Managed identity SQL connection unavailable' });
  assert.equal(state.pools.length, 1);
  assert.equal(state.pools[0].closed, true);
});
