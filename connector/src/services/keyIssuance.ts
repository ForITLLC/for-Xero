import sql from 'mssql';
import { createHash, randomBytes } from 'node:crypto';
import { ManagedIdentityCredential } from '@azure/identity';
import { SecretClient, KeyVaultSecret } from '@azure/keyvault-secrets';
import { getIssuancePool } from './issuanceDatabase';

// This operation implements one recorded approval, not a general key mint API.
export const APPROVED_DECISION_ID = '18b3e8e7-0812-4bea-9cad-8351c1d2277a';
const CUSTOMER_ID = '70fbb207-4249-4385-a2c6-4f1767f5c3e9';
const CUSTOMER_EMAIL = 'b.thomas@forit.io';
const SECRET_NAME = 'xero-api-key-for-mcp';
const KEY_NAME = `for-mcp read ${APPROVED_DECISION_ID}`;
const VAULT_URL = 'https://forit-saas-kv.vault.azure.net';

export interface IssuanceReceipt {
  decision_id: string;
  key_id: string;
  customer_id: string;
  scope: 'read';
  secret_name: string;
  secret_version: string;
  reused: boolean;
}

type Vault = Pick<SecretClient, 'getSecret' | 'setSecret'>;
interface Dependencies {
  getPool: typeof getIssuancePool;
  getVault: () => Vault;
  generateKey: () => string;
}

export function getIssuanceVault(): SecretClient {
  const clientId = process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID;
  const credential = clientId ? new ManagedIdentityCredential(clientId) : new ManagedIdentityCredential();
  // A successful PUT with a lost response must not be retried by the SDK:
  // every PUT creates another version. Reconcile through getSecret on a new call.
  return new SecretClient(VAULT_URL, credential, { retryOptions: { maxRetries: 0 } });
}

function digest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function createReadKeyIssuer(deps: Dependencies = {
  getPool: getIssuancePool,
  getVault: getIssuanceVault,
  generateKey: () => `fmcp_${randomBytes(32).toString('base64url')}`,
}): (decisionId: string) => Promise<IssuanceReceipt> {
  return async (decisionId) => {
    if (decisionId !== APPROVED_DECISION_ID) throw new Error('Decision is outside this operation');
    const pool = await deps.getPool();
    const tx = new sql.Transaction(pool);
    let begun = false;
    try {
      await tx.begin();
      begun = true;
      // All instances serialize on the same lock, including vault-first recovery.
      await new sql.Request(tx).query(`
        DECLARE @r int;
        EXEC @r=sys.sp_getapplock @Resource='xero:for-mcp:${APPROVED_DECISION_ID}',
          @LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=15000;
        IF @r<0 THROW 50001,'Issuance is already running',1;
        IF COL_LENGTH('xero.api_keys','scope') IS NULL THROW 50002,'Scope column absent',1;
      `);
      const customer = await new sql.Request(tx)
        .input('customer', sql.UniqueIdentifier, CUSTOMER_ID)
        .input('email', sql.NVarChar, CUSTOMER_EMAIL)
        .query(`SELECT c.id FROM xero.customers c WHERE c.id=@customer AND c.email=@email
          AND EXISTS (SELECT 1 FROM xero.customer_products cp JOIN xero.products p ON p.id=cp.product_id
            WHERE cp.customer_id=c.id AND p.slug='xero-connector' AND cp.status IN ('active','trial'))
          AND (SELECT COUNT(*) FROM xero.xero_connections xc WHERE xc.customer_id=c.id)=1`);
      if (customer.recordset.length !== 1) throw new Error('Exact customer readiness not proven');
      const existing = await new sql.Request(tx)
        .input('name', sql.NVarChar, KEY_NAME)
        .query('SELECT id,customer_id,key_hash,key_prefix,scope,is_active FROM xero.api_keys WHERE name=@name');
      if (existing.recordset.length > 1) throw new Error('Duplicate issuance rows');
      const row = existing.recordset[0];
      const vault = deps.getVault();
      let secret: KeyVaultSecret | undefined;
      try {
        secret = await vault.getSecret(SECRET_NAME);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
      const reused = Boolean(secret);
      if (!secret) {
        if (row) throw new Error('Existing key has no vault version; operator reconciliation required');
        const key = deps.generateKey();
        if (!/^fmcp_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid generated key');
        // The value is persisted only here, never in SQL or a response/log.
        secret = await vault.setSecret(SECRET_NAME, key, {
          enabled: true,
          tags: { decision_id: decisionId, scope: 'read', customer_id: CUSTOMER_ID },
        });
      }
      const tags = secret.properties.tags;
      const key = secret.value;
      const version = secret.properties.version;
      if (!key || !/^fmcp_[A-Za-z0-9_-]{43}$/.test(key) || !version || secret.properties.enabled === false
        || tags?.decision_id !== decisionId || tags?.scope !== 'read' || tags?.customer_id !== CUSTOMER_ID) {
        throw new Error('Vault version does not match this approved issuance');
      }
      const hash = digest(key);
      // The schema requires a label, but none of the credential bytes belong in SQL.
      const prefix = 'fmcp_read';
      let keyId: string;
      if (row) {
        if (row.customer_id.toLowerCase() !== CUSTOMER_ID || row.scope !== 'read' || !row.is_active
          || row.key_hash !== hash || row.key_prefix !== prefix) throw new Error('Database and vault disagree');
        keyId = row.id;
      } else {
        // Retrying after a vault success and SQL failure reuses the saved value.
        // The same approval can never create a second secret version or key.
        const inserted = await new sql.Request(tx)
          .input('customer', sql.UniqueIdentifier, CUSTOMER_ID)
          .input('hash', sql.NVarChar, hash)
          .input('prefix', sql.NVarChar, prefix)
          .input('name', sql.NVarChar, KEY_NAME)
          .query(`INSERT INTO xero.api_keys (customer_id,key_hash,key_prefix,name,scope)
            OUTPUT INSERTED.id VALUES (@customer,@hash,@prefix,@name,'read')`);
        keyId = inserted.recordset[0].id;
      }
      await tx.commit();
      begun = false;
      return { decision_id: decisionId, key_id: keyId, customer_id: CUSTOMER_ID, scope: 'read',
        secret_name: SECRET_NAME, secret_version: version, reused };
    } catch (error) {
      if (begun) { try { await tx.rollback(); } catch { /* preserve unknown outcome for reconciliation */ } }
      throw error;
    } finally {
      await pool.close();
    }
  };
}

export const issueForMcpReadKey = createReadKeyIssuer();
