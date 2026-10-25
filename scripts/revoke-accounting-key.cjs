'use strict';

// Product-owned migration engine. The CI runner supplies its existing Entra
// SQL connection; this module acquires no credentials and prints no material.
const ACCOUNTING_SECURITY_ITEM = 'CE4BEA05-F622-4208-AE39-9CB20B3894C2';
const ACCOUNTING_KEY_ID = 'b3c32598-6e6a-4e8f-be6d-7c914ffd59c7';
const CUSTOMER_ID = '70fbb207-4249-4385-a2c6-4f1767f5c3e9';
const KEY_NAME = 'finance-portal-recurring-engine';

/** The hash must come from the sealed accounting-binding comparison. */
function isAccountingKeyRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const expected = ['security_item', 'key_id', 'expected_hash', 'mode'];
  return Object.keys(body).length === expected.length &&
    expected.every((name) => Object.prototype.hasOwnProperty.call(body, name)) &&
    body.security_item === ACCOUNTING_SECURITY_ITEM && body.key_id === ACCOUNTING_KEY_ID &&
    typeof body.expected_hash === 'string' && /^[a-f0-9]{64}$/.test(body.expected_hash) &&
    (body.mode === 'inspect' || body.mode === 'revoke');
}

function assertTarget(row, expectedHash) {
  if (!row || typeof row.id !== 'string' || typeof row.customer_id !== 'string' ||
    row.id.toLowerCase() !== ACCOUNTING_KEY_ID || row.customer_id.toLowerCase() !== CUSTOMER_ID ||
    row.name !== KEY_NAME || row.scope !== 'full' || row.key_hash !== expectedHash ||
    typeof row.is_active !== 'boolean') {
    throw new Error('Exact accounting key identity not proven');
  }
}

async function runAccountingKeyOperation({ request, getPool, sql }) {
  if (!isAccountingKeyRequest(request)) throw new Error('Operation is outside this security item');
  // Snapshot validated input before asynchronous work begins.
  const mode = request.mode;
  const expectedHash = request.expected_hash;
  const pool = await getPool();
  let tx;
  let begun = false;
  try {
    if (mode === 'revoke') {
      tx = new sql.Transaction(pool);
      await tx.begin();
      begun = true;
      await new sql.Request(tx).query(`
        DECLARE @result int;
        EXEC @result=sys.sp_getapplock @Resource='xero:revoke-accounting:${ACCOUNTING_SECURITY_ITEM}',
          @LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=15000;
        IF @result<0 THROW 53201,'Accounting key operation is already running',1;
      `);
    }
    const readTarget = async () => {
      const query = tx ? new sql.Request(tx) : new sql.Request(pool);
      const result = await query
        .input('id', sql.UniqueIdentifier, ACCOUNTING_KEY_ID)
        .query(`SELECT id,customer_id,name,scope,key_hash,is_active,
          HAS_PERMS_BY_NAME('xero.api_keys','OBJECT','UPDATE','is_active','COLUMN') AS can_update
          FROM xero.api_keys ${tx ? 'WITH (UPDLOCK,HOLDLOCK)' : ''} WHERE id=@id`);
      if (result.recordset.length !== 1) throw new Error('Exact accounting key row not found');
      const row = result.recordset[0];
      assertTarget(row, expectedHash);
      return row;
    };
    let row = await readTarget();
    let changed = false;
    if (mode === 'revoke' && row.is_active) {
      if (row.can_update !== 1) throw new Error('Product identity cannot revoke the accounting key');
      const update = await new sql.Request(tx)
        .input('id', sql.UniqueIdentifier, ACCOUNTING_KEY_ID)
        .input('customer', sql.UniqueIdentifier, CUSTOMER_ID)
        .input('name', sql.NVarChar, KEY_NAME)
        .input('hash', sql.NVarChar, expectedHash)
        .query(`UPDATE xero.api_keys SET is_active=0
          WHERE id=@id AND customer_id=@customer AND name=@name AND scope='full'
            AND key_hash=@hash AND is_active=1;
          SELECT @@ROWCOUNT AS changed_count;`);
      if (update.recordset.length !== 1 || update.recordset[0].changed_count !== 1) {
        throw new Error('Accounting key update did not affect exactly one row');
      }
      row = await readTarget();
      if (row.is_active) throw new Error('Accounting key revocation readback failed');
      changed = true;
    }
    if (tx) {
      await tx.commit();
      begun = false;
    }
    return {
      security_item: ACCOUNTING_SECURITY_ITEM, key_id: ACCOUNTING_KEY_ID,
      customer_id: CUSTOMER_ID, key_name: KEY_NAME, scope: 'full',
      is_active: row.is_active, changed, mode, can_update: row.can_update === 1,
    };
  } finally {
    if (begun && tx) await tx.rollback().catch(() => {});
    await pool.close();
  }
}

module.exports = {
  ACCOUNTING_SECURITY_ITEM, ACCOUNTING_KEY_ID, isAccountingKeyRequest, runAccountingKeyOperation,
};
