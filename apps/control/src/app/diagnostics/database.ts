// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The database as it is now, read on an operator's ask from Postgres's own statistics: who holds
 * connections, the queries running long or waiting on a lock and who holds it, the statements that
 * took the most time since `pg_stat_statements` last reset, and the tables read most by sequential
 * scans. Every query's text passes through `shapeOf` first, so a literal someone typed by hand
 * never reaches an operator's answer.
 *
 * Not for the figures a monitor scrapes every half minute (`infra/metrics/postgres.ts`).
 */
import type {
  ActivityView,
  DatabaseQuery,
  DatabaseView,
  StatementView,
  TableView,
} from '@blockly/contracts/diagnostics'
import type { Db } from '@blockly/db'
import { sql } from 'drizzle-orm'
import { shapeOf } from './statement.ts'

/** The most of a query's text each answer keeps. */
const QUERY_CHARS = 1000

const ORDER = {
  total: sql`total_exec_time`,
  mean: sql`mean_exec_time`,
  calls: sql`calls`,
  max: sql`max_exec_time`,
} as const

/** A row as the driver hands it back: the view's fields, typed as the query casts them. */
type Raw<T> = T & Record<string, unknown>

const textOf = (query: unknown) => (shapeOf(query)?.text ?? '').slice(0, QUERY_CHARS)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]

async function connections(db: Db): Promise<{ rows: DatabaseView['connections']; max: number }> {
  const { rows } = await db.execute<{ application: string; state: string; count: number; max: number }>(
    sql`select coalesce(nullif(application_name, ''), '(unnamed)') as application,
        coalesce(state, '(none)') as state, count(*)::int as count,
        current_setting('max_connections')::int as max
      from pg_stat_activity
      where backend_type = 'client backend' and datname = current_database()
      group by 1, 2 order by 3 desc`,
  )
  const max = rows[0]?.max ?? 0
  return { rows: rows.map(({ application, state, count }) => ({ application, state, count })), max }
}

/** Running past a second, waiting on a lock, or holding a transaction open while idle. */
async function active(db: Db): Promise<ActivityView[]> {
  const { rows } = await db.execute<Omit<ActivityView, 'blockedBy'> & { blockedBy: number[] | null }>(
    sql`select pid, coalesce(nullif(application_name, ''), '(unnamed)') as application,
        coalesce(state, '(none)') as state, wait_event_type as wait,
        extract(epoch from clock_timestamp() - query_start)::float8 as "querySeconds",
        extract(epoch from clock_timestamp() - xact_start)::float8 as "transactionSeconds",
        pg_blocking_pids(pid) as "blockedBy", query
      from pg_stat_activity
      where backend_type = 'client backend' and datname = current_database() and pid <> pg_backend_pid()
        and (cardinality(pg_blocking_pids(pid)) > 0
          or (state <> 'idle' and query_start < clock_timestamp() - interval '1 second'))
      order by query_start limit 50`,
  )
  return rows.map((row) => ({ ...row, blockedBy: row.blockedBy ?? [], query: textOf(row.query) }))
}

async function statements(
  db: Db,
  order: keyof typeof ORDER,
  limit: number,
): Promise<DatabaseView['statements']> {
  const { rows: found } = await db.execute<{ schema: string }>(
    sql`select n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'pg_stat_statements'`,
  )
  const schema = found[0]?.schema
  if (schema === undefined)
    return { available: false, why: 'pg_stat_statements is not installed in this database' }
  const view = sql.identifier(schema)
  try {
    const { rows } = await db.execute<Raw<StatementView & { hit: number; read: number }>>(
      sql`select queryid::text as "queryId", coalesce(r.rolname, '?') as role, calls::float8 as calls,
          total_exec_time::float8 as "totalMs", mean_exec_time::float8 as "meanMs",
          max_exec_time::float8 as "maxMs", rows::float8 as rows,
          shared_blks_hit::float8 as hit, shared_blks_read::float8 as read, query
        from ${view}.pg_stat_statements p left join pg_roles r on r.oid = p.userid
        where p.dbid = (select oid from pg_database where datname = current_database())
        order by ${ORDER[order]} desc limit ${limit}`,
    )
    const since = await db
      .execute<{ since: string | null }>(
        sql`select to_char(stats_reset at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as since
          from ${view}.pg_stat_statements_info`,
      )
      .then(({ rows: info }) => info[0]?.since ?? null)
      .catch(() => null)
    return {
      available: true,
      since,
      top: rows.map(({ hit, read, ...row }) => ({
        ...row,
        cacheHit: hit + read === 0 ? null : hit / (hit + read),
        // Postgres takes values out of ordinary statements, but not of every kind (`SET`).
        query: textOf(row.query),
      })),
    }
  } catch (error) {
    // Installed, but not loaded at startup (`shared_preload_libraries`), or not ours to read.
    return { available: false, why: `pg_stat_statements could not be read: ${messageOf(error)}` }
  }
}

async function tables(db: Db): Promise<TableView[]> {
  const { rows } = await db.execute<Raw<TableView>>(
    sql`select schemaname || '.' || relname as name,
        pg_total_relation_size(relid)::float8 as "sizeBytes", n_live_tup::float8 as rows,
        n_dead_tup::float8 as "deadRows", seq_scan::float8 as "seqScans",
        seq_tup_read::float8 as "seqRows", coalesce(idx_scan, 0)::float8 as "indexScans",
        to_char(last_autovacuum at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "lastAutovacuum"
      from pg_stat_user_tables order by seq_tup_read desc limit 15`,
  )
  return rows
}

/** The database now. Statements this database can't count say why, in place of the list. */
export async function databaseNow(
  db: Db,
  query: DatabaseQuery = {},
  now = new Date(),
): Promise<DatabaseView> {
  const [held, running, top, read] = await Promise.all([
    connections(db),
    active(db),
    statements(db, query.order ?? 'total', query.limit ?? 20),
    tables(db),
  ])
  return {
    at: now.toISOString(),
    connections: held.rows,
    max: held.max,
    active: running,
    statements: top,
    tables: read,
  }
}
