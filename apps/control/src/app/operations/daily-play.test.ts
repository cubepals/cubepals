// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Free is 2 hours of play every day, from the owner's midnight, with no monthly total. A run that
 * gets to the end of the day's play is warned in game at 10 and 2 minutes, then goes to sleep;
 * starting or joining it is refused until midnight, with when that is. Against the fake runtime
 * with its sleeps on, as FLY_SUSPEND switches Fly's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { playToday } from '../accounts/play-today.ts'
import { applyTimeZones } from '../accounts/time-zone.ts'
import type { UserActor } from '../actor.ts'

const TEN = '[Cubepals] Today’s play ends in 10 minutes. The world is saved, and play is back at midnight.'
const TWO = '[Cubepals] Today’s play ends in 2 minutes. The world is saved, and play is back at midnight.'
const REFUSED = /^You’ve played today’s 2 hours\. Back at midnight, in \d+ h( \d+ min)?\.$/

/**
 * A time zone where it is about noon now, so a run of a few hours in the past stays inside the
 * owner's today whenever the test runs. `Etc/GMT-5` is five hours ahead of UTC.
 */
function noonZone(): string {
  const ahead = 12 - new Date().getUTCHours()
  return ahead >= 0 ? `Etc/GMT-${ahead}` : `Etc/GMT+${-ahead}`
}

let h: Harness

/** A harness of its own for each part, its sleeps on. */
function harness(): void {
  beforeAll(async () => {
    h = await startHarness()
    h.runtime.sleeps.on = true
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })
}

const owner = async (timeZone: string | null = noonZone(), plan = 'free') => {
  const actor = await h.user('Steve', plan)
  await h.db
    .update(schema.accountStanding)
    .set({ timeZone })
    .where(eq(schema.accountStanding.userId, actor.userId))
  return actor
}
const running = async (actor: UserActor) => {
  const server = await h.create(actor)
  await h.until(server.id, 'running')
  await h.settled(server.id)
  return server
}
const open = isNull(schema.powerIntervals.stoppedAt)
/** Puts the server's current run that many minutes in the past, as if it had run that long. */
const ranFor = (id: string, minutes: number) =>
  h.db
    .update(schema.powerIntervals)
    .set({ startedAt: new Date(Date.now() - minutes * MINUTE_MS) })
    .where(and(eq(schema.powerIntervals.serverId, id), open))
const session = async (id: string) => {
  const [row] = await h.db
    .select()
    .from(schema.powerIntervals)
    .where(and(eq(schema.powerIntervals.serverId, id), open))
  return row
}
const today = async (actor: UserActor, now: Date) => {
  const standing = await loadStanding(h.db, actor.userId)
  return playToday(h.db, standing, entitlementsFor(standing.plan), now)
}

describe.skipIf(!hasDatabase)('the play day', () => {
  harness()

  test('is counted from the owner’s midnight, UTC until their browser says, a large size double', async () => {
    const actor = await owner(null)
    const server = await running(actor)
    const interval = (from: string, to: string, memoryTier = '3g') =>
      h.db
        .insert(schema.powerIntervals)
        .values({ serverId: server.id, startedAt: new Date(from), stoppedAt: new Date(to), memoryTier })
    // Across UTC midnight: only the hour after it is today's in UTC.
    await interval('2026-01-14T23:00:00Z', '2026-01-15T01:00:00Z')
    // Across New York's midnight, 05:00 UTC: an hour of it on each of New York's days.
    await interval('2026-01-15T04:00:00Z', '2026-01-15T06:00:00Z')
    const now = new Date('2026-01-15T12:00:00Z')

    expect(await today(actor, now)).toEqual({
      included: 2,
      units: 3,
      left: 0,
      backAt: new Date('2026-01-16T00:00:00Z'),
    })
    // Reported once the account has played, the zone waits for the next month, then takes over.
    await h.app.accounts.setTimeZone(actor, 'America/New_York')
    expect((await today(actor, now))?.units).toBe(3)
    const waiting = await loadStanding(h.db, actor.userId)
    expect(waiting).toMatchObject({ timeZone: null, nextTimeZone: 'America/New_York' })
    expect(await applyTimeZones(h.db, waiting.nextTimeZoneFrom ?? now)).toBe(1)
    expect(await today(actor, now)).toEqual({
      included: 2,
      units: 1,
      left: 1,
      backAt: new Date('2026-01-16T05:00:00Z'),
    })
    // A large server spends two of the day's hours an hour, as it does a month's.
    await interval('2026-01-15T10:00:00Z', '2026-01-15T10:15:00Z', '8g')
    expect((await today(actor, now))?.units).toBe(1.5)
    // Plus counts no day.
    expect(
      await playToday(h.db, await loadStanding(h.db, actor.userId), entitlementsFor('plus'), now),
    ).toBeNull()
  }, 30_000)

  test('the time zone is the browser’s, and one Cubepals doesn’t know leaves it as it was', async () => {
    const actor = await owner(null)
    expect((await h.app.accountQueries.me(actor)).timeZone).toBeNull()
    await h.app.accounts.setTimeZone(actor, 'Mars/Olympus')
    expect((await loadStanding(h.db, actor.userId)).timeZone).toBeNull()
    await h.app.accounts.setTimeZone(actor, 'Europe/Paris')
    expect((await h.app.accountQueries.me(actor)).timeZone).toBe('Europe/Paris')
  }, 30_000)
})

