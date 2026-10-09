import { fileURLToPath } from 'node:url'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

export * from './json.ts'
export { schema }

export type Db = NodePgDatabase<typeof schema>
/** A transaction handle; everything that writes domain state takes one. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** Either the root handle or a transaction, for reads that may run inside one. */
export type Queryable = Db | Tx

/**
 * `max` is how many connections the pool may hold at once. Behind a session-mode pooler each one
 * holds a server connection for as long as it is open, so a deployment sizes it (DATABASE_POOL_MAX).
 */
export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max })
  // A connection resting in the pool can be cut (a restart, a failover, a pooler going down), and
  // node-postgres reports it as the pool's `error`, which Node turns into the end of the process
  // when nobody listens. The pool has already let that client go; the next query opens another.
  pool.on('error', (error) => console.error(`postgres: a resting connection closed: ${error.message}`))
  return pool
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema })
}

/** The SQL migrations, for the migrate script and for tests that build a database of their own. */
export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))
