// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Queryable, schema } from '@blockly/db'
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { serverRan } from '../insight/record.ts'
import { markActive } from './persistence.ts'

const intervals = schema.powerIntervals
const presence = schema.serverPresence
const activity = schema.serverActivity
const played = schema.serverPlayers

/** Power intervals are facts: when a server started running and when it stopped. */
export async function openInterval(
  q: Queryable,
  serverId: string,
  memoryTier: string,
  at: Date,
  /** True when a connection woke it rather than a person starting it in the app. */
  woken = false,
): Promise<void> {
  await q
    .insert(intervals)
    .values({
      serverId,
      memoryTier,
      // The runtime it runs on as it starts, so time on each runtime is counted where it ran.
      provider: sql`(SELECT ${schema.serverRuntimes.provider} FROM ${schema.serverRuntimes} WHERE ${schema.serverRuntimes.serverId} = ${serverId})`,
      startedAt: at,
      woken,
    })
    .onConflictDoNothing()
  // Its first start ever, and a first wake, are kept for the funnel in the same transaction.
  await serverRan(q, serverId, woken, at)
}

/** The longest gap between presence readings credited as play: one missed, not an outage. */
const MAX_SAMPLE_MINUTES = 3

/**
 * One presence reading, counted as play on the runtime the server runs on (docs/runtimes.md):
 * players online times the minutes since the server's last reading, at most a few.
 */
export async function recordPlay(
  q: Queryable,
  serverId: string,
  provider: string,
  online: number,
  at: Date,
): Promise<void> {
  const [last] = await q
    .select({ at: sql<Date | null>`max(${schema.serverUsageDays.lastSampleAt})` })
    .from(schema.serverUsageDays)
    .where(eq(schema.serverUsageDays.serverId, serverId))
  const since = last?.at === null || last?.at === undefined ? null : new Date(last.at)
  const minutes =
    since === null ? 1 : Math.max(0, Math.min((at.getTime() - since.getTime()) / 60_000, MAX_SAMPLE_MINUTES))
  const players = Math.round(online * minutes)
  const active = online > 0 ? Math.round(minutes) : 0
  const day = at.toISOString().slice(0, 10)
  await q
    .insert(schema.serverUsageDays)
    .values({
      serverId,
      day,
      provider,
      playerMinutes: players,
      activeMinutes: active,
      peakPlayers: online,
      lastSampleAt: at,
    })
    .onConflictDoUpdate({
      target: [schema.serverUsageDays.serverId, schema.serverUsageDays.day, schema.serverUsageDays.provider],
      set: {
        playerMinutes: sql`${schema.serverUsageDays.playerMinutes} + ${players}`,
        activeMinutes: sql`${schema.serverUsageDays.activeMinutes} + ${active}`,
        peakPlayers: sql`greatest(${schema.serverUsageDays.peakPlayers}, ${online})`,
        lastSampleAt: at,
      },
    })
}

/** Statuses in which a server has no compute running, so no power interval should be open. */
const POWERED_OFF = ['stopped', 'failed', 'deleted', 'purged', 'storing', 'stored'] as const

/**
 * Intervals still open on servers that aren't running, each with when its server last changed:
 * a stop whose worker died before closing it, a boot that failed after opening one.
 */
export async function strayIntervals(q: Queryable): Promise<Array<{ serverId: string; lastChanged: Date }>> {
  return q
    .select({ serverId: intervals.serverId, lastChanged: schema.minecraftServers.updatedAt })
    .from(intervals)
    .innerJoin(schema.minecraftServers, eq(schema.minecraftServers.id, intervals.serverId))
    .where(and(isNull(intervals.stoppedAt), inArray(schema.minecraftServers.status, [...POWERED_OFF])))
}

export async function closeInterval(q: Queryable, serverId: string, at: Date): Promise<void> {
  await q
    .update(intervals)
    .set({ stoppedAt: at })
    .where(and(eq(intervals.serverId, serverId), isNull(intervals.stoppedAt)))
}

// ─── Presence: derived and disposable (unlogged tables) ────────────────────────────────────

export interface PresentPlayer {
  uuid: string
  name: string
}

/**
 * Replaces who is online with an authoritative reading from the server itself, and remembers
 * each of them as someone who has played there.
 */
