// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The monthly block: counted from the owner's midnight on the 1st, with what was left of last
 * month's, up to the plan's carry, carried into it once, and the policy and chip-ins holding play
 * to both.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { nextMonthStart } from '../../domain/account/play-day.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { chippedInLeft, meteredMonth } from '../billing/chip-in-meter.ts'
import { addMonths } from '../billing/years.ts'
import { loadStanding } from './persistence.ts'
import { carriedOut } from './play-month.ts'

const PLUS_HOURS = entitlementsFor('plus').includedUnits ?? 0
const PLUS_CARRY = entitlementsFor('plus').carryUnits ?? 0

describe('what carries into a month', () => {
  test('Plus carries up to 50 hours, so a month holds at most 170', () => {
    expect(PLUS_HOURS).toBe(120)
    expect(PLUS_CARRY).toBe(50)
    expect(PLUS_HOURS + carriedOut(PLUS_HOURS, PLUS_CARRY, [0])).toBe(170)
    // An admin's own block or carry stands in for the plan's; Free has no month to carry.
    expect(entitlementsFor('plus', { carryUnits: 120 }).carryUnits).toBe(120)
    expect(entitlementsFor('free').carryUnits).toBeNull()
  })

  test('what is left of a month’s own hours carries, up to the cap', () => {
    // 120 unused: 50 carry.
    expect(carriedOut(120, 50, [0])).toBe(50)
    // 30 unused: all 30 carry.
    expect(carriedOut(120, 50, [90])).toBe(30)
    expect(carriedOut(120, 50, [130])).toBe(0)
    expect(carriedOut(120, 50, [])).toBe(0)
    // A plan that carries nothing.
    expect(carriedOut(120, 0, [0])).toBe(0)
  })

  test('carried hours are spent first and never carry again', () => {
    // 50 carried in and 40 played: all of it from the carried, so the month's own 120 are whole.
    expect(carriedOut(120, 50, [0, 40])).toBe(50)
    // 50 carried in and 150 played: the carried 50 went first, so 20 of the month's own are left.
    expect(carriedOut(120, 50, [0, 150])).toBe(20)
    // 50 carried in and none of them played: still only 50 carry, the month's own.
    expect(carriedOut(120, 50, [0, 0])).toBe(50)
    expect(carriedOut(100, 100, [0, 150])).toBe(50)
  })

  test('a year of Plus never holds more than 170 in a month', () => {
    const year = [0, 0, 30, 170, 100, 0, 170, 60, 0, 200, 10, 0]
    const carried = year.map((_, i) => carriedOut(PLUS_HOURS, PLUS_CARRY, year.slice(0, i)))
    expect(carried).toEqual([0, 50, 50, 50, 0, 20, 50, 0, 50, 50, 0, 50])
    for (const into of carried) expect(PLUS_HOURS + into).toBeLessThanOrEqual(170)
  })
})

/** The owner's next three months from today, in `zone`: the first whole one the block covers. */
const months = (zone: string) => {
  const first = nextMonthStart(new Date(), zone)
  const second = nextMonthStart(first, zone)
  return [first, second, nextMonthStart(second, zone)] as const
}

