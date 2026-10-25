'use strict';

// Runs inside the existing product migration workflow; no database password or
// administrator/other-product credential is borrowed.
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const sql = require(path.resolve(__dirname, '../connector/node_modules/mssql'));
const { runAccountingKeyOperation, isAccountingKeyRequest } = require('./revoke-accounting-key.cjs');

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Requires the product workflow on main');
  }
  const request = Object.fromEntries(['security_item', 'key_id', 'expected_hash', 'mode']
    .map((name) => [name, process.env[name.toUpperCase()]]));
  if (!isAccountingKeyRequest(request)) throw new Error('Invalid operation');
  const az = (args) => execFileSync('az', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const identity = JSON.parse(az(['account', 'show', '-o', 'json', '--only-show-errors']));
  if (identity.user?.name !== '4a5dbf71-78f8-4d3d-96fe-67f16e76242a'
    || identity.user?.type !== 'servicePrincipal'
    || identity.tenantId !== 'c0efa09e-4bda-4a9d-a177-4c77076b7f76'
    || identity.id !== '147a19b0-f6a7-4b0b-89e9-49f4aabd1435') throw new Error('Wrong product identity');
  let token = az(['account', 'get-access-token', '--resource', 'https://database.windows.net/',
    '--query', 'accessToken', '-o', 'tsv', '--only-show-errors']);
  if (!token) throw new Error('Product SQL token unavailable');
  const getPool = async () => {
    const pool = new sql.ConnectionPool({
      server: 'forit-saas-sql.database.windows.net', database: 'forit',
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: 15000, requestTimeout: 30000,
      authentication: { type: 'azure-active-directory-access-token', options: { token } },
      pool: { min: 0, max: 1 },
    });
    pool.on('error', () => {});
    try {
      await pool.connect();
      const identity = await pool.request().query(`SELECT USER_NAME() AS principal_name,
        IS_MEMBER('db_owner') AS is_owner, IS_MEMBER('db_securityadmin') AS is_security_admin`);
      const row = identity.recordset[0];
      if (identity.recordset.length !== 1 || row.principal_name !== 'github-actions-forit-xero'
        || row.is_owner !== 0 || row.is_security_admin !== 0) throw new Error('Wrong SQL principal');
      return pool;
    } catch {
      await pool.close().catch(() => {});
      throw new Error('Product SQL connection or identity refused');
    }
  };
  const receipt = await runAccountingKeyOperation({ request, getPool, sql });
  token = '';
  const evidence = { ...receipt, run_id: process.env.GITHUB_RUN_ID,
    commit: process.env.GITHUB_SHA, execution_identity: 'github-actions-forit-xero',
    completed_at: new Date().toISOString() };
  writeFileSync('accounting-key-revocation-receipt.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}

main().catch(() => {
  // Driver/CLI failures can contain credentials: output only a fixed failure.
  console.error('Accounting key operation failed; reconcile row state before retry.');
  process.exitCode = 1;
});