export async function replacePresence(
  q: Queryable,
  serverId: string,
  players: readonly PresentPlayer[],
  at: Date,
): Promise<void> {
  await q.delete(presence).where(eq(presence.serverId, serverId))
  if (players.length > 0) {
    await q
      .insert(presence)
      .values(
        players.map((p) => ({
          serverId,
          playerUuid: p.uuid,
          playerName: p.name,
          source: 'rcon',
          seenAt: at,
        })),
      )
      .onConflictDoNothing()
    await rememberPlayers(q, serverId, players, at, 'server')
    await touchActivity(q, serverId, at)
    // Somebody the server itself says is on: the one reading nobody outside can forge, and so
    // the one that keeps a world from resting. At most one write in ten minutes.
    await markActive(q, serverId, at, 10)
  }
}

/**
 * A hint from the edge: someone connected or left. RCON readings overwrite these. Someone who
 * connected is remembered too, as the edge named them: a friend the whitelist turned away is
 * exactly who the owner may want to add next. The name is only what their game claimed, so it
 * never renames a player the server already knows.
 */
export async function recordEdgePresence(
  q: Queryable,
  serverId: string,
  player: PresentPlayer,
  event: 'connect' | 'disconnect',
  at: Date,
): Promise<void> {
  if (event === 'connect') {
    await q
      .insert(presence)
      .values({ serverId, playerUuid: player.uuid, playerName: player.name, source: 'edge', seenAt: at })
      .onConflictDoUpdate({
        target: [presence.serverId, presence.playerUuid],
        set: { seenAt: at, playerName: player.name },
      })
    await rememberPlayers(q, serverId, [player], at, 'claimed')
  } else {
    await q.delete(presence).where(and(eq(presence.serverId, serverId), eq(presence.playerUuid, player.uuid)))
  }
  await touchActivity(q, serverId, at)
}

export async function clearPresence(q: Queryable, serverId: string): Promise<void> {
  await q.delete(presence).where(eq(presence.serverId, serverId))
}

async function touchActivity(q: Queryable, serverId: string, at: Date): Promise<void> {
  await q
    .insert(activity)
    .values({ serverId, lastPlayerAt: at })
    .onConflictDoUpdate({ target: activity.serverId, set: { lastPlayerAt: at } })
}

export async function lastActivity(q: Queryable, serverId: string): Promise<Date | null> {
  const [row] = await q.select().from(activity).where(eq(activity.serverId, serverId))
  return row?.lastPlayerAt ?? null
}

export async function presenceFor(
  q: Queryable,
  serverIds: readonly string[],
): Promise<Map<string, PresentPlayer[]>> {
  const result = new Map<string, PresentPlayer[]>()
  if (serverIds.length === 0) return result
  const rows = await q
    .select()
    .from(presence)
    .where(inArray(presence.serverId, [...serverIds]))
  for (const row of rows) {
    const list = result.get(row.serverId) ?? []
    list.push({ uuid: row.playerUuid, name: row.playerName })
    result.set(row.serverId, list)
  }
  return result
}

export async function openIntervalStart(q: Queryable, serverId: string): Promise<Date | null> {
  return (await openRun(q, serverId))?.startedAt ?? null
}

/** The run a server is in now: when it started, and whether a connection is what started it. */
export async function openRun(
  q: Queryable,
  serverId: string,
): Promise<{ startedAt: Date; woken: boolean } | null> {
  const [row] = await q
    .select({ startedAt: intervals.startedAt, woken: intervals.woken })
    .from(intervals)
    .where(and(eq(intervals.serverId, serverId), isNull(intervals.stoppedAt)))
  return row ?? null
}

/**
 * How many times a connection woke this server in the last hour. It bounds what a flood can
 * cost when every other defence is off — a public server with no whitelist, waking for anyone.
 */
export async function wakesInLastHour(q: Queryable, serverId: string, now: Date): Promise<number> {
  const [row] = await q
    .select({ count: count() })
    .from(intervals)
    .where(
      and(
        eq(intervals.serverId, serverId),
        eq(intervals.woken, true),
        gte(intervals.startedAt, new Date(now.getTime() - 3_600_000)),
      ),
    )
  return row?.count ?? 0
}

/** The server's current session (its open power interval), and the last cap warning it got. */
export async function openSession(
  q: Queryable,
  serverId: string,
): Promise<{ startedAt: Date; warnedMinutes: number | null } | null> {
  const [row] = await q
    .select({ startedAt: intervals.startedAt, warnedMinutes: intervals.sessionWarnedMinutes })
    .from(intervals)
    .where(and(eq(intervals.serverId, serverId), isNull(intervals.stoppedAt)))
  return row ?? null
}

/**
 * Claims the session-cap warning of `minutes` left for the current session: true for the one
 * caller that should send it, false when it (or a later one) already went out.
 */
