'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../revoke-accounting-key.cjs');

const ITEM = 'CE4BEA05-F622-4208-AE39-9CB20B3894C2';
const KEY_ID = 'b3c32598-6e6a-4e8f-be6d-7c914ffd59c7';
const CUSTOMER = '70fbb207-4249-4385-a2c6-4f1767f5c3e9';
const HASH = 'a'.repeat(64);
const request = (mode = 'inspect') => ({ security_item: ITEM, key_id: KEY_ID, expected_hash: HASH, mode });

function fixture() {
  const state = {
    row: { id: KEY_ID, customer_id: CUSTOMER, name: 'finance-portal-recurring-engine', scope: 'full',
      key_hash: HASH, is_active: true, can_update: 1 },
    opened: 0, closed: 0, begins: 0, commits: 0, rollbacks: 0, writes: 0,
    reads: 0, queries: [], updateParams: [], affected: 1,
  };
  let lockTail = Promise.resolve();
  class Transaction {
    async begin() { state.begins++; if (state.failBegin) throw new Error('SQL-BEGIN-secret'); }
    async commit() {
      state.commits++;
      if (this.pending) state.row = this.pending;
      this.unlock?.(); this.unlock = undefined;
      if (state.failCommitAfterWrite) { state.failCommitAfterWrite = false; throw new Error('Commit response lost'); }
    }
    async rollback() { state.rollbacks++; this.pending = undefined; this.unlock?.(); this.unlock = undefined; }
  }
  class Request {
    constructor(target) { this.tx = target instanceof Transaction ? target : null; this.params = {}; }
    input(name, _type, value) { this.params[name] = value; return this; }
    async query(text) {
      state.queries.push(text);
      if (text.includes('sp_getapplock')) {
        assert.match(text, /@LockMode='Exclusive',@LockOwner='Transaction'/);
        const predecessor = lockTail;
        lockTail = new Promise((resolve) => { this.tx.unlock = resolve; });
        await predecessor;
        return { recordset: [] };
      }
      if (text.includes('SELECT id,customer_id')) {
        state.reads++;
        assert.equal(this.params.id, KEY_ID);
        assert.match(text, /HAS_PERMS_BY_NAME\('xero.api_keys','OBJECT','UPDATE','is_active','COLUMN'\)/);
        if (this.tx) assert.match(text, /WITH \(UPDLOCK,HOLDLOCK\)/);
        if (state.failRead || (state.failReadback && state.reads > 1)) throw new Error('SQL-reader-secret');
        const row = this.tx?.pending || state.row;
        return { recordset: state.missing ? [] : state.duplicate ? [row, row] : [{ ...row }] };
      }
      if (text.includes('UPDATE xero.api_keys')) {
        assert.ok(this.tx);
        assert.match(text, /SET is_active=0/);
        assert.match(text, /id=@id AND customer_id=@customer AND name=@name AND scope='full'/);
        assert.match(text, /key_hash=@hash AND is_active=1/);
        assert.doesNotMatch(text, /DELETE|INSERT|last_used_at|key_prefix/);
        state.writes++;
        state.updateParams.push({ ...this.params });
        if (state.failUpdate) throw new Error('SQL-write-secret');
        if (state.affected === 1) this.tx.pending = { ...state.row, is_active: Boolean(state.badReadback) };
        return { recordset: [{ changed_count: state.affected }] };
      }
      throw new Error('Unexpected SQL query');
    }
  }
  const sql = { Transaction, Request, UniqueIdentifier: 'uuid', NVarChar: 'nvarchar' };
  const getPool = async () => { state.opened++; return { close: async () => { state.closed++; } }; };
  const run = (request) => engine.runAccountingKeyOperation({ request, getPool, sql });
  return { state, run };
}

test('invalid item/key, gateway override, malformed hash or extra input touches no dependencies', async () => {
  const { state, run } = fixture();
  for (const value of [null, [], {},
    { ...request(), security_item: 'other' }, { ...request(), key_id: 'gateway-key-id' },
    { ...request(), expected_hash: HASH.toUpperCase() }, { ...request(), expected_hash: 'a'.repeat(63) },
    { ...request(), mode: 'rotate' }, { ...request(), scope: 'read' },
    { ...request(), customer_id: CUSTOMER }, { ...request(), key: 'raw-key' },
  ]) {
    assert.equal(engine.isAccountingKeyRequest(value), false);
    await assert.rejects(run(value), /outside this security item/);
  }
  assert.equal(state.opened, 0);
});

test('inspect is one SELECT without transaction, lock or write and reports effective column permission', async () => {
  for (const permission of [1, 0, null]) {
    const { state, run } = fixture();
    state.row.can_update = permission;
    const result = await run(request());
    assert.equal(result.can_update, permission === 1);
    assert.equal(result.changed, false);
    assert.equal(result.is_active, true);
    assert.equal(state.queries.length, 1);
    assert.equal(state.begins, 0);
    assert.equal(state.writes, 0);
    assert.equal(state.closed, 1);
  }
});

