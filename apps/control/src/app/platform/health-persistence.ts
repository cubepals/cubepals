// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The SQL behind platform health (`health.ts`): every figure is aggregated in Postgres, one query
 * per section, over `server_operations` (its `steps` and the `operations_finished` and
 * `operations_open` indexes), `minecraft_servers`, `power_intervals` and `spend_days`. Each read
 * takes `now`, so a test can fix it. What the figures mean and who may read them is `health.ts`'s.
 */
import type { HealthWindow } from '@blockly/contracts'
import type { OperationStepJson, Queryable } from '@blockly/db'
import { type SQL, sql } from 'drizzle-orm'
import { WOKEN_BY } from '../operations/handlers/bringing-up.ts'

/** An operation's kind as health names it (`HealthKind`), for `server_operations o`. */
const healthKind = sql`(case o.kind
  when 'provision' then 'create'
  when 'unstore' then 'wake_from_rest'
  when 'store' then 'rest'
  when 'start' then (case when o.requested_by = ${WOKEN_BY} then 'wake' else 'start' end)
  else o.kind::text end)`

/** The operation kinds behind the health kinds that are timed. */
const TIMED = sql`('provision', 'start', 'unstore', 'store', 'restart', 'apply', 'restore')`

/** A timestamp as `toISOString()` writes it: raw rows come back as Postgres's own text. */
const iso = (column: SQL) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const rowsOf = async <T>(q: Queryable, query: SQL): Promise<T[]> => (await q.execute(query)).rows as T[]

export async function serverStates(
  q: Queryable,
): Promise<Array<{ region: string; status: string; n: number }>> {
  return rowsOf(
    q,
    sql`select region_key as region, status::text as status, count(*)::int as n
      from minecraft_servers
      where deleted_at is null and status not in ('deleted', 'purged')
      group by 1, 2`,
  )
}

export async function openOperations(
  q: Queryable,
): Promise<Array<{ kind: string; queued: number; running: number; oldestAt: string }>> {
  return rowsOf(
    q,
    sql`select ${healthKind} as kind,
        count(*) filter (where o.status = 'queued')::int as queued,
        count(*) filter (where o.status = 'running')::int as running,
        ${iso(sql`min(o.created_at)`)} as "oldestAt"
      from server_operations o
      where o.status in ('queued', 'running')
      group by 1
      order by min(o.created_at)`,
  )
}

export interface DurationRow {
  window: HealthWindow
  kind: string
  /** Set on a row split by region, or by setup; both null on the kind's own row. */
  region: string | null
  setup: string | null
  count: number
  failed: number
  median: number | null
  p90: number | null
  slowest: number | null
}

/**
 * How long each timed kind took in each window, from being asked for to finished: the kind's own
 * row, then one per region and one per setup (`template · paper`). Succeeded work is timed, failed
 * work counted; cancelled work is neither.
 */
export async function durations(q: Queryable, now: Date): Promise<DurationRow[]> {
  return rowsOf(
    q,
    sql`with timed as (
        select ${healthKind} as kind, o.status, o.finished_at,
          extract(epoch from o.finished_at - o.created_at)::float8 as seconds,
          s.region_key as region,
          coalesce(s.created_from, 'direct') || ' · ' || coalesce(r.loader::text, 'unknown') as setup
        from server_operations o
        join minecraft_servers s on s.id = o.server_id
        left join server_revisions r on r.id = s.desired_revision_id
        where o.finished_at > ${now}::timestamptz - interval '30 days'
          and o.finished_at <= ${now}::timestamptz
          and o.status in ('succeeded', 'failed')
          and o.kind in ${TIMED}
      )
      select w.key as window, t.kind,
        case when grouping(t.region) = 0 then t.region end as region,
        case when grouping(t.setup) = 0 then t.setup end as setup,
        count(*) filter (where t.status = 'succeeded')::int as count,
        count(*) filter (where t.status = 'failed')::int as failed,
        percentile_cont(0.5) within group (order by t.seconds) filter (where t.status = 'succeeded') as median,
        percentile_cont(0.9) within group (order by t.seconds) filter (where t.status = 'succeeded') as p90,
        max(t.seconds) filter (where t.status = 'succeeded') as slowest
      from timed t
      join (values ('24h', interval '1 day'), ('7d', interval '7 days'), ('30d', interval '30 days'))
        as w(key, span) on t.finished_at > ${now}::timestamptz - w.span
      group by grouping sets ((w.key, t.kind), (w.key, t.kind, t.region), (w.key, t.kind, t.setup))`,
  )
}

/**
 * The median of each timed kind that succeeded in each of the last `buckets` spans of `spanSeconds`
 * before `now`, bucket 0 the latest. Spans nothing finished in have no row.
 */
