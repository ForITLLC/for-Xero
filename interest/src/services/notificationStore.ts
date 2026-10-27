import sql from 'mssql';
import { ManagedIdentityCredential } from '@azure/identity';
import { createSqlOptOutStore, type OptOutDb, type OptOutSqlParam, type OptOutStore } from '@foritllc/mail';

const TOKEN_SCOPE = 'https://database.windows.net/.default';
const MIN_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

export type NotificationPoolProvider = () => Promise<sql.ConnectionPool>;

/** Separate notification storage: never borrow the interest application's password pool. */
export async function getNotificationPool(): Promise<sql.ConnectionPool> {
  const server = process.env.NOTIFICATION_DB_SERVER?.trim();
  const database = process.env.NOTIFICATION_DB_NAME?.trim();
  if (!server || !database) throw new Error('Notification database configuration is required');

  let token;
  try {
    // No client-id option: this operation belongs to the system-assigned identity.
    token = await new ManagedIdentityCredential().getToken(TOKEN_SCOPE);
  } catch {
    throw new Error('Notification managed identity token unavailable');
  }
  if (!token?.token?.trim() || !Number.isFinite(token.expiresOnTimestamp) ||
    token.expiresOnTimestamp <= Date.now() + MIN_TOKEN_LIFETIME_MS) {
    throw new Error('Notification managed identity token unavailable');
  }

  let pool: sql.ConnectionPool | undefined;
  try {
    pool = new sql.ConnectionPool({
      server, database,
      connectionTimeout: 15_000,
      requestTimeout: 30_000,
      options: { encrypt: true, trustServerCertificate: false },
      pool: { min: 0, max: 1, idleTimeoutMillis: 30_000 },
      authentication: {
        type: 'azure-active-directory-access-token',
        options: { token: token.token },
      },
    });
    pool.on('error', () => {});
    await pool.connect();
    return pool;
  } catch {
    if (pool) await pool.close().catch(() => {});
    throw new Error('Notification managed identity SQL connection unavailable');
  }
}

/** mssql parameter translation for Common's narrowly defined OptOutDb contract. */
export function createNotificationDb(getPool: NotificationPoolProvider = getNotificationPool): OptOutDb {
  async function withPool<T>(operation: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
    try {
      const pool = await getPool();
      try {
        return await operation(pool);
      } finally {
        await pool.close();
      }
    } catch {
      // Driver exceptions can contain SQL names, identity data and bound values.
      throw new Error('Notification opt-out store unavailable');
    }
  }

  function requestFor(pool: sql.ConnectionPool, params: OptOutSqlParam[]): sql.Request {
    const request = pool.request();
    for (const param of params) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(param.name)) throw new Error('Invalid notification parameter');
      const type = param.type === sql.NVarChar ? sql.NVarChar : param.type === sql.VarChar ? sql.VarChar : undefined;
      if (!type) throw new Error('Unsupported notification parameter type');
      request.input(param.name, type, param.value);
    }
    return request;
  }

  return {
    TYPES: { NVarChar: sql.NVarChar, VarChar: sql.VarChar },
    async query<T = Record<string, unknown>>(text: string, params: OptOutSqlParam[] = []) {
      return withPool(async (pool) => {
        const result = await requestFor(pool, params).query<T>(text);
        const rows = result.recordset;
        if (!Array.isArray(rows)) throw new Error('Notification query result unavailable');
        return { rows, rowCount: rows.length };
      });
    },
    async execute(text: string, params: OptOutSqlParam[] = []) {
      return withPool(async (pool) => {
        const result = await requestFor(pool, params).query(text);
        return result.rowsAffected.reduce((sum, count) => sum + count, 0);
      });
    },
  };
}

/** Construction reads no configuration or credentials; each operation owns its pool. */
export function createNotificationStore(options: { getPool?: NotificationPoolProvider } = {}): OptOutStore {
  return createSqlOptOutStore({ schema: 'interest', db: createNotificationDb(options.getPool) });
}
