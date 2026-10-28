// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the pricing page is told a month of each plan charges now: the early price only while the
 * room takes that checkout and two more, the plan's own otherwise, and from the public endpoint
 * nothing but the price and hours.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { createPublicApp } from '../../interfaces/http/public.ts'
import { hasDatabase } from '../../testing/harness.ts'
import { earlyProduct } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import { EarlyRoomControl } from './early-room.ts'

const EARLY_CORE = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c01'

describe.skipIf(!hasDatabase)('the price a new subscriber is told', () => {
  const w = new PolarWorld()
  let room: EarlyRoomControl

  beforeAll(async () => {
    await w.start()
    room = new EarlyRoomControl({ db: w.h.db, maxPoints: 100_000 })
  }, 30_000)
  afterAll(() => w.close())
  beforeEach(async () => {
    w.reset()
    w.early.splice(0, w.early.length, earlyProduct(EARLY_CORE, { plan: 'core', included_units: 90 }, 700))
    await w.h.db.delete(schema.earlyHolds)
  })

  const open = (checkouts: number) =>
    room.set({
      roomPoints: checkouts * 100,
      points: { core: 100, plus: 300 },
      validUntil: new Date(Date.now() + 30 * MINUTE_MS),
    })
  const core = async () => (await w.h.app.billing.liveOffers()).find((offer) => offer.plan === 'core')

  test('is the plan’s own until the room takes three checkouts of it, then the early price', async () => {
    await open(2)
    expect(await core()).toEqual({ plan: 'core', priceCents: 999, includedHours: 40 })
    await open(3)
    expect(await core()).toEqual({ plan: 'core', priceCents: 700, includedHours: 90 })
    // Holds take from the room the page reads too.
    await w.h.app.billing.offer(await w.h.user('Holds'), 'core')
    expect((await core())?.priceCents).toBe(999)
  })

  test('the public endpoint says the price and hours, kept a minute, and nothing else', async () => {
    await open(10)
    const app = createPublicApp({
      sharing: {} as never,
      faces: {} as never,
      items: {} as never,
      icons: {} as never,
      platform: () => ({ unsoldPlans: [] }),
      addresses: { proxySecret: null, hostHeader: null },
      offers: () => w.h.app.billing.liveOffers(),
    })
    const answer = await app.request('/api/public/offer')
    expect(answer.headers.get('cache-control')).toBe('public, max-age=60')
    const offers = (await answer.json()) as Record<string, unknown>[]
    expect(offers.map((offer) => Object.keys(offer).sort())).toEqual(
      offers.map(() => ['includedHours', 'plan', 'priceCents']),
    )
    expect(offers).toContainEqual({ plan: 'core', priceCents: 700, includedHours: 90 })
  })
})
