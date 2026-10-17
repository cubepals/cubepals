// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A friend who reaches a server resting for its owner's play: what the edge is told, what the
 * owner sees afterwards, and what is counted. The edge lets the join in to wait and says so (a
 * connect), then asks for a wake, which is refused; this drives both as the edge does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, isNull, like, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { FUNNEL } from '../insight/record.ts'

const OWNER = { name: 'Steve', uuid: '0f2c5d3a-9b6e-4f10-a1b2-c3d4e5f60718' }
const FRIEND = { name: 'Alex', uuid: '5f2c5d3a-9b6e-4f10-a1b2-c3d4e5f60718' }

let h: Harness

beforeAll(async () => {
  if (hasDatabase) {
    h = await startHarness()
    h.runtime.sleeps.on = true
  }
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await h.close()
})

/** A time zone where it is about noon now, so today's play stays today's whenever this runs. */
function noonZone(): string {
  const ahead = 12 - new Date().getUTCHours()
  return ahead >= 0 ? `Etc/GMT-${ahead}` : `Etc/GMT+${-ahead}`
}

const open = isNull(schema.powerIntervals.stoppedAt)

const running = async (actor: UserActor) => {
  const server = await h.create(actor, { name: 'Sunset Valley' })
  await h.until(server.id, 'running')
  await h.settled(server.id)
  return server
}

/** What the edge reports as `player` reaches the server's address. */
const reach = (slug: string, player: { name: string; uuid: string }, event: 'connect' | 'disconnect') =>
  h.app.edge.recordSession({
    edgeId: 'e1',
    hostname: `${slug}.play.test`,
    event,
    player,
    at: new Date().toISOString(),
  })

const turnedAwayEvents = (serverId: string) =>
  h.db
    .select()
    .from(schema.insightEvents)
    .where(
      and(
        eq(schema.insightEvents.event, FUNNEL.joinTurnedAway),
        like(schema.insightEvents.subject, `${serverId}:%`),
      ),
    )

const routeOf = async (slug: string) =>
  (await h.app.edge.routes()).routes.find((r) => r.hostname === `${slug}.play.test`)

describe.skipIf(!hasDatabase)('a friend at a server resting for today', () => {
  test('after today’s play: refused saying when it is back, kept for the owner, and counted', async () => {
    const actor = await h.user('Steve', 'free')
    await h.db
      .update(schema.accountStanding)
      .set({ timeZone: noonZone() })
      .where(eq(schema.accountStanding.userId, actor.userId))
    const server = await running(actor)
    const { id, slug } = server

    // The owner plays, as the server itself sees it, until today's play is used up with them on.
    await reach(slug, OWNER, 'connect')
    await h.db
      .update(schema.serverPlayers)
      .set({ playedSeconds: 110 * 60, confirmedAt: new Date() })
      .where(eq(schema.serverPlayers.serverId, id))
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(Date.now() - 125 * MINUTE_MS) })
      .where(and(eq(schema.powerIntervals.serverId, id), open))
    await h.app.schedules.sessionCheck()
    expect(await h.app.schedules.sessionCheck(new Date(Date.now() + 11 * MINUTE_MS))).toBe(1)
    expect((await h.until(id, 'stopped')).lifecycle.stopReason).toBe('daily')
    await h.settled(id)

    // The stop with someone on is counted, once.
    const ended = await h.db
      .select()
      .from(schema.insightEvents)
      .where(
        and(
          eq(schema.insightEvents.event, FUNNEL.playEndedOnline),
          like(schema.insightEvents.subject, `${id}:%`),
        ),
      )
    expect(ended.map((e) => e.properties)).toEqual([{ serverId: id, reason: 'daily', online: 1 }])

    // The route tells the edge it rests until the owner's next day, and its name.
    const view = await h.app.queries.get(actor, id)
    const backAt = view.playToday?.backAt
    expect(await routeOf(slug)).toMatchObject({ state: 'asleep', backAt, name: 'Sunset Valley' })
    expect(view.cameBy).toEqual([])

    // A friend arrives: let in to wait, then refused, with when it is back. Nothing starts.
    await reach(slug, FRIEND, 'connect')
    expect(await h.app.edge.wake(`${slug}.play.test`)).toEqual({ outcome: 'denied', reason: 'quota', backAt })
    await reach(slug, FRIEND, 'disconnect')
    expect((await h.server(id)).lifecycle.status).toBe('stopped')

    // The owner sees who came by, and the try is counted with why.
    const seen = await h.app.queries.get(actor, id)
    expect(seen.cameBy.map((p) => p.name)).toEqual(['Alex'])
    expect((await h.app.queries.list(actor)).find((s) => s.id === id)?.cameBy.map((p) => p.name)).toEqual([
      'Alex',
    ])
    expect((await turnedAwayEvents(id)).map((e) => e.properties)).toEqual([
      { serverId: id, reason: 'daily', player: 'Alex', friend: true },
    ])

    // The owner trying their own server is counted, but isn't news to them.
    await reach(slug, OWNER, 'connect')
    expect((await h.app.queries.get(actor, id)).cameBy.map((p) => p.name)).toEqual(['Alex'])
    expect((await turnedAwayEvents(id)).map((e) => e.properties.friend).sort()).toEqual([false, true])

    // A new day: it wakes for a join like any server, and the note is gone once it has run.
    await h.db
      .update(schema.powerIntervals)
      .set({
        startedAt: sql`${schema.powerIntervals.startedAt} - interval '1 day'`,
        stoppedAt: sql`${schema.powerIntervals.stoppedAt} - interval '1 day'`,
      })
      .where(eq(schema.powerIntervals.serverId, id))
    expect((await routeOf(slug))?.backAt).toBeUndefined()
    expect((await routeOf(slug))?.name).toBeUndefined()
    await reach(slug, FRIEND, 'connect')
    expect((await turnedAwayEvents(id)).length).toBe(2)
    expect(await h.app.edge.wake(`${slug}.play.test`)).toMatchObject({ outcome: 'ready' })
    await h.settled(id)
    expect((await h.app.queries.get(actor, id)).cameBy).toEqual([])
  }, 60_000)
})