describe.skipIf(!hasDatabase)('the play month', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  /** A Plus owner in `zone` with a stopped server: the account, and the server runs are written to. */
  const owner = async (name: string, zone: string) => {
    const actor = await h.user(name, 'plus')
    await h.app.accounts.setTimeZone(actor, zone)
    const server = await h.create(actor)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.servers.stop(actor, server.id, crypto.randomUUID(), 'user')
    await h.until(server.id, 'stopped')
    await h.settled(server.id)
    return { actor, serverId: server.id }
  }

  /** A run of `hours` on a 3 GB server, from `from`. */
  const ran = (serverId: string, from: Date, hours: number) =>
    h.db.insert(schema.powerIntervals).values({
      serverId,
      memoryTier: '3g',
      startedAt: from,
      stoppedAt: new Date(from.getTime() + hours * HOUR_MS),
    })

  const month = async (actor: UserActor, at: Date) => {
    const standing = await loadStanding(h.db, actor.userId, at)
    return meteredMonth(h.db, standing, entitlementsFor(standing.plan, standing.limitOverrides), at)
  }

  test('starts again at the owner’s midnight on the 1st, not UTC’s', async () => {
    const zone = 'Asia/Tokyo'
    const { actor, serverId } = await owner('Kai', zone)
    const [, second] = months(zone)
    // Two hours before Tokyo's midnight on the 1st and one after: that's 15:00 UTC the day before.
    expect(second.getUTCHours()).toBe(15)
    await ran(serverId, new Date(second.getTime() - 2 * HOUR_MS), 3)
    const after = await month(actor, new Date(second.getTime() + 2 * HOUR_MS))
    expect(after?.start).toEqual(second)
    expect(Math.round((after?.units ?? 0) * 100) / 100).toBe(1)
    // The two hours before midnight were last month's, and of the rest of its hours, 50 carried.
    expect(Math.round((after?.carried ?? 0) * 100) / 100).toBe(PLUS_CARRY)
  }, 40_000)

  test('a month with no play carries 50 of its hours into the next, and no further', async () => {
    const zone = 'America/Los_Angeles'
    const { actor, serverId } = await owner('Rio', zone)
    const [first, second, third] = months(zone)
    // The month the plan began in carries nothing: it wasn't Plus from its 1st.
    expect((await month(actor, new Date(first.getTime() + HOUR_MS)))?.carried).toBe(0)
    // Nothing played in the first whole month: 50 of it carry into the second.
    const into = await month(actor, new Date(second.getTime() + HOUR_MS))
    expect(into).toMatchObject({ included: PLUS_HOURS, carried: PLUS_CARRY, units: 0 })
    // Nothing played in the second either: only 50 of its own hours carry into the third.
    expect((await month(actor, new Date(third.getTime() + HOUR_MS)))?.carried).toBe(PLUS_CARRY)
    // Played into the carried hours and past them: what's left of the month's own carries.
    await ran(serverId, new Date(second.getTime() + HOUR_MS), PLUS_HOURS + 30)
    expect((await month(actor, new Date(third.getTime() + HOUR_MS)))?.carried).toBe(PLUS_CARRY - 30)
  }, 40_000)

  test('a start is refused only once the carried hours are played too', async () => {
    const zone = 'Europe/Paris'
    const { actor, serverId } = await owner('Noor', zone)
    const [, second] = months(zone)
    const at = new Date(second.getTime() + (PLUS_HOURS + PLUS_CARRY) * HOUR_MS + MINUTE_MS)
    const check = () =>
      h.db.transaction((tx) =>
        h.app.policy.check(
          tx,
          actor.userId,
          { kind: 'start_server', runs: { tier: '3g', loader: 'paper', modded: false } },
          at,
          { lock: false },
        ),
      )
    // A whole month's hours played this month, with 50 of last month's carried: there's room.
    await ran(serverId, second, PLUS_HOURS)
    expect(await check()).toMatchObject({ ok: true })
    // The carried hours played as well: the month is used up.
    await ran(serverId, new Date(second.getTime() + PLUS_HOURS * HOUR_MS), PLUS_CARRY)
    expect(await check()).toMatchObject({ ok: false, code: 'limit_reached' })
  }, 40_000)

  test('hours chipped in cover play from where the month’s and the 50 carried run out', async () => {
    const zone = 'Europe/Lisbon'
    const { actor, serverId } = await owner('Ivo', zone)
    const [, second] = months(zone)
    const friend = await h.user('Jo')
    // 20 hours chipped in to the server on the 1st of the second month.
    await h.db.insert(schema.chipIns).values({
      provider: 'polar',
      externalOrderId: crypto.randomUUID(),
      serverId,
      payerId: friend.userId,
      cents: 500,
      netCents: 500,
      milli: 20_000,
      receivedAt: second,
    })
    // The month's 120, the 50 carried, and 10 more played: those 10 are the chipped-in hours'.
    await ran(serverId, second, PLUS_HOURS + PLUS_CARRY + 10)
    const at = new Date(second.getTime() + (PLUS_HOURS + PLUS_CARRY + 11) * HOUR_MS)
    const played = await month(actor, at)
    expect(played?.carried).toBe(PLUS_CARRY)
    expect(Math.round((played?.units ?? 0) * 100) / 100).toBe(PLUS_HOURS + PLUS_CARRY)
    const left = await chippedInLeft(h.db, actor.userId, at)
    expect(Math.round((left.get(serverId) ?? 0) * 100) / 100).toBe(10)
  }, 40_000)
})

