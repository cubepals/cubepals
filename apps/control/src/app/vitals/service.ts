// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How each Paper server ticks, as its reporter plugin samples it once a minute: kept as it comes
 * (a sample sent twice is kept once, one from long ago or the future not at all), read back for
 * one server with what its samples add up to, and the servers that ticked worst, the most minutes
 * behind first, with whose they are. Samples are kept 7 days (`vitals-sweep`).
 *
 * Not for a join's own tick, which its `joins` row keeps (`joins/server-events.ts`).
 */
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import {
  LAGGING_TPS,
  type ServerVitals,
  type ServerVitalsView,
  type VitalsListView,
  type VitalsRowView,
  type VitalsSummaryView,
} from '@blockly/contracts/server-vitals'
import { type Db, schema } from '@blockly/db'
import { and, asc, eq, gte, lt, type SQL, sql } from 'drizzle-orm'
import { serverTicked } from '../platform/telemetry.ts'
import type { Limits } from '../ports/limits.ts'
import { tuning } from '../tuning.ts'

/** Days a sample is kept. */
export const VITALS_KEPT_DAYS = 7
/** How far from now a sample may say it was taken: a queue that waited, or a clock off a little. */
const OLDEST_MS = HOUR_MS
const NEWEST_MS = 5 * MINUTE_MS

const v = schema.serverVitals

/** A timestamp as `toISOString()` writes it: raw rows come back as Postgres's own text. */
const iso = (column: SQL) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

/** What samples add up to, as columns of one row, over `server_vitals v`. */
const SUMMARY = sql`count(*)::int as samples, ${iso(sql`min(v.at)`)} as "firstAt", ${iso(sql`max(v.at)`)} as "lastAt",
  min(v.tps)::float8 as "tpsMin", avg(v.tps)::float8 as "tpsMean",
  percentile_cont(0.5) within group (order by v.mspt)::float8 as "msptP50",
  percentile_cont(0.95) within group (order by v.mspt_p95)::float8 as "msptP95",
  max(v.mspt_max)::float8 as "msptMax",
  (count(*) filter (where v.tps < ${LAGGING_TPS}))::int as "laggingMinutes",
  coalesce(max(v.heap_used_mb::float8 / nullif(v.heap_max_mb, 0)), 0)::float8 as "heapShareMax",
  max(v.gc_ms)::int as "gcMsMax", max(v.players)::int as "playersMax",
  max(v.chunks)::int as "chunksMax", max(v.entities)::int as "entitiesMax"`

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places

function summaryOf(row: VitalsSummaryView): VitalsSummaryView {
  return {
    ...row,
    tpsMin: round(row.tpsMin),
    tpsMean: round(row.tpsMean),
    msptP50: round(row.msptP50),
    msptP95: round(row.msptP95),
    msptMax: round(row.msptMax),
    heapShareMax: round(row.heapShareMax, 3),
  }
}

export class VitalsService {
  readonly #db: Db
  readonly #limits: Limits

  constructor(deps: { db: Db; limits: Limits }) {
    this.#db = deps.db
    this.#limits = deps.limits
  }

  /**
   * Whether `serverId` may post another report this minute, counting it when it may: as often as
   * the deployment's ABUSE_LIMITS allow (`vitalsReportsPerMinute`).
   */
  mayReport(serverId: string, now = new Date()): Promise<boolean> {
    const minute = Math.floor(now.getTime() / MINUTE_MS)
    return this.#limits.allow(`vitals:${serverId}:${minute}`, tuning().abuse.vitalsReportsPerMinute)
  }

  /** Keeps a server's samples, once each; how many were new. */
  async record(serverId: string, samples: readonly ServerVitals[], now = new Date()): Promise<number> {
    const fresh = samples.filter((sample) => {
      const ms = new Date(sample.at).getTime() - now.getTime()
      return ms > -OLDEST_MS && ms < NEWEST_MS
    })
    if (fresh.length === 0) return 0
    const kept = await this.#db
      .insert(v)
      .values(fresh.map((sample) => ({ ...sample, serverId, at: new Date(sample.at) })))
      .onConflictDoNothing()
      .returning({ mspt: v.mspt })
    for (const { mspt } of kept) serverTicked(mspt)
    return kept.length
  }

  /** One server's samples since `since`, oldest first, the newest, and what they add up to. */
  async ofServer(serverId: string, since: Date, now = new Date()): Promise<ServerVitalsView> {
    const rows = await this.#db
      .select()
      .from(v)
      .where(and(eq(v.serverId, serverId), gte(v.at, since), lt(v.at, new Date(now.getTime() + NEWEST_MS))))
      .orderBy(asc(v.at))
    const [server] = await this.#db
      .select({ name: schema.minecraftServers.name })
      .from(schema.minecraftServers)
      .where(eq(schema.minecraftServers.id, serverId))
    const { rows: summed } = await this.#db.execute<VitalsSummaryView & Record<string, unknown>>(
      sql`select ${SUMMARY} from server_vitals v where v.server_id = ${serverId} and v.at >= ${since}`,
    )
    const samples = rows.map(({ id: _id, serverId: _server, at, ...sample }) => ({
      ...sample,
      at: at.toISOString(),
    }))
    const summary = summed[0]
    return {
      serverId,
      serverName: server?.name ?? null,
      since: since.toISOString(),
      latest: samples.at(-1) ?? null,
      summary: summary === undefined || summary.samples === 0 ? null : summaryOf(summary),
      samples,
    }
  }

  /**
   * The servers that reported since `since`, the most minutes behind first and then the slowest,
   * each with whose it is; only `ownerId`'s where given.
   */
  async worst(filter: { since: Date; limit?: number; ownerId?: string }): Promise<VitalsListView> {
    const owner = filter.ownerId === undefined ? sql`` : sql`and s.owner_id = ${filter.ownerId}`
    const { rows } = await this.#db.execute<VitalsRowView & Record<string, unknown>>(
      sql`select v.server_id as "serverId", s.name as "serverName", s.owner_id as "ownerId",
          u.email as "ownerEmail", ${SUMMARY}
        from server_vitals v
        join minecraft_servers s on s.id = v.server_id
        left join users u on u.id = s.owner_id
        where v.at >= ${filter.since} ${owner}
        group by v.server_id, s.name, s.owner_id, u.email
        order by "laggingMinutes" desc, "msptP95" desc
        limit ${filter.limit ?? 25}`,
    )
    return {
      since: filter.since.toISOString(),
      servers: rows.map((row) => ({ ...row, ...summaryOf(row) })),
    }
  }

  /** `vitals-sweep`: forgets samples past their days. How many it forgot. */
  async sweep(now = new Date()): Promise<number> {
    const gone = await this.#db
      .delete(v)
      .where(lt(v.at, new Date(now.getTime() - VITALS_KEPT_DAYS * DAY_MS)))
      .returning({ id: v.id })
    return gone.length
  }
}
