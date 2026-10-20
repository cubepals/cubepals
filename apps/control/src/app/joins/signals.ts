// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `signals` job: every minute, each kind of signal the `SIGNALS` setting turns on is judged,
 * and each one found is raised once (`signals`, unique by key), with the server's and the player's
 * names, the address, the figure and its limit. Kinds judged from joins alone are
 * `signal-kinds.ts`'s; those that read wakes, the platform's hour or a server's boot report are
 * here. A signal left open a day is closed as expired.
 *
 * The setting is the operators', never in this repository: unset, or not a `SignalsConfig`, no
 * kind runs, and the log says so once.
 */
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { SignalsConfig } from '@blockly/contracts/join-records'
import { type Db, type Queryable, schema } from '@blockly/db'
import { and, count, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { tuning } from '../tuning.ts'
import { fromJoins, type JoinRow, type Raised, watched } from './signal-kinds.ts'

const {
  joins,
  signals,
  minecraftServers: servers,
  publicListings: listings,
  serverOperations: operations,
} = schema

/** How far back the joins are read: further than any kind looks. */
const READ_MS = 6 * HOUR_MS
/** How long a signal stays open before it is closed as expired. */
const OPEN_MS = DAY_MS

let said: 'unset' | 'invalid' | null = null

/** The setting in force; null, said once, when it is unset or isn't a `SignalsConfig`. */
function signalsConfig(): SignalsConfig | null {
  const given = tuning().joins?.signals
  const parsed = given === undefined ? null : SignalsConfig.safeParse(given)
  if (parsed?.success) return parsed.data
  const why = parsed === null ? 'unset' : 'invalid'
  if (said !== why)
    console.warn(`signals: SIGNALS is ${why === 'unset' ? 'unset' : 'not the shape it should be'}; none run`)
  said = why
  return null
}

/** Raises what the setting finds at `now`, and closes what has been open a day. How many it raised. */
export async function raiseSignals(db: Db, now: Date): Promise<number> {
  await db
    .update(signals)
    .set({ closedAt: now, closedBy: 'system:expired' })
    .where(and(isNull(signals.closedAt), lt(signals.at, new Date(now.getTime() - OPEN_MS))))
  const config = signalsConfig()
  if (config === null) return 0
  const rows = await joinRows(db, config, now)
  const raised = [
    ...fromJoins(config, rows, now),
    ...(await wakesNobodyJoined(db, config, now)),
    ...(await repeatedWakes(db, config, now)),
    ...(await platformCrowd(db, config, now)),
    ...(await legacyLoginListeners(db, config, now)),
  ]
  if (raised.length === 0) return 0
  const written = await db
    .insert(signals)
    .values(raised)
    .onConflictDoNothing({ target: signals.key })
    .returning({ id: signals.id })
  return written.length
}

/** Joins of the last hours, with their server's name, whether it is ours, and how their wake went. */
async function joinRows(q: Queryable, config: SignalsConfig, now: Date): Promise<JoinRow[]> {
  const rows = await q
    .select({
      join: joins,
      serverName: servers.name,
      official: listings.official,
      wakeKind: operations.kind,
      resumed: sql<boolean>`coalesce(${operations.steps} @> '[{"step":"resuming"}]'::jsonb and not ${operations.steps} @> '[{"step":"booting"}]'::jsonb, false)`,
    })
    .from(joins)
    .leftJoin(servers, eq(servers.id, joins.serverId))
    .leftJoin(listings, eq(listings.serverId, joins.serverId))
    .leftJoin(operations, eq(operations.id, joins.wakeOperationId))
    .where(gt(joins.connectedAt, new Date(now.getTime() - READ_MS)))
  return rows.map(({ join, serverName, official, wakeKind, resumed }) => ({
    ...join,
    serverName,
    ours: config.ourServers === 'official' && official === true,
    wake: wakeKind === null ? null : wakeKind === 'unstore' ? 'atRest' : resumed ? 'memory' : 'stopped',
  }))
}

/** The servers that are Cubepals' own, by id, among `ids`. */
async function oursAmong(q: Queryable, config: SignalsConfig, ids: readonly string[]): Promise<Set<string>> {
  if (config.ourServers !== 'official' || ids.length === 0) return new Set()
  const rows = await q
    .select({ serverId: listings.serverId })
    .from(listings)
    .where(and(inArray(listings.serverId, [...ids]), eq(listings.official, true)))
  return new Set(rows.map((r) => r.serverId))
}

/**
 * Runs woken in the last day that nobody joined: so many on one server; and, on Cubepals' own
 * servers with `oursAnyFromWatched`, any whose waking join came through a watched address.
 */
async function wakesNobodyJoined(q: Queryable, config: SignalsConfig, now: Date): Promise<Raised[]> {
  const limits = config.wakeNoJoin
  if (limits === undefined) return []
  const runs = await q
    .select({
      id: schema.powerIntervals.id,
      serverId: schema.powerIntervals.serverId,
      startedAt: schema.powerIntervals.startedAt,
      server: servers.name,
    })
    .from(schema.powerIntervals)
    .innerJoin(servers, eq(servers.id, schema.powerIntervals.serverId))
    .where(
      and(
        gt(schema.powerIntervals.stoppedAt, new Date(now.getTime() - DAY_MS)),
        eq(schema.powerIntervals.woken, true),
        isNull(schema.powerIntervals.joinedAt),
      ),
    )
  const day = now.toISOString().slice(0, 10)
  const raised: Raised[] = []
  const perServer = new Map<string, typeof runs>()
  for (const run of runs) perServer.set(run.serverId, [...(perServer.get(run.serverId) ?? []), run])
  const limit = limits.perServerPerDay
  for (const [serverId, theirs] of perServer)
    if (limit !== undefined && theirs.length >= limit)
      raised.push({
        kind: 'wake_no_join',
        key: `wake_no_join:${serverId}:${day}`,
        serverId,
        joinId: null,
        at: now,
        detail: { server: theirs[0]?.server ?? null, figure: theirs.length, limit },
      })
  if (limits.oursAnyFromWatched !== true) return raised
  const ours = await oursAmong(q, config, [...perServer.keys()])
  for (const run of runs.filter((r) => ours.has(r.serverId))) {
    const [waking] = await q
      .select({ id: joins.id, address: joins.address, player: joins.playerName })
      .from(joins)
      .where(
        and(
          eq(joins.serverId, run.serverId),
          isNotNull(joins.wakeAskedAt),
          gt(joins.wakeAskedAt, new Date(run.startedAt.getTime() - MINUTE_MS)),
          lt(joins.wakeAskedAt, new Date(run.startedAt.getTime() + MINUTE_MS)),
        ),
      )
      .limit(1)
    if (waking === undefined || !watched(config, waking.address)) continue
    raised.push({
      kind: 'wake_no_join',
      key: `wake_no_join:${run.serverId}:${run.id}`,
      serverId: run.serverId,
      joinId: waking.id,
      at: now,
      detail: { server: run.server, player: waking.player, address: waking.address },
    })
  }
  return raised
}

/** A server woken by joins so many times in the last hour. */
async function repeatedWakes(q: Queryable, config: SignalsConfig, now: Date): Promise<Raised[]> {
  const limit = config.repeatedWakes?.perServerPerHour
  if (limit === undefined) return []
  const rows = await q
    .select({ serverId: operations.serverId, server: servers.name, figure: count() })
    .from(operations)
    .innerJoin(servers, eq(servers.id, operations.serverId))
    .where(
      and(
        inArray(operations.kind, ['start', 'unstore']),
        eq(operations.requestedBy, 'system:wake'),
        gt(operations.createdAt, new Date(now.getTime() - HOUR_MS)),
      ),
    )
    .groupBy(operations.serverId, servers.name)
  const hour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS
  return rows
    .filter((row) => row.figure >= limit)
    .map((row) => ({
      kind: 'repeated_wakes' as const,
      key: `repeated_wakes:${row.serverId}:${hour}`,
      serverId: row.serverId,
      joinId: null,
      at: now,
      detail: { server: row.server, figure: row.figure, limit },
    }))
}

/** Joins on the whole platform in the last hour, against the same hour of the seven days before. */
async function platformCrowd(q: Queryable, config: SignalsConfig, now: Date): Promise<Raised[]> {
  const over = config.crowd?.platformHourOverAverage
  if (over === undefined) return []
  const hourCount = (daysBack: number) => {
    const end = new Date(now.getTime() - daysBack * DAY_MS)
    return sql<number>`count(*) filter (where ${joins.connectedAt} > ${new Date(end.getTime() - HOUR_MS).toISOString()}::timestamptz and ${joins.connectedAt} <= ${end.toISOString()}::timestamptz)`
  }
  const [row] = await q
    .select({
      now: hourCount(0),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [`d${d}`, hourCount(d)])),
    })
    .from(joins)
    .where(and(eq(joins.kind, 'join'), gt(joins.connectedAt, new Date(now.getTime() - 8 * DAY_MS))))
  const before = [1, 2, 3, 4, 5, 6, 7].map((d) =>
    Number((row as Record<string, unknown> | undefined)?.[`d${d}`] ?? 0),
  )
  const average = before.reduce((a, b) => a + b, 0) / before.length
  const figure = Number(row?.now ?? 0)
  if (average === 0 || figure <= over * average) return []
  return [
    {
      kind: 'crowd',
      key: `crowd:platform:${Math.floor(now.getTime() / HOUR_MS) * HOUR_MS}`,
      serverId: null,
      joinId: null,
      at: now,
      detail: { figure, limit: Math.round(over * average * 10) / 10, average },
    },
  ]
}

/** A server that booted in the last day with plugins listening as players log in. */
async function legacyLoginListeners(q: Queryable, config: SignalsConfig, now: Date): Promise<Raised[]> {
  const legacy = config.legacyLoginListener
  if (legacy === undefined) return []
  const rows = await q
    .select({ report: schema.serverReports, server: servers.name, official: listings.official })
    .from(schema.serverReports)
    .innerJoin(servers, eq(servers.id, schema.serverReports.serverId))
    .leftJoin(listings, eq(listings.serverId, schema.serverReports.serverId))
    .where(
      and(
        gt(schema.serverReports.reportedAt, new Date(now.getTime() - DAY_MS)),
        sql`jsonb_array_length(coalesce(${schema.serverReports.detail} -> 'loginListeners', '[]'::jsonb)) > 0`,
      ),
    )
  return rows
    .filter((row) => legacy.oursOnly !== true || (config.ourServers === 'official' && row.official === true))
    .map(({ report, server }) => ({
      kind: 'legacy_login_listener' as const,
      key: `legacy_login_listener:${report.serverId}:${report.reportedAt.toISOString()}`,
      serverId: report.serverId,
      joinId: null,
      at: now,
      detail: { server, plugins: report.detail.loginListeners },
    }))
}
