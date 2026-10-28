// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A friend who reaches a server resting for its owner's free trial: what the edge is told, what
 * the owner sees afterwards, and what is counted. The edge lets the join in to wait and says so (a
 * connect), then asks for a wake, which is refused; this drives both as the edge does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, isNull, like } from 'drizzle-orm'
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

const open = isNull(schema.powerIntervals.stoppedAt)

/** A finished run on Free, `hours` long, two days back. */
const playedBefore = (serverId: string, hours: number) => {
  const stoppedAt = new Date(Date.now() - 2 * DAY_MS)
  return h.db.insert(schema.powerIntervals).values({
    serverId,
    memoryTier: '3g',
    plan: 'free',
    startedAt: new Date(stoppedAt.getTime() - hours * HOUR_MS),
    stoppedAt,
  })
}

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

describe.skipIf(!hasDatabase)('a friend at a server resting for the free trial', () => {
  test('after the 20 hours, with the owner on: counted, refused, kept for the owner, and a paid plan wakes it', async () => {
    const actor = await h.user('Steve', 'free')
    const server = await running(actor)
    const { id, slug } = server

    // The owner plays, as the server itself sees it, until the 20 hours are used up with them on:
    // 19 hours on another day, and this run over an hour long.
    await reach(slug, OWNER, 'connect')
    await h.db
      .update(schema.serverPlayers)
      .set({ playedSeconds: 110 * 60, confirmedAt: new Date() })
      .where(eq(schema.serverPlayers.serverId, id))
    await playedBefore(id, 19)
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(Date.now() - 65 * MINUTE_MS) })
      .where(and(eq(schema.powerIntervals.serverId, id), open))
    await h.app.schedules.sessionCheck()
    expect(await h.app.schedules.sessionCheck(new Date(Date.now() + 11 * MINUTE_MS))).toBe(1)
    expect((await h.until(id, 'stopped')).lifecycle.stopReason).toBe('free_hours')
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
    expect(ended.map((e) => e.properties)).toEqual([{ serverId: id, reason: 'free_hours', online: 1 }])

    // The route tells the edge it rests until the plan changes, and its name.
    expect(await routeOf(slug)).toMatchObject({ state: 'asleep', trialOver: true, name: 'Sunset Valley' })
    expect((await h.app.queries.get(actor, id)).cameBy).toEqual([])

    // A friend arrives: let in to wait, then refused. Nothing starts.
    await reach(slug, FRIEND, 'connect')
    expect(await h.app.edge.wake(`${slug}.play.test`)).toEqual({ outcome: 'denied', reason: 'quota' })
    await reach(slug, FRIEND, 'disconnect')
    expect((await h.server(id)).lifecycle.status).toBe('stopped')

    // The owner sees who came by, and the try is counted with why.
    const seen = await h.app.queries.get(actor, id)
    expect(seen.cameBy.map((p) => p.name)).toEqual(['Alex'])
    expect((await h.app.queries.list(actor)).find((s) => s.id === id)?.cameBy.map((p) => p.name)).toEqual([
      'Alex',
    ])
    expect((await turnedAwayEvents(id)).map((e) => e.properties)).toEqual([
      { serverId: id, reason: 'free_hours', player: 'Alex', friend: true },
    ])

    // The owner trying their own server is counted, but isn't news to them.
    await reach(slug, OWNER, 'connect')
    expect((await h.app.queries.get(actor, id)).cameBy.map((p) => p.name)).toEqual(['Alex'])
    expect((await turnedAwayEvents(id)).map((e) => e.properties.friend).sort()).toEqual([false, true])

    // On a paid plan it wakes for a join like any server, and the note is gone once it has run.
    await h.db
      .update(schema.accountStanding)
      .set({ plan: 'plus' })
      .where(eq(schema.accountStanding.userId, actor.userId))
    expect((await routeOf(slug))?.trialOver).toBeUndefined()
    expect((await routeOf(slug))?.name).toBeUndefined()
    await reach(slug, FRIEND, 'connect')
    expect((await turnedAwayEvents(id)).length).toBe(2)
    expect(await h.app.edge.wake(`${slug}.play.test`)).toMatchObject({ outcome: 'ready' })
    await h.settled(id)
    expect((await h.app.queries.get(actor, id)).cameBy).toEqual([])
  }, 60_000)
})

describe.skipIf(!hasDatabase)(
  'a server stopped for a day’s play before the trial stopped counting days',
  () => {
    test('sleeps like any other: its route says nothing of it, and a join wakes it', async () => {
      const actor = await h.user('Mia', 'free')
      const server = await running(actor)
      await h.app.servers.stop(actor, server.id, crypto.randomUUID(), 'idle')
      await h.until(server.id, 'stopped')
      await h.settled(server.id)
      await h.db
        .update(schema.minecraftServers)
        .set({ stopReason: 'daily' })
        .where(eq(schema.minecraftServers.id, server.id))
      const route = await routeOf(server.slug)
      expect(route).toMatchObject({ state: 'asleep' })
      expect(route?.trialOver).toBeUndefined()
      expect(route?.name).toBeUndefined()
      await reach(server.slug, FRIEND, 'connect')
      expect(await turnedAwayEvents(server.id)).toEqual([])
      expect(await h.app.edge.wake(`${server.slug}.play.test`)).toMatchObject({ outcome: 'ready' })
      await h.settled(server.id)
    }, 60_000)
  },
)

describe.skipIf(!hasDatabase)('a friend at a server out of free hours', () => {
  test('after the free trial: the route says so, a friend is refused and kept, Plus wakes it', async () => {
    const actor = await h.user('Lee', 'free')
    const server = await running(actor)
    const { id, slug } = server
    // 19 hours played on another day, and this run two hours long: played out.
    await playedBefore(id, 19)
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
