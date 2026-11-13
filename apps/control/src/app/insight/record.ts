// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Funnel events, kept once in the transaction of what they describe (`insight_events`), and the
 * good moments an owner may be asked about (`insight_asks`). Writing here sends nothing: the
 * worker sends what is kept (`InsightService.drain`), so no request waits on the analytics
 * service, and "once" is the database's word, not the service's. Not for anything a person reads.
 */
import { isBedrockUuid } from '@blockly/contracts'
import { type Queryable, schema } from '@blockly/db'
import { and, asc, countDistinct, eq, gt, sql } from 'drizzle-orm'
import { listSaid } from '../joins/reached.ts'

/** The events the owner's PostHog dashboard counts. Their names are a contract with it. */
export const FUNNEL = {
  signedUp: 'signed_up',
  serverCreated: 'server_created',
  /** The owner copied the server's invite link (`sharing.inviteShared`). */
  inviteShared: 'invite_shared',
  /** Someone opened the invitation in a browser: a link preview runs no script, so never one. */
  inviteOpened: 'invite_opened',
  /** The owner copied the server's address (`sharing.addressCopied`). */
  addressCopied: 'address_copied',
  /** The server's first try to join that the edge took, by anyone: a join, not a server-list ping. */
  joinFirstTried: 'join_first_tried',
  /** A try to join that stopped before the world, once per server and reason (`joins.left_reason`). */
  joinStopped: 'join_stopped',
  serverFirstStarted: 'server_first_started',
  serverFirstJoin: 'server_first_join',
  firstFriendJoined: 'moment_first_friend_joined',
  firstWake: 'moment_first_wake',
  firstWeek: 'moment_first_week',
  planUpgraded: 'plan_upgraded',
  /** A join turned away while its server rested for its owner's play (`edge/turned-away.ts`). */
  joinTurnedAway: 'join_turned_away',
  /** A server stopped for its owner's play, the day's or the free trial's, with someone on it. */
  playEndedOnline: 'play_ended_online',
} as const

/** The moments worth a short question afterwards ("How's it going?"). */
type Moment = typeof FUNNEL.firstFriendJoined | typeof FUNNEL.firstWake | typeof FUNNEL.firstWeek

const events = schema.insightEvents
const servers = schema.minecraftServers

/**
 * Keeps an event once for its subject, unsent. True for the one call that kept it; every later
 * one, and one racing it, finds it there and keeps nothing.
 */
export async function noteOnce(
  q: Queryable,
  mark: {
    event: string
    subject: string
    userId: string
    properties?: Record<string, string | number | boolean>
    at?: Date
  },
): Promise<boolean> {
  const kept = await q
    .insert(events)
    .values({
      event: mark.event,
      subject: mark.subject,
      userId: mark.userId,
      properties: mark.properties ?? {},
      at: mark.at ?? new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: events.id })
  return kept.length > 0
}

/** A good moment: its event once for the account, and a question waiting to be asked about it. */
async function noteMoment(
  q: Queryable,
  userId: string,
  moment: Moment,
  detail: { serverName: string; player?: string },
  at: Date,
): Promise<boolean> {
  if (!(await noteOnce(q, { event: moment, subject: userId, userId, at }))) return false
  await q.insert(schema.insightAsks).values({ userId, moment, detail, at }).onConflictDoNothing()
  return true
}

const kept = async (q: Queryable, event: string, subject: string) =>
  (
    await q
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.event, event), eq(events.subject, subject)))
  ).length > 0

/**
 * A server began running (its power interval opened): its first start ever, and, when a
 * connection woke it, the account's first wake.
 */
export async function serverRan(q: Queryable, serverId: string, woken: boolean, at: Date): Promise<void> {
  const [server] = await q
    .select({ ownerId: servers.ownerId, name: servers.name })
    .from(servers)
    .where(eq(servers.id, serverId))
  if (server === undefined) return
  await noteOnce(q, { event: FUNNEL.serverFirstStarted, subject: serverId, userId: server.ownerId, at })
  if (woken) await noteMoment(q, server.ownerId, FUNNEL.firstWake, { serverName: server.name }, at)
}

/**
 * Who is on one of the account's servers, as the server itself says: the server's first join, by
 * anyone, is kept once for it. Nothing links an account
 * to a Minecraft player, so the first name ever seen on any of its servers counts as the owner's,
 * and the second, a friend. A second week of play is two calendar
 * weeks (Monday to Sunday, UTC) with any minute of play on any of its servers.
 * Each check stops at the account's mark once it is there.
 */