export async function claimSessionWarning(q: Queryable, serverId: string, minutes: number): Promise<boolean> {
  const claimed = await q
    .update(intervals)
    .set({ sessionWarnedMinutes: minutes })
    .where(
      and(
        eq(intervals.serverId, serverId),
        isNull(intervals.stoppedAt),
        or(isNull(intervals.sessionWarnedMinutes), gt(intervals.sessionWarnedMinutes, minutes)),
      ),
    )
    .returning({ id: intervals.id })
  return claimed.length > 0
}

/** A warning that couldn't be sent goes back to unsent, so the next check tries again. */
export async function releaseSessionWarning(
  q: Queryable,
  serverId: string,
  minutes: number,
  previous: number | null,
): Promise<void> {
  await q
    .update(intervals)
    .set({ sessionWarnedMinutes: previous })
    .where(
      and(
        eq(intervals.serverId, serverId),
        isNull(intervals.stoppedAt),
        eq(intervals.sessionWarnedMinutes, minutes),
      ),
    )
}

/** One join the edge saw through `domain` (§11: when an alias goes quiet, it can be dropped). */
export async function recordDomainJoin(q: Queryable, domain: string, at: Date): Promise<void> {
  await q
    .insert(schema.playDomainJoins)
    .values({ domain, joins: 1, lastJoinAt: at })
    .onConflictDoUpdate({
      target: schema.playDomainJoins.domain,
      set: {
        joins: sql`${schema.playDomainJoins.joins} + 1`,
        lastJoinAt: sql`greatest(${schema.playDomainJoins.lastJoinAt}, ${at})`,
      },
    })
}

/** Joins per play domain, as recorded. */
export async function domainJoins(q: Queryable): Promise<Map<string, { joins: number; lastJoinAt: Date }>> {
  const rows = await q.select().from(schema.playDomainJoins)
  return new Map(rows.map((r) => [r.domain, { joins: r.joins, lastJoinAt: r.lastJoinAt }]))
}

// ─── Who has played: kept, unlike presence ─────────────────────────────────────────────────

/**
 * Remembers players as people who have played on the server: when each was first seen, and from
 * then on their newest name and when they were last there. A reading that arrives late, as an
 * edge hint can, moves neither the name nor either time the wrong way. Only the server's own
 * reading renames anyone: a name a game merely `claimed` at the door names newcomers alone.
 */
async function rememberPlayers(
  q: Queryable,
  serverId: string,
  players: readonly PresentPlayer[],
  at: Date,
  source: 'server' | 'claimed',
): Promise<void> {
  // One row each: a statement can't update the same row twice.
  const each = [...new Map(players.map((p) => [p.uuid, p])).values()]
  if (each.length === 0) return
  await q
    .insert(played)
    .values(
      each.map((p) => ({
        serverId,
        playerUuid: p.uuid,
        playerName: p.name,
        firstSeenAt: at,
        lastSeenAt: at,
      })),
    )
    .onConflictDoUpdate({
      target: [played.serverId, played.playerUuid],
      set: {
        playerName:
          source === 'server'
            ? sql`case when excluded.last_seen_at >= ${played.lastSeenAt} then excluded.player_name else ${played.playerName} end`
            : sql`${played.playerName}`,
        firstSeenAt: sql`least(${played.firstSeenAt}, excluded.first_seen_at)`,
        lastSeenAt: sql`greatest(${played.lastSeenAt}, excluded.last_seen_at)`,
      },
    })
}

/** Someone who has played on a server, and whether they are on it now. */
export interface KnownPlayer extends PresentPlayer {
  online: boolean
}

/**
 * The people who have played on a server, for naming one without typing it: whoever is on now
 * first, then the most recently seen, each name once. One person can be there twice — under the
 * UUID their game told the edge and the one the server gave them, or under their account's and,
 * once the server stopped checking accounts, their name's — and a name offered twice helps nobody.
 */
export async function knownPlayers(q: Queryable, serverId: string, limit: number): Promise<KnownPlayer[]> {
  const online = sql<boolean>`${presence.playerUuid} is not null`
  const newest = q
    .selectDistinctOn([played.playerName], {
      uuid: played.playerUuid,
      name: played.playerName,
      online: online.as('online'),
      lastSeenAt: played.lastSeenAt,
    })
    .from(played)
    .leftJoin(
      presence,
      and(eq(presence.serverId, played.serverId), eq(presence.playerUuid, played.playerUuid)),
    )
    .where(eq(played.serverId, serverId))
    .orderBy(played.playerName, desc(online), desc(played.lastSeenAt))
    .as('newest')
  return q
    .select({ uuid: newest.uuid, name: newest.name, online: newest.online })
    .from(newest)
    .orderBy(desc(newest.online), desc(newest.lastSeenAt), asc(newest.name))
    .limit(limit)
}
