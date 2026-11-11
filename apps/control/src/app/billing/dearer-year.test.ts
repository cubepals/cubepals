// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A year of a plan is sold only while it costs no more than twelve months at what a new
 * subscriber is offered now: the plans the pricing page reads leave it out, a checkout for it is
 * refused, it comes back once the month costs more again, and a year already held still renews.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { TERMS_VERSION, withOffers, yearSold } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { hasDatabase } from '../../testing/harness.ts'
import { earlyProduct } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import { publicPlans } from '../accounts/queries.ts'
import { EarlyRoomControl } from './early-room.ts'
import { shownOffersOf } from './shown-offers.ts'

const EARLY_PLUS = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c02'
/** A made-up early price, low enough that twelve months of it cost less than the year. */
const LOW_CENTS = 1100

const consent = { terms: TERMS_VERSION, startNow: true as const }

describe('a year against twelve months', () => {
  test('is sold at or under twelve months, and not over', () => {
    expect(yearSold(12_000, 1_000)).toBe(true)
    expect(yearSold(12_001, 1_000)).toBe(false)
  })
})

describe.skipIf(!hasDatabase)('a year dearer than twelve months now', () => {
  const w = new PolarWorld()
  let room: EarlyRoomControl

  beforeAll(async () => {
    await w.start()
    room = new EarlyRoomControl({ db: w.h.db, maxPoints: 100_000 })
  }, 30_000)
  afterAll(() => w.close())
  beforeEach(async () => {
    w.reset()
    w.early.splice(
      0,
      w.early.length,
      earlyProduct(EARLY_PLUS, { plan: 'plus', included_units: 90 }, LOW_CENTS),
    )
    await w.h.db.delete(schema.earlyHolds)
  })

  /** The room open for `checkouts` of Plus, read past the minute the shown offers are kept. */
  const open = async (checkouts: number, at: number) => {
    setSystemTime(new Date(at))
    await room.set({
      roomPoints: checkouts * 300,
      points: { core: 100, plus: 300 },
      validUntil: new Date(at + 30 * MINUTE_MS),
    })
  }
  const plusListed = async () =>
    withOffers(publicPlans({ unsoldPlans: [] }), await shownOffersOf(w.h.app.billing).read()).find(
      (plan) => plan.key === 'plus',
    )

  test('is left out and refused, and comes back when the month costs more again', async () => {
    const start = Date.now()
    try {
      await open(10, start)
      expect(await plusListed()).toMatchObject({ monthlyPriceCents: LOW_CENTS, yearlyPriceCents: null })
      const buyer = await w.h.user('Dearer')
      await expect(w.h.app.billing.startCheckout(buyer, 'plus', { term: 'year', consent })).rejects.toThrow(
        /isn’t on sale while twelve months cost less/,
      )

      await open(0, start + 2 * MINUTE_MS)
      expect((await plusListed())?.yearlyPriceCents).not.toBeNull()
      const { url } = await w.h.app.billing.startCheckout(buyer, 'plus', { term: 'year', consent })
      expect(url).toStartWith('https://polar.test/checkout/')
    } finally {
      setSystemTime()
    }
  })

  test('still renews a year already held', async () => {
    const start = Date.now()
    try {
      const owner = await w.h.user('Holder')
      await w.paidYear(owner, { created_at: new Date(start).toISOString() })
      // Past the minute the last test's reading is kept.
      await open(10, start + 10 * MINUTE_MS)
      expect((await plusListed())?.yearlyPriceCents).toBeNull()
      const { url } = await w.h.app.billing.startCheckout(owner, 'plus', { term: 'year', consent })
      expect(url).toStartWith('https://polar.test/checkout/')
    } finally {
      setSystemTime()
    }
  })
})