describe.skipIf(!hasDatabase)('a friend at a server out of free hours', () => {
  test('after the free trial: the route says so, a friend is refused and kept, Plus wakes it', async () => {
    const actor = await h.user('Lee', 'free')
    const server = await running(actor)
    const { id, slug } = server
    // 19 hours played on other days, and this run 55 minutes long: five minutes left.
    const stoppedAt = new Date(Date.now() - 2 * DAY_MS)
    await h.db.insert(schema.powerIntervals).values({
      serverId: id,
      memoryTier: '3g',
      plan: 'free',
      startedAt: new Date(stoppedAt.getTime() - 19 * HOUR_MS),
      stoppedAt,
    })
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(Date.now() - 2 * HOUR_MS) })
      .where(and(eq(schema.powerIntervals.serverId, id), open))
    await h.app.schedules.sessionCheck()
    expect(await h.app.schedules.sessionCheck(new Date(Date.now() + 11 * MINUTE_MS))).toBe(1)
    expect((await h.until(id, 'stopped')).lifecycle.stopReason).toBe('free_hours')
    await h.settled(id)

    // Nobody was on, so the stop isn't counted as one that ended someone's play.
    const ended = await h.db
      .select()
      .from(schema.insightEvents)
      .where(
        and(
          eq(schema.insightEvents.event, FUNNEL.playEndedOnline),
          like(schema.insightEvents.subject, `${id}:%`),
        ),
      )
    expect(ended).toEqual([])

    expect(await routeOf(slug)).toMatchObject({ state: 'asleep', trialOver: true, name: 'Sunset Valley' })
    await reach(slug, FRIEND, 'connect')
    expect(await h.app.edge.wake(`${slug}.play.test`)).toEqual({ outcome: 'denied', reason: 'quota' })
    expect((await h.app.queries.get(actor, id)).cameBy.map((p) => p.name)).toEqual(['Alex'])
    expect((await turnedAwayEvents(id)).map((e) => e.properties)).toEqual([
      { serverId: id, reason: 'free_hours', player: 'Alex', friend: true },
    ])

    // On Plus it is a sleeping server like any other: the next join wakes it.
    await h.db
      .update(schema.accountStanding)
      .set({ plan: 'plus' })
      .where(eq(schema.accountStanding.userId, actor.userId))
    expect((await routeOf(slug))?.trialOver).toBeUndefined()
  }, 60_000)
})

describe.skipIf(!hasDatabase)('a friend at a sleeping server', () => {
  test('a join to a server asleep for any other reason is no news: it wakes it', async () => {
    const actor = await h.user('Kai', 'free')
    const server = await running(actor)
    await h.app.servers.stop(actor, server.id, crypto.randomUUID(), 'idle')
    await h.until(server.id, 'stopped')
    await h.settled(server.id)
    await reach(server.slug, FRIEND, 'connect')
    expect(await turnedAwayEvents(server.id)).toEqual([])
    expect((await routeOf(server.slug))?.name).toBeUndefined()
  }, 60_000)
})
