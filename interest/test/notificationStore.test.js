'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const NOW = 1_800_000_000_000;
const RAW_FAILURE = 'secret-token SQL-server-private bound-person@example.test';
const SOURCE = readFileSync(path.join(__dirname, '../src/services/notificationStore.ts'), 'utf8');
const compiled = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function fixture() {
  const state = {
    env: { NOTIFICATION_DB_SERVER: 'notifications.database.windows.net', NOTIFICATION_DB_NAME: 'notification-test' },
    envReads: [], credentialArgs: [], tokenScopes: [], poolConfigs: [], pools: [],
    closed: 0, connects: 0, statements: [], inputs: [], factories: [],
    rows: [{ Category: 'integration-failures', Source: 'one-click' }], rowsAffected: [1],
    token: { token: 'offline-test-token', expiresOnTimestamp: NOW + 600_000 },
  };
  function NVarChar() {}
  function VarChar() {}
  class Pool {
    constructor(config) { this.config = config; state.poolConfigs.push(config); state.pools.push(this); }
    on(name, handler) { assert.equal(name, 'error'); assert.equal(typeof handler, 'function'); return this; }
    async connect() { state.connects++; if (state.failConnect) throw new Error(RAW_FAILURE); return this; }
    async close() { state.closed++; if (state.failClose) throw new Error(RAW_FAILURE); }
    request() {
      const inputs = [];
      const request = {
        input(name, type, value) { inputs.push({ name, type, value }); state.inputs.push({ name, type, value }); return request; },
        async query(text) {
          state.statements.push({ text, inputs, pool: this });
          if (state.failQuery) throw new Error(RAW_FAILURE);
          return { recordset: state.rows, rowsAffected: state.rowsAffected };
        },
      };
      return request;
    }
  }
  class ManagedIdentityCredential {
    constructor(...args) { state.credentialArgs.push(args); if (state.failCredential) throw new Error(RAW_FAILURE); }
    async getToken(scope) { state.tokenScopes.push(scope); if (state.failToken) throw new Error(RAW_FAILURE); return state.token; }
  }
  const storeSentinel = {};
  const common = {
    createSqlOptOutStore(options) { state.factories.push(options); return storeSentinel; },
  };
  const sql = { NVarChar, VarChar, ConnectionPool: Pool };
  const exports = {};
  const sandbox = {
    exports, Date: { now: () => NOW },
    process: { env: new Proxy({}, { get: (_target, key) => { state.envReads.push(key); return state.env[key]; } }) },
    require(name) {
      if (name === 'mssql') return sql;
      if (name === '@azure/identity') return { ManagedIdentityCredential };
      if (name === '@foritllc/mail') return common;
      throw new Error(`Unexpected dependency ${name}`);
    },
  };
  vm.runInNewContext(compiled, sandbox, { filename: 'notificationStore.js' });
  return { state, api: exports, sql, Pool, storeSentinel };
}

