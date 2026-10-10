// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Funnel events, kept once in the transaction of what they describe (`insight_events`), and the
 * good moments an owner may be asked about (`insight_asks`). Writing here sends nothing: the
 * worker sends what is kept (`InsightService.drain`), so no request waits on the analytics
 * service, and "once" is the database's word, not the service's. Not for anything a person reads.
 */
import { type Queryable, schema } from '@blockly/db'
import { and, asc, countDistinct, eq, gt, sql } from 'drizzle-orm'

/** The events the owner's PostHog dashboard counts. Their names are a contract with it. */
export const FUNNEL = {
  signedUp: 'signed_up',
  serverCreated: 'server_created',
  serverFirstStarted: 'server_first_started',
  firstFriendJoined: 'moment_first_friend_joined',
  firstWake: 'moment_first_wake',
  firstWeek: 'moment_first_week',
  planUpgraded: 'plan_upgraded',
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
 * Who is on one of the account's servers, as the server itself says. Nothing links an account
 * to a Minecraft player, so the first name ever seen on any of its servers counts as the owner's,
 * and the second, a friend, as docs/metrics.md counts them. A second week of play is two calendar
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