describe.skipIf(!hasDatabase)('the play month after Free', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const month = async (actor: UserActor, at: Date) => {
    const standing = await loadStanding(h.db, actor.userId, at)
    return meteredMonth(h.db, standing, entitlementsFor(standing.plan, standing.limitOverrides), at)
  }

  /** A Free account made months before `first`, in `zone`. */
  const longOnFree = async (name: string, zone: string, first: Date) => {
    const actor = await h.user(name)
    await h.app.accounts.setTimeZone(actor, zone)
    await h.db
      .update(schema.accountStanding)
      .set({ createdAt: addMonths(first, -6) })
      .where(eq(schema.accountStanding.userId, actor.userId))
    return actor
  }

  /** A month of Plus `actor` redeemed, from `from`. */
  const gift = async (actor: UserActor, from: Date) => {
    const buyer = await h.user('Buyer')
    await h.db.insert(schema.planGifts).values({
      provider: 'polar',
      externalOrderId: crypto.randomUUID(),
      buyerId: buyer.userId,
      planKey: 'plus',
      months: 1,
      redeemedBy: actor.userId,
      redeemedAt: from,
      startsAt: from,
      endsAt: addMonths(from, 1),
    })
    return addMonths(from, 1)
  }

  test('months on Free before a gift carry nothing into it', async () => {
    const zone = 'Europe/Berlin'
    const [first, second] = months(zone)
    const actor = await longOnFree('Ada', zone, first)
    await gift(actor, new Date(first.getTime() + 10 * DAY_MS))
    const into = await month(actor, new Date(second.getTime() + HOUR_MS))
    expect(into).toMatchObject({ included: PLUS_HOURS, carried: 0 })
  }, 40_000)

  test('months on Free after a subscription ended carry nothing into a gift', async () => {
    const zone = 'Europe/Berlin'
    const [first, second] = months(zone)
    const actor = await longOnFree('Bea', zone, first)
    await h.db.insert(schema.billingSubscriptions).values({
      userId: actor.userId,
      provider: 'polar',
      externalCustomerId: crypto.randomUUID(),
      externalSubscriptionId: crypto.randomUUID(),
      planKey: 'plus',
      status: 'canceled',
      currentPeriodEnd: addMonths(first, -3),
      canceledAt: addMonths(first, -4),
      createdAt: addMonths(first, -5),
    })
    await gift(actor, new Date(first.getTime() + 10 * DAY_MS))
    expect((await month(actor, new Date(second.getTime() + HOUR_MS)))?.carried).toBe(0)
  }, 40_000)

  test('a gift that runs on from another carries 50 of a whole month once', async () => {
    const zone = 'Europe/Berlin'
    const [first, second, third] = months(zone)
    const actor = await longOnFree('Cy', zone, first)
    const next = await gift(actor, new Date(first.getTime() + 10 * DAY_MS))
    await gift(actor, next)
    // The month the first gift began in wasn't Plus from its 1st: nothing carries out of it.
    expect((await month(actor, new Date(second.getTime() + HOUR_MS)))?.carried).toBe(0)
    // The second month was Plus throughout, gift to gift: 50 of its hours carry into the third.
    expect((await month(actor, new Date(third.getTime() + HOUR_MS)))?.carried).toBe(PLUS_CARRY)
  }, 40_000)
})