async function rejectedSafely(operation, expected) {
  await assert.rejects(operation, (error) => {
    assert.match(error.message, expected);
    assert.ok(!error.message.includes(RAW_FAILURE));
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('factory fixes Common schema to interest and defers all environment/identity access', () => {
  const { state, api, storeSentinel, sql } = fixture();
  assert.equal(api.createNotificationStore(), storeSentinel);
  assert.equal(state.factories.length, 1);
  assert.equal(state.factories[0].schema, 'interest');
  assert.equal(state.factories[0].db.TYPES.NVarChar, sql.NVarChar);
  assert.equal(state.factories[0].db.TYPES.VarChar, sql.VarChar);
  assert.equal(state.envReads.length, 0);
  assert.equal(state.credentialArgs.length, 0);
  assert.equal(state.poolConfigs.length, 0);
});

test('Common parameter names, native Unicode/ASCII types and values are bound without SQL interpolation', async () => {
  const { state, api, sql, Pool } = fixture();
  let opened = 0;
  const db = api.createNotificationDb(async () => { opened++; return new Pool({ injected: true }); });
  const text = 'SELECT Category FROM [interest].[EmailOptOuts] WHERE TenantKey=@tenant AND Subject=@subject AND Category=@category';
  const tenant = "tenant-a'; DROP TABLE other;--";
  const params = [
    { name: 'tenant', type: db.TYPES.NVarChar, value: tenant },
    { name: 'subject', type: db.TYPES.VarChar, value: 'u:person-1' },
    { name: 'category', type: db.TYPES.VarChar, value: 'integration-failures' },
  ];
  const result = await db.query(text, params);
  assert.equal(opened, 1);
  assert.equal(result.rows, state.rows);
  assert.equal(result.rowCount, 1);
  assert.equal(state.statements[0].text, text);
  assert.ok(!state.statements[0].text.includes(tenant));
  assert.deepEqual(state.inputs, [
    { name: 'tenant', type: sql.NVarChar, value: tenant },
    { name: 'subject', type: sql.VarChar, value: 'u:person-1' },
    { name: 'category', type: sql.VarChar, value: 'integration-failures' },
  ]);
  assert.equal(state.closed, 1);
  assert.equal(state.credentialArgs.length, 0);
});

test('execute binds source and returns total affected rows; every operation closes its own pool', async () => {
  const { state, api, Pool } = fixture();
  state.rowsAffected = [1, 2];
  const db = api.createNotificationDb(async () => new Pool({ injected: true }));
  const text = 'MERGE [interest].[EmailOptOuts] WITH (HOLDLOCK) AS target USING (@source) AS src ON 1=0;';
  assert.equal(await db.execute(text, [{ name: 'source', type: db.TYPES.VarChar, value: 'one-click' }]), 3);
  assert.equal(state.statements[0].text, text);
  assert.equal(state.inputs[0].value, 'one-click');
  await db.query('SELECT 1');
  assert.equal(state.pools.length, 2);
  assert.notEqual(state.pools[0], state.pools[1]);
  assert.equal(state.closed, 2);
});

test('malformed driver recordsets fail closed and close pool; a real empty array remains valid', async () => {
  for (const rows of [undefined, null, {}]) {
    const { state, api, Pool } = fixture();
    state.rows = rows;
    const db = api.createNotificationDb(async () => new Pool({ injected: true }));
    await rejectedSafely(db.query('SELECT 1'), /Notification opt-out store unavailable/);
    assert.equal(state.closed, 1);
  }
  const { state, api, Pool } = fixture();
  state.rows = [];
  const db = api.createNotificationDb(async () => new Pool({ injected: true }));
  const result = await db.query('SELECT 1');
  assert.equal(result.rows, state.rows);
  assert.equal(result.rowCount, 0);
  assert.equal(state.closed, 1);
});

test('injected store pool provider is passed into the Common adapter without being called early', async () => {
  const { state, api, Pool } = fixture();
  let calls = 0;
  api.createNotificationStore({ getPool: async () => { calls++; return new Pool({ injected: true }); } });
  assert.equal(calls, 0);
  await state.factories[0].db.query('SELECT 1');
  assert.equal(calls, 1);
  assert.equal(state.closed, 1);
});

test('query/execute failures and close failures are sanitized and always attempt pool closure', async () => {
  for (const method of ['query', 'execute']) {
    const { state, api, Pool } = fixture();
    state.failQuery = true;
    const db = api.createNotificationDb(async () => new Pool({ injected: true }));
    await rejectedSafely(db[method]('SELECT 1'), /Notification opt-out store unavailable/);
    assert.equal(state.closed, 1);
  }
  const { state, api, Pool } = fixture();
  state.failClose = true;
  const db = api.createNotificationDb(async () => new Pool({ injected: true }));
  await rejectedSafely(db.query('SELECT 1'), /Notification opt-out store unavailable/);
  assert.equal(state.closed, 1);
});

test('invalid parameter name or unsupported type cannot reach query and still closes pool', async () => {
  for (const param of [
    { name: 'subject); DROP TABLE test', type: 'bad', value: 'ignored' },
    { name: 'subject', type: 'not-a-native-type', value: 'ignored' },
  ]) {
    const { state, api, Pool } = fixture();
    const db = api.createNotificationDb(async () => new Pool({ injected: true }));
    await rejectedSafely(db.query('SELECT @subject', [param]), /Notification opt-out store unavailable/);
    assert.equal(state.statements.length, 0);
    assert.equal(state.closed, 1);
  }
});

test('default provider uses fresh system identity tokens and dedicated encrypted bounded pools', async () => {
  const { state, api } = fixture();
  state.env.NOTIFICATION_DB_SERVER = '  notifications.database.windows.net  ';
  state.env.NOTIFICATION_DB_NAME = '  notification-test  ';
  state.env.AZURE_CLIENT_ID = 'must-not-select-user-assigned-identity';
  const db = api.createNotificationDb();
  await db.query('SELECT 1');
  await db.execute('SELECT 1');
  assert.equal(state.tokenScopes.length, 2);
  assert.ok(state.tokenScopes.every((s) => s === 'https://database.windows.net/.default'));
  assert.ok(state.credentialArgs.every((args) => args.length === 0));
  assert.equal(state.credentialArgs.length, 2);
  assert.equal(state.pools.length, 2);
  assert.equal(state.closed, 2);
  assert.equal(state.connects, 2);
  assert.ok(state.envReads.every((name) => ['NOTIFICATION_DB_SERVER', 'NOTIFICATION_DB_NAME'].includes(name)));
  for (const config of state.poolConfigs) {
    assert.equal(config.server, 'notifications.database.windows.net');
    assert.equal(config.database, 'notification-test');
    assert.equal(config.options.encrypt, true);
    assert.equal(config.options.trustServerCertificate, false);
    assert.equal(config.pool.min, 0);
    assert.equal(config.pool.max, 1);
    assert.equal(config.connectionTimeout, 15_000);
    assert.equal(config.requestTimeout, 30_000);
    assert.equal(config.authentication.type, 'azure-active-directory-access-token');
    assert.equal(config.authentication.options.token, 'offline-test-token');
    assert.equal(config.user, undefined);
    assert.equal(config.password, undefined);
  }
});

test('missing or blank notification config never falls back to legacy SQL config or starts authentication', async () => {
  for (const missing of ['NOTIFICATION_DB_SERVER', 'NOTIFICATION_DB_NAME']) {
    const { state, api } = fixture();
    state.env[missing] = '   ';
    state.env.SAAS_DB_SERVER = 'legacy-server';
    state.env.SAAS_DB_NAME = 'legacy-database';
    await rejectedSafely(api.getNotificationPool(), /Notification database configuration is required/);
    assert.equal(state.credentialArgs.length, 0);
    assert.equal(state.poolConfigs.length, 0);
    assert.ok(!state.envReads.includes('SAAS_DB_SERVER'));
  }
});

test('credential and token failures are sanitized before any SQL connection', async () => {
  for (const flag of ['failCredential', 'failToken']) {
    const { state, api } = fixture();
    state[flag] = true;
    await rejectedSafely(api.getNotificationPool(), /Notification managed identity token unavailable/);
    assert.equal(state.poolConfigs.length, 0);
  }
  for (const token of [null, { token: '', expiresOnTimestamp: NOW + 600_000 },
    { token: '   ', expiresOnTimestamp: NOW + 600_000 },
    { token: 'present', expiresOnTimestamp: NOW + 300_000 },
    { token: 'present', expiresOnTimestamp: NOW - 1 },
    { token: 'present', expiresOnTimestamp: NaN }]) {
    const { state, api } = fixture();
    state.token = token;
    await rejectedSafely(api.getNotificationPool(), /Notification managed identity token unavailable/);
    assert.equal(state.poolConfigs.length, 0);
  }
});

test('connection failure closes dedicated pool even if cleanup fails, with sanitized error', async () => {
  for (const failClose of [false, true]) {
    const { state, api } = fixture();
    state.failConnect = true;
    state.failClose = failClose;
    await rejectedSafely(api.getNotificationPool(), /Notification managed identity SQL connection unavailable/);
    assert.equal(state.closed, 1);
    assert.equal(state.connects, 1);
  }
});

test('default adapter also sanitizes pool-provider errors without leaking config or token failure detail', async () => {
  const { state, api } = fixture();
  state.failToken = true;
  await rejectedSafely(api.createNotificationDb().query('SELECT 1'), /Notification opt-out store unavailable/);
  assert.equal(state.connects, 0);
});
