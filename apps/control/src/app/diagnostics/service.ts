// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What ran slow or failed, as operators read it: the records narrowed by account, server, what
 * and when, and grouped by what they share with how slow each group ran and whom it touched. Also
 * where the recorder writes (`write`) and the sweep that forgets records past their days.
 *
 * The module's other parts: `context.ts` (whose the work in hand is), `statement.ts` (a query's
 * shape and its name), `recorder.ts` (keeps what ran slow or failed, bounded, in batches),
 * `database.ts` (the database now) and `diagnosis.ts` (one account's trouble in one answer).
 */
import type {
  DatabaseQuery,
  DatabaseView,
  DIAGNOSTIC_GROUPS,
  DiagnosticGroupView,
  DiagnosticsQuery,
  DiagnosticsSummaryView,
  DiagnosticView,
} from '@blockly/contracts/diagnostics'
import { DAY_MS } from '@blockly/contracts/durations'
import { type Db, schema } from '@blockly/db'
import { lt, type SQL, sql } from 'drizzle-orm'
import { databaseNow } from './database.ts'
import type { DiagnosticRecord, Thresholds } from './recorder.ts'
import { THRESHOLDS } from './recorder.ts'

/** Days a record is kept. */
export const DIAGNOSTICS_KEPT_DAYS = 14

/** A filter with the account already resolved to its id. */
export type DiagnosticsFilter = Omit<DiagnosticsQuery, 'account'> & { accountId?: string }

type Row = Omit<DiagnosticView, 'id'> & { id: number | string }

/** A timestamp as `toISOString()` writes it: raw rows come back as Postgres's own text. */
const iso = (column: SQL) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
const view = (row: Row): DiagnosticView => ({ ...row, id: Number(row.id), ms: Number(row.ms) })

/** `%` and `_` taken literally, for a `like` that matches what the text starts with. */
const prefix = (text: string) => `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

function whereOf(filter: DiagnosticsFilter, now: Date): SQL {
  const since = filter.since === undefined ? new Date(now.getTime() - DAY_MS) : new Date(filter.since)
  const where = [sql`d.at >= ${since}`]
  if (filter.until !== undefined) where.push(sql`d.at < ${new Date(filter.until)}`)
  // An account's own work, and anything done on its servers, a worker's included.
  if (filter.accountId !== undefined)
    where.push(
      sql`(d.account_id = ${filter.accountId} or d.server_id in (select id from minecraft_servers where owner_id = ${filter.accountId}))`,
    )
  if (filter.server !== undefined) where.push(sql`d.server_id = ${filter.server}`)
  if (filter.kind !== undefined) where.push(sql`d.kind = ${filter.kind}`)
  if (filter.name !== undefined) where.push(sql`d.name = ${filter.name}`)
  if (filter.origin !== undefined) where.push(sql`d.origin like ${prefix(filter.origin)}`)
  if (filter.failed === 'true') where.push(sql`d.error is not null`)
  if (filter.failed === 'false') where.push(sql`d.error is null`)
  return sql.join(where, sql` and `)
}

const COLUMNS = sql`d.id, ${iso(sql`d.at`)} as at, d.kind, d.name, d.ms, d.error, d.origin, d.role,
  d.account_id as "accountId", u.email as "accountEmail", d.server_id as "serverId",
  s.name as "serverName", d.request_id as "requestId", d.detail`
const JOINED = sql`diagnostics d
  left join users u on u.id = d.account_id
  left join minecraft_servers s on s.id = d.server_id`

/** What each grouping groups on, and the label it reads for an account or a server. */
const GROUPS: Record<(typeof DIAGNOSTIC_GROUPS)[number], { key: SQL; label: SQL }> = {
  name: { key: sql`d.name`, label: sql`null` },
  kind: { key: sql`d.kind`, label: sql`null` },
  origin: { key: sql`d.origin`, label: sql`null` },
  account: { key: sql`coalesce(d.account_id, '(none)')`, label: sql`max(u.email)` },
  server: { key: sql`coalesce(d.server_id::text, '(none)')`, label: sql`max(s.name)` },
}

export class DiagnosticsService {
  readonly #db: Db
  readonly #thresholds: Thresholds

  constructor(db: Db, thresholds: Thresholds = THRESHOLDS) {
    this.#db = db
    this.#thresholds = thresholds
  }

  /** Keeps what the recorder held, in one statement. */
  async write(records: readonly DiagnosticRecord[]): Promise<void> {
    if (records.length === 0) return
    await this.#db.insert(schema.diagnostics).values([...records])
  }

  /** The records `filter` finds, the newest first. */
  async list(filter: DiagnosticsFilter, now = new Date()): Promise<DiagnosticView[]> {
    const { rows } = await this.#db.execute<Row>(
      sql`select ${COLUMNS} from ${JOINED} where ${whereOf(filter, now)}
        order by d.at desc limit ${filter.limit ?? 100}`,
    )
    return rows.map(view)
  }

  /** The records `filter` finds, grouped by `by`, the groups with the most first. */
  async summary(
    filter: DiagnosticsFilter & { by?: (typeof DIAGNOSTIC_GROUPS)[number] },
    now = new Date(),
  ): Promise<DiagnosticsSummaryView> {
    const by = filter.by ?? 'name'
    const group = GROUPS[by]
    const where = whereOf(filter, now)
    const { rows } = await this.#db.execute<{
      key: string
      label: string | null
      count: number
      failed: number
      accounts: number
      servers: number
      p50: number
      p95: number
      max: number
      first: string
      last: string
      slowest: number | string
    }>(
      sql`select ${group.key} as key, ${group.label} as label, count(*)::int as count,
          count(d.error)::int as failed, count(distinct d.account_id)::int as accounts,
          count(distinct d.server_id)::int as servers,
          percentile_cont(0.5) within group (order by d.ms)::float8 as p50,
          percentile_cont(0.95) within group (order by d.ms)::float8 as p95,
          max(d.ms)::float8 as max, ${iso(sql`min(d.at)`)} as first, ${iso(sql`max(d.at)`)} as last,
          (array_agg(d.id order by d.ms desc))[1] as slowest
        from ${JOINED} where ${where}
        group by 1 order by count(*) desc, max(d.ms) desc limit ${filter.limit ?? 25}`,
    )
    const slowest = await this.#byIds(rows.map((row) => Number(row.slowest)))
    const totals = await this.#db.execute<{ total: number; failed: number }>(
      sql`select count(*)::int as total, count(d.error)::int as failed from diagnostics d where ${where}`,
    )
    const groups = rows.flatMap((row): DiagnosticGroupView[] => {
      const record = slowest.get(Number(row.slowest))
      if (record === undefined) return []
      return [
        {
          key: row.key,
          label: row.label,
          count: row.count,
          failed: row.failed,
          accounts: row.accounts,
          servers: row.servers,
          p50Ms: Math.round(row.p50),
          p95Ms: Math.round(row.p95),
          maxMs: Math.round(row.max),
          firstAt: row.first,
          lastAt: row.last,
          slowest: record,
        },
      ]
    })
    return {
      since: (filter.since === undefined
        ? new Date(now.getTime() - DAY_MS)
        : new Date(filter.since)
      ).toISOString(),
      until: (filter.until === undefined ? now : new Date(filter.until)).toISOString(),
      by,
      total: totals.rows[0]?.total ?? 0,
      failed: totals.rows[0]?.failed ?? 0,
      groups,
      thresholds: { ...this.#thresholds },
    }
  }

  async #byIds(ids: readonly number[]): Promise<Map<number, DiagnosticView>> {
    if (ids.length === 0) return new Map()
    const { rows } = await this.#db.execute<Row>(
      sql`select ${COLUMNS} from ${JOINED} where d.id in ${[...ids]}`,
    )
    return new Map(rows.map((row) => [Number(row.id), view(row)]))
  }

  /** The database as it is now (`database.ts`). */
  database(query: DatabaseQuery = {}, now = new Date()): Promise<DatabaseView> {
    return databaseNow(this.#db, query, now)
  }

  /** `diagnostics-sweep`: forgets records past their days. How many it forgot. */
  async sweep(now = new Date()): Promise<number> {
    const { diagnostics } = schema
    const old = new Date(now.getTime() - DIAGNOSTICS_KEPT_DAYS * DAY_MS)
    const gone = await this.#db
      .delete(diagnostics)
      .where(lt(diagnostics.at, old))
      .returning({ id: diagnostics.id })
    return gone.length
  }
}