export async function playersSeen(
  q: Queryable,
  serverId: string,
  present: readonly string[],
  at: Date,
): Promise<void> {
  const [server] = await q
    .select({ ownerId: servers.ownerId, name: servers.name })
    .from(servers)
    .where(eq(servers.id, serverId))
  if (server === undefined) return
  const owner = server.ownerId
  // Anyone on it at all, the owner included: the server was played on, once.
  await noteOnce(q, { event: FUNNEL.serverFirstJoin, subject: serverId, userId: owner, at })
  if (!(await kept(q, FUNNEL.firstFriendJoined, owner))) {
    const [earliest] = await q
      .select({ name: schema.serverPlayers.playerName })
      .from(schema.serverPlayers)
      .innerJoin(servers, eq(servers.id, schema.serverPlayers.serverId))
      .where(eq(servers.ownerId, owner))
      .orderBy(asc(schema.serverPlayers.firstSeenAt))
      .limit(1)
    // Someone the server says is on: a name the edge only heard at the door may have been turned away.
    const friend = present.find((name) => name.toLowerCase() !== earliest?.name.toLowerCase())
    if (friend !== undefined)
      await noteMoment(q, owner, FUNNEL.firstFriendJoined, { serverName: server.name, player: friend }, at)
  }
  if (!(await kept(q, FUNNEL.firstWeek, owner))) {
    const usage = schema.serverUsageDays
    const [weeks] = await q
      .select({ n: countDistinct(sql`date_trunc('week', ${usage.day}::date)`) })
      .from(usage)
      .innerJoin(servers, eq(servers.id, usage.serverId))
      .where(and(eq(servers.ownerId, owner), gt(usage.activeMinutes, 0)))
    if ((weeks?.n ?? 0) >= 2) await noteMoment(q, owner, FUNNEL.firstWeek, { serverName: server.name }, at)
  }
}

/**
 * A server stopped because its owner's free trial's hours ran out, with `online` players still on
 * it: kept once for the stop it was (`key`).
 */
export async function playEnded(
  q: Queryable,
  server: { id: string; ownerId: string },
  reason: 'free_hours',
  key: string,
  online: number,
): Promise<void> {
  await noteOnce(q, {
    event: FUNNEL.playEndedOnline,
    subject: `${server.id}:${key}`,
    userId: server.ownerId,
    properties: { serverId: server.id, reason, online },
  })
}

/** Where a try to join stopped before the world for good: the edge turned it away, or the player left the wait. */
const stoppedFor = (reason: string | null): reason is string =>
  reason !== null && (reason.startsWith('refused:') || reason === 'gave_up_waiting')

/**
 * The edge told of a try to join (`joins/visits.ts`): the server's first is kept once, and so is
 * its first stop for each reason, each with the game it came from. A player Floodgate made is a
 * Bedrock one; one turned away before it named itself is `unknown`.
 */
export async function joinTried(q: Queryable, joinId: string): Promise<void> {
  const [join] = await q
    .select({
      serverId: schema.joins.serverId,
      kind: schema.joins.kind,
      playerUuid: schema.joins.playerUuid,
      leftReason: schema.joins.leftReason,
      inWorldAt: schema.joins.inWorldAt,
      detail: schema.joins.detail,
      at: schema.joins.connectedAt,
      ownerId: servers.ownerId,
    })
    .from(schema.joins)
    .innerJoin(servers, eq(servers.id, schema.joins.serverId))
    .where(eq(schema.joins.id, joinId))
  if (join?.serverId == null || join.kind !== 'join') return
  const edition = join.playerUuid === null ? 'unknown' : isBedrockUuid(join.playerUuid) ? 'bedrock' : 'java'
  const properties = { serverId: join.serverId, edition }
  const mark = { userId: join.ownerId, at: join.at }
  await noteOnce(q, { ...mark, event: FUNNEL.joinFirstTried, subject: join.serverId, properties })
  // In the world by its reporter's word, or its server's player list's (`joins/reached.ts`).
  const gotIn = join.inWorldAt !== null || listSaid(join.detail).listedAt !== null
  if (gotIn || !stoppedFor(join.leftReason)) return
  await noteOnce(q, {
    ...mark,
    event: FUNNEL.joinStopped,
    subject: `${join.serverId}:${join.leftReason}`,
    properties: { ...properties, reason: join.leftReason },
  })
}
