// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Joins and signals as operators read them (`interfaces/operator/joins.ts`): joins found by server,
 * player, address and time; one join with the start its wake asked for, its signals and how often
 * its player came; the join nearest a moment; the signals still open; and a signal closed by an
 * operator. A join's client address and its network's hash are never part of what is read.
 */
import { DAY_MS } from '@blockly/contracts/durations'
import type { JoinDetailView, JoinView, SignalView } from '@blockly/contracts/join-records'
import { type Queryable, schema } from '@blockly/db'
import { and, asc, count, desc, eq, gte, isNull, or, type SQL, sql } from 'drizzle-orm'
import { normalizeUuid } from '../../minecraft/console.ts'

const { joins, signals, minecraftServers: servers, serverOperations: operations } = schema

/** How far back a player's joins on a server are counted: as long as joins are kept. */
const COUNTED_MS = 35 * DAY_MS
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What a list of joins may be narrowed by. */
export interface JoinFilter {
  /** A server's id, or its address's slug. */
  server?: string
  /** A Minecraft name, or a player's uuid. */
  player?: string
  /** A whole address, or its first label. */
  address?: string
  since?: Date
  limit?: number
}

const iso = (at: Date | null) => (at === null ? null : at.toISOString())

function viewOf(row: typeof joins.$inferSelect, serverName: string | null): JoinView {
  const { network: _network, source: _source, ...rest } = row
  return {
    ...rest,
    serverName,
    pingedAt: iso(row.pingedAt),
    connectedAt: row.connectedAt.toISOString(),
    wakeAskedAt: iso(row.wakeAskedAt),
    readyAt: iso(row.readyAt),
    handedAt: iso(row.handedAt),
    loginAt: iso(row.loginAt),
    configureStartedAt: iso(row.configureStartedAt),
    configuredAt: iso(row.configuredAt),
    inWorldAt: iso(row.inWorldAt),
    leftAt: iso(row.leftAt),
    pingedAfterAt: iso(row.pingedAfterAt),
    serverSide: row.serverSide === 'reported' ? 'reported' : 'not_reported',
  }
}

const signalView = (row: typeof signals.$inferSelect): SignalView => ({
  ...row,
  at: row.at.toISOString(),
  closedAt: iso(row.closedAt),
})

/** Whose a player is, as a condition: by uuid where `player` is one, else by name in any case. */
function byPlayer(player: string): SQL {
  const uuid = normalizeUuid(player)
  return UUID.test(uuid) ? eq(joins.playerUuid, uuid) : sql`lower(${joins.playerName}) = lower(${player})`
}

/** Joins, the newest first, at most `limit` (500 at the most). */
export async function listJoins(q: Queryable, filter: JoinFilter): Promise<JoinView[]> {
  const where: SQL[] = []
  if (filter.server !== undefined)
    where.push(UUID.test(filter.server) ? eq(joins.serverId, filter.server) : eq(servers.slug, filter.server))
  if (filter.player !== undefined) where.push(byPlayer(filter.player))
  if (filter.address !== undefined) {
    const address = filter.address.toLowerCase()
    where.push(
      address.includes('.')
        ? eq(joins.address, address)
        : sql`split_part(${joins.address}, '.', 1) = ${address}`,
    )
  }
  if (filter.since !== undefined) where.push(gte(joins.connectedAt, filter.since))
  const rows = await q
    .select({ join: joins, serverName: servers.name })
    .from(joins)
    .leftJoin(servers, eq(servers.id, joins.serverId))
    .where(and(...where))
    .orderBy(desc(joins.connectedAt))
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 500))
  return rows.map((row) => viewOf(row.join, row.serverName))
}

/** One join, with what explains it; null for none. */
export async function joinDetail(q: Queryable, id: string): Promise<JoinDetailView | null> {
  if (!UUID.test(id)) return null
  const [row] = await q
    .select({ join: joins, serverName: servers.name })
    .from(joins)
    .leftJoin(servers, eq(servers.id, joins.serverId))
    .where(eq(joins.id, id))
  if (row === undefined) return null
  const { join } = row
  const [wake] =
    join.wakeOperationId === null
      ? []
      : await q.select().from(operations).where(eq(operations.id, join.wakeOperationId))
  const raised = await q.select().from(signals).where(eq(signals.joinId, id)).orderBy(asc(signals.at))
  const [counted] =
    join.serverId === null || (join.playerUuid === null && join.playerName === null)
      ? []
      : await q
          .select({ joins: count() })
          .from(joins)
          .where(
            and(
              eq(joins.serverId, join.serverId),
              eq(joins.kind, 'join'),
              byPlayer(join.playerUuid ?? join.playerName ?? ''),
              gte(joins.connectedAt, new Date(Date.now() - COUNTED_MS)),
            ),
          )
  return {
    join: viewOf(join, row.serverName),
    wake:
      wake === undefined
        ? null
        : {
            id: wake.id,
            kind: wake.kind,
            status: wake.status,
            createdAt: wake.createdAt.toISOString(),
            finishedAt: iso(wake.finishedAt),
            steps: wake.steps ?? [],
          },
    signals: raised.map(signalView),
    joinsOnServer: counted?.joins ?? 0,
  }
}

/** The id of `player`'s join nearest `at`, or their latest without one; null for none. */
export async function findJoin(q: Queryable, player: string, at?: Date): Promise<string | null> {
  const nearest =
    at === undefined
      ? desc(joins.connectedAt)
      : sql`abs(extract(epoch from (${joins.connectedAt} - ${at.toISOString()}::timestamptz)))`
  const [row] = await q
    .select({ id: joins.id })
    .from(joins)
    .where(and(eq(joins.kind, 'join'), byPlayer(player)))
    .orderBy(nearest)
    .limit(1)
  return row?.id ?? null
}

/** The open signals, oldest first, and with `since`, those closed since then too. */
export async function listSignals(q: Queryable, since?: Date): Promise<SignalView[]> {
  const rows = await q
    .select()
    .from(signals)
    .where(
      since === undefined
        ? isNull(signals.closedAt)
        : or(isNull(signals.closedAt), gte(signals.closedAt, since)),
    )
    .orderBy(asc(signals.at), asc(signals.id))
  return rows.map(signalView)
}

/** Closes an open signal, saying who did; null for no such signal, or one already closed. */
export async function closeSignal(
  q: Queryable,
  id: number,
  by: string,
  now: Date,
): Promise<SignalView | null> {
  const [closed] = await q
    .update(signals)
    .set({ closedAt: now, closedBy: by })
    .where(and(eq(signals.id, id), isNull(signals.closedAt)))
    .returning()
  return closed === undefined ? null : signalView(closed)
}
