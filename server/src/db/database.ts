import mariadb, { type PoolConnection, type FieldInfo, type TypeCastNextFunction } from 'mariadb';
export function utcDateCast(field:FieldInfo,next:TypeCastNextFunction) {
  if(!['DATE','DATETIME','TIMESTAMP'].includes(field.type))return next();
  const text=field.string();
  if(text===null || text.startsWith('0000-00-00'))return null;
  return new Date(text.length===10?`${text}T00:00:00Z`:`${text.replace(' ','T')}Z`);
}
export interface Connection {
  query<T = Record<string, any>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Connection {
  transaction<T>(fn: (connection: Connection) => Promise<T>): Promise<T>;
  withConnection<T>(fn: (connection: Connection) => Promise<T>): Promise<T>;
}
export function databaseOptions(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'mariadb:' || !/^\/[A-Za-z0-9_]+$/.test(url.pathname)) throw new Error('DATABASE_URL must be mariadb://user:password@host:3306/database');
  if ([...url.searchParams.keys()].some(key => key !== 'ssl') || (url.searchParams.has('ssl') && url.searchParams.get('ssl') !== 'true')) throw new Error('Only ssl=true is supported as a database URL option');
  return {
    host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: url.pathname.slice(1), ssl: url.searchParams.get('ssl') === 'true', timezone: '+00:00', charset: 'utf8mb4',typeCast:utcDateCast,
    connectionLimit: 10, connectTimeout: 5000, acquireTimeout: 10000, queryTimeout: 10000, multipleStatements: false,
  };
}
function connectionAdapter(client: PoolConnection): Connection {
  return { async query<T>(sql: string, values?: unknown[]) {
    const result = await client.query(sql, values?.map(value=>value instanceof Date?value.toISOString().slice(0,23).replace('T',' '):value));
    return { rows: (Array.isArray(result) ? result : []) as T[] };
  } };
}
export function mariaDatabase(url: string) {
  const pool = mariadb.createPool(databaseOptions(url));
  async function withConnection<T>(fn: (connection: Connection) => Promise<T>) {
    const client = await pool.getConnection();
    try { return await fn(connectionAdapter(client)); } finally { await client.release(); }
  }
  const db: Database = {
    query: (sql, values) => withConnection(tx => tx.query(sql, values)), withConnection,
    async transaction(fn) {
      const client = await pool.getConnection();
      try {
        // Reads after waiting for the policy lock must see the preceding commit.
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await client.beginTransaction();
        const result = await fn(connectionAdapter(client));
        await client.commit(); return result;
      } catch (error) {
        try { await client.rollback(); } catch { client.destroy(); }
        throw error;
      } finally { await client.release(); }
    },
  };
  return { db, close: () => pool.end() };
}
