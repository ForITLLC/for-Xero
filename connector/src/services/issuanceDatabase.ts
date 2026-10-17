import sql from 'mssql';
import { ManagedIdentityCredential } from '@azure/identity';

const SQL_TOKEN_SCOPE = 'https://database.windows.net/.default';
const MIN_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

/** Non-secret driver settings, isolated from the connector's legacy password pool. */
export function buildIssuanceSqlConfig(env: NodeJS.ProcessEnv): sql.config {
  return {
    server: env.SAAS_DB_SERVER || 'forit-saas-sql.database.windows.net',
    database: env.SAAS_DB_NAME || 'forit',
    connectionTimeout: 15000,
    requestTimeout: 30000,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
    pool: { min: 0, max: 2, idleTimeoutMillis: 30000 },
  };
}

/**
 * A dedicated pool for one issuance operation. The caller must close it in a
 * finally block after its transaction finishes. A token-authenticated pool
 * retains its login token for new connections, so sharing it across requests
 * would eventually reconnect with an expired token. Acquire a fresh token and
 * pool each time instead; never use sql.connect's global pool here.
 */
export async function getIssuancePool(): Promise<sql.ConnectionPool> {
  const clientId = process.env.ISSUANCE_MANAGED_IDENTITY_CLIENT_ID?.trim();
  const credential = clientId
    ? new ManagedIdentityCredential({ clientId })
    : new ManagedIdentityCredential();

  let token;
  try {
    token = await credential.getToken(SQL_TOKEN_SCOPE);
  } catch {
    throw new Error('Managed identity SQL token unavailable');
  }
  if (!token?.token || token.expiresOnTimestamp <= Date.now() + MIN_TOKEN_LIFETIME_MS) {
    throw new Error('Managed identity SQL token unavailable');
  }

  const pool = new sql.ConnectionPool({
    ...buildIssuanceSqlConfig(process.env),
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token: token.token },
    },
  });
  // mssql emits pool-level errors as well as rejecting requests. Keep the
  // emitter handled; request failures reach the caller's rollback/error path.
  pool.on('error', () => {});
  try {
    await pool.connect();
    return pool;
  } catch {
    await pool.close().catch(() => {});
    throw new Error('Managed identity SQL connection unavailable');
  }
}