export async function trend(
  q: Queryable,
  now: Date,
  spanSeconds: number,
  buckets: number,
): Promise<Array<{ kind: string; bucket: number; count: number; median: number }>> {
  return rowsOf(
    q,
    sql`select ${healthKind} as kind,
        floor(extract(epoch from ${now}::timestamptz - o.finished_at) / ${spanSeconds})::int as bucket,
        count(*)::int as count,
        percentile_cont(0.5) within group (order by extract(epoch from o.finished_at - o.created_at)::float8)
          as median
      from server_operations o
      where o.finished_at > ${now}::timestamptz - make_interval(secs => ${spanSeconds * buckets})
        and o.finished_at <= ${now}::timestamptz
        and o.status = 'succeeded'
        and o.kind in ${TIMED}
      group by 1, 2`,
  )
}

export interface OperationRow {
  id: string
  kind: string
  serverId: string
  serverName: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  step: string | null
  error: string | null
  detail: string | null
  createdAt: string
  finishedAt: string | null
  seconds: number
  steps: OperationStepJson[] | null
}

export interface OperationFilter {
  /** Finished at or after it, or asked for at or after it and not finished. */
  since: Date
  /** A health kind (`wake`), or an operation's own kind for one that isn't (`backup`). */
  kind?: string
  /** Only the kinds health times. */
  timedOnly?: boolean
  slowerThan?: number
  status?: OperationRow['status']
  /** Only operations on these servers. */
  serverIds?: readonly string[]
  order: 'newest' | 'slowest'
  limit: number
}

const operationColumns = (now: Date) => sql`o.id, ${healthKind} as kind, o.server_id as "serverId",
  s.name as "serverName", o.status::text as status,
  coalesce(o.progress->>'step', o.steps->-1->>'step') as step, o.error, o.detail,
  ${iso(sql`o.created_at`)} as "createdAt", ${iso(sql`o.finished_at`)} as "finishedAt",
  extract(epoch from coalesce(o.finished_at, ${now}::timestamptz) - o.created_at)::float8 as seconds,
  o.steps`

export async function findOperations(
  q: Queryable,
  filter: OperationFilter,
  now: Date,
): Promise<OperationRow[]> {
  const where = [
    sql`(o.finished_at >= ${filter.since} or (o.finished_at is null and o.created_at >= ${filter.since}))`,
  ]
  if (filter.kind !== undefined) where.push(sql`${healthKind} = ${filter.kind}`)
  if (filter.timedOnly) where.push(sql`o.kind in ${TIMED}`)
  if (filter.status !== undefined) where.push(sql`o.status = ${filter.status}`)
  if (filter.serverIds !== undefined)
    where.push(filter.serverIds.length === 0 ? sql`false` : sql`o.server_id in ${[...filter.serverIds]}`)
  if (filter.slowerThan !== undefined)
    where.push(
      sql`extract(epoch from coalesce(o.finished_at, ${now}::timestamptz) - o.created_at) >= ${filter.slowerThan}`,
    )
  const order =
    filter.order === 'slowest' ? sql`seconds desc` : sql`coalesce(o.finished_at, o.created_at) desc`
  return rowsOf(
    q,
    sql`select ${operationColumns(now)}
      from server_operations o
      join minecraft_servers s on s.id = o.server_id
      where ${sql.join(where, sql` and `)}
      order by ${order}
      limit ${filter.limit}`,
  )
}

export async function findOperation(q: Queryable, id: string, now: Date): Promise<OperationRow | null> {
  const [row] = await rowsOf<OperationRow>(
    q,
    sql`select ${operationColumns(now)}
      from server_operations o
      join minecraft_servers s on s.id = o.server_id
      where o.id = ${id}`,
  )
  return row ?? null
}

/** Server hours run from `from` to `now`, a run still open counted to `now`. */
export async function runningHours(q: Queryable, from: Date, now: Date): Promise<number> {
  const [row] = await rowsOf<{ hours: number }>(
    q,
    sql`select coalesce(sum(extract(epoch from
          least(coalesce(stopped_at, ${now}::timestamptz), ${now}::timestamptz)
          - greatest(started_at, ${from}::timestamptz))), 0)::float8 / 3600 as hours
      from power_intervals
      where started_at < ${now}::timestamptz
        and (stopped_at is null or stopped_at > ${from}::timestamptz)`,
  )
  return row?.hours ?? 0
}

/** What the spend watchdog worked out for each day from `from` (`YYYY-MM-DD`) on. */
export async function spendSince(
  q: Queryable,
  from: string,
): Promise<Array<{ day: string; cents: number; trippedAt: string | null }>> {
  return rowsOf(
    q,
    sql`select day::text as day, (compute_cents + stray_cents + storage_cents)::int as cents,
        ${iso(sql`tripped_at`)} as "trippedAt"
      from spend_days where day >= ${from}::date`,
  )
}
