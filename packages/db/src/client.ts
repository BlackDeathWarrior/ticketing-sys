import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** A transaction handle; services accept either so callers can compose them. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Tx;

export interface DbHandle {
  db: Database;
  pool: Pool;
  close(): Promise<void>;
}

export function createDb(
  url: string,
  options: Omit<PoolConfig, 'connectionString'> = {},
): DbHandle {
  const pool = new Pool({ connectionString: url, max: 10, ...options });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