describe.skipIf(!hasDatabase)('the end of the day’s play', () => {
  harness()

  test('a run is warned at 10 and 2 minutes, then sleeps; play is refused until midnight, then back', async () => {
    const actor = await owner()
    const server = await running(actor)
    const id = server.id

    // Twenty minutes of today's play left: nothing to say yet, and the page says what is left.
    await ranFor(id, 100)
    expect(await h.app.schedules.sessionCheck()).toBe(0)
    expect(h.minecraft.said(id)).toEqual([])
    expect((await h.app.queries.get(actor, id)).playToday?.hoursLeft).toBeCloseTo(20 / 60, 1)

    // Nine left: the ten-minute warning, said once, and the end fixed ten minutes on.
    await ranFor(id, 111)
    await h.app.schedules.sessionCheck()
    await h.app.schedules.sessionCheck()
    expect(h.minecraft.said(id)).toEqual([TEN])
    const ends = (await session(id))?.playEndsAt
    expect(ends?.getTime()).toBeGreaterThan(Date.now() + 9 * MINUTE_MS)

    // Two minutes before that end, the second warning.
    await h.app.schedules.sessionCheck(new Date(Date.now() + 8.5 * MINUTE_MS))
    expect(h.minecraft.said(id)).toEqual([TEN, TWO])

    // At the end it goes to sleep the ordinary way, its world saved, its memory kept.
    await ranFor(id, 125)
    expect(await h.app.schedules.sessionCheck(new Date(Date.now() + 11 * MINUTE_MS))).toBe(1)
    const stopped = await h.until(id, 'stopped')
    expect(stopped.lifecycle.stopReason).toBe('daily')
    expect(h.runtime.machine(id)?.state).toBe('suspended')
    const stop = (await h.settled(id)).filter((op) => op.kind === 'stop').at(-1)
    expect(stop).toMatchObject({ requestedBy: 'system:play_today', status: 'succeeded' })

    // Out for today: the page says when play is back, and a start or a join is refused saying so.
    const view = await h.app.queries.get(actor, id)
    expect(view.playToday?.hoursLeft).toBe(0)
    expect(Date.parse(view.playToday?.backAt ?? '')).toBeGreaterThan(Date.now())
    await expect(h.app.servers.start(actor, id, crypto.randomUUID())).rejects.toMatchObject({
      code: 'limit_reached',
      message: expect.stringMatching(REFUSED),
    })
    const woken = await h.app.edge.wake(`${server.slug}.play.test`)
    expect(woken).toEqual({ outcome: 'denied', reason: 'quota', backAt: view.playToday?.backAt })
    // And the server list hears it from the route.
    const route = (await h.app.edge.routes()).routes.find((r) => r.hostname === `${server.slug}.play.test`)
    expect(route).toMatchObject({ state: 'asleep', backAt: view.playToday?.backAt })

    // A new day: the play is back, the route says it sleeps like any, and a join wakes it.
    await h.db
      .update(schema.powerIntervals)
      .set({
        startedAt: sql`${schema.powerIntervals.startedAt} - interval '1 day'`,
        stoppedAt: sql`${schema.powerIntervals.stoppedAt} - interval '1 day'`,
      })
      .where(eq(schema.powerIntervals.serverId, id))
    const back = (await h.app.edge.routes()).routes.find((r) => r.hostname === `${server.slug}.play.test`)
    expect(back?.backAt).toBeUndefined()
    expect((await h.app.queries.get(actor, id)).playToday?.hoursLeft).toBe(2)
    await h.app.servers.start(actor, id, crypto.randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect((await session(id))?.playEndsAt).toBeNull()
  }, 60_000)
})

describe.skipIf(!hasDatabase)('a run near the end of the day’s play', () => {
  harness()

  test('a run already past today’s play when it starts being counted is warned, never cut off', async () => {
    // A run going when the day's block is already used, as after a plan changes how it counts.
    const actor = await owner()
    const { id } = await running(actor)
    await ranFor(id, 300)
    expect(await h.app.schedules.sessionCheck()).toBe(0)
    expect(h.minecraft.said(id)).toEqual([TEN])
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await h.app.schedules.sessionCheck(new Date(Date.now() + 9 * MINUTE_MS))).toBe(0)
    expect(h.minecraft.said(id)).toEqual([TEN, TWO])
    expect(await h.app.schedules.sessionCheck(new Date(Date.now() + 10.5 * MINUTE_MS))).toBe(1)
    expect((await h.until(id, 'stopped')).lifecycle.stopReason).toBe('daily')
  }, 60_000)

  test('a run that reaches midnight with play left goes on into the next day’s', async () => {
    // Midnight comes in five minutes, with an hour of today's play still to use: no warning, since
    // the new day's two hours follow straight on.
    const actor = await owner('UTC')
    const { id } = await running(actor)
    await ranFor(id, 60)
    const nearMidnight = new Date(Math.ceil(Date.now() / DAY_MS) * DAY_MS - 5 * MINUTE_MS)
    // Seen from five minutes before midnight, the run started an hour before that.
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(nearMidnight.getTime() - HOUR_MS) })
      .where(and(eq(schema.powerIntervals.serverId, id), open))
    expect(await h.app.schedules.sessionCheck(nearMidnight)).toBe(0)
    expect(h.minecraft.said(id)).toEqual([])
    expect((await session(id))?.playEndsAt).toBeNull()
  }, 30_000)
})