test('hash mismatch cannot revoke pinned candidate', async () => {
  const { state, run } = fixture();
  state.row.key_hash = 'b'.repeat(64);
  await assert.rejects(run(request('revoke')), /identity not proven/);
  assert.equal(state.writes, 0);
  assert.equal(state.closed, 1);
});

test('gateway scope or different customer, name or id fails closed', async () => {
  for (const [field, value] of [['scope', 'read'], ['customer_id', 'other'], ['id', 'other'], ['name', 'for-mcp read 18b3e8e7']]) {
    const { state, run } = fixture();
    state.row[field] = value;
    await assert.rejects(run(request('revoke')), /identity not proven/);
    assert.equal(state.writes, 0);
    assert.equal(state.rollbacks, 1);
    assert.equal(state.closed, 1);
  }
});

test('missing or duplicate row fails closed', async () => {
  for (const field of ['missing', 'duplicate']) {
    const { state, run } = fixture();
    state[field] = true;
    await assert.rejects(run(request('revoke')), /row not found/);
    assert.equal(state.writes, 0);
    assert.equal(state.rollbacks, 1);
    assert.equal(state.closed, 1);
  }
});

test('revoke changes exactly one pinned row and rereads inactive before committing', async () => {
  const { state, run } = fixture();
  const result = await run(request('revoke'));
  assert.deepEqual(state.updateParams, [{ id: KEY_ID, customer: CUSTOMER, name: 'finance-portal-recurring-engine', hash: HASH }]);
  assert.equal(result.changed, true);
  assert.equal(result.is_active, false);
  assert.equal(state.writes, 1);
  assert.equal(state.reads, 2);
  assert.equal(state.commits, 1);
  assert.equal(state.rollbacks, 0);
  assert.equal(state.closed, 1);
});

test('inactive row is idempotent without UPDATE privilege', async () => {
  const { state, run } = fixture();
  state.row.is_active = false;
  state.row.can_update = 0;
  const result = await run(request('revoke'));
  assert.equal(result.changed, false);
  assert.equal(result.is_active, false);
  assert.equal(state.writes, 0);
  assert.equal(state.commits, 1);
  assert.equal(state.closed, 1);
});

test('active row without UPDATE privilege never attempts a write', async () => {
  const { state, run } = fixture();
  state.row.can_update = 0;
  await assert.rejects(run(request('revoke')), /cannot revoke/);
  assert.equal(state.writes, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(state.closed, 1);
});

test('SQL failures and wrong affected counts roll back and close pool', async () => {
  for (const change of [{ failRead: true }, { failUpdate: true }, { affected: 0 }, { affected: 2 }, { failReadback: true }]) {
    const { state, run } = fixture();
    Object.assign(state, change);
    await assert.rejects(run(request('revoke')));
    assert.equal(state.row.is_active, true);
    assert.equal(state.commits, 0);
    assert.equal(state.rollbacks, 1);
    assert.equal(state.closed, 1);
  }
});

test('active readback causes rollback instead of a successful receipt', async () => {
  const { state, run } = fixture();
  state.badReadback = true;
  await assert.rejects(run(request('revoke')), /readback failed/);
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(state.row.is_active, true);
});

test('begin failure closes pool; unknown commit outcome retries without second write', async () => {
  const first = fixture();
  first.state.failBegin = true;
  await assert.rejects(first.run(request('revoke')), /SQL-BEGIN-secret/);
  assert.equal(first.state.closed, 1);
  assert.equal(first.state.rollbacks, 0);
  const { state, run } = fixture();
  state.failCommitAfterWrite = true;
  await assert.rejects(run(request('revoke')), /Commit response lost/);
  const result = await run(request('revoke'));
  assert.equal(result.changed, false);
  assert.equal(result.is_active, false);
  assert.equal(state.writes, 1);
  assert.equal(state.closed, 2);
});

test('concurrent revocations serialize and update once', async () => {
  const { state, run } = fixture();
  const results = await Promise.all([run(request('revoke')), run(request('revoke'))]);
  assert.deepEqual(results.map((r) => r.changed), [true, false]);
  assert.equal(state.writes, 1);
  assert.equal(state.closed, 2);
});

test('receipt contains only safe metadata; module has no output or credential loading', async () => {
  const { state, run } = fixture();
  state.row.key_prefix = 'secret-prefix';
  const result = await run(request('revoke'));
  assert.deepEqual(Object.keys(result).sort(),
    ['security_item', 'key_id', 'customer_id', 'key_name', 'scope', 'is_active', 'changed', 'mode', 'can_update'].sort());
  assert.ok(!JSON.stringify(result).includes(HASH));
  assert.ok(!JSON.stringify(result).includes('secret-prefix'));
  const source = require('node:fs').readFileSync(require.resolve('../revoke-accounting-key.cjs'), 'utf8');
  assert.doesNotMatch(source, /require\(['"](?:mssql|@azure\/|child_process)/);
  assert.doesNotMatch(source, /console\.|process\.stdout|process\.stderr/);
});
