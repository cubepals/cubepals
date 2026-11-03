// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plans the pricing page's cards show: each paid plan with what a month of it charges now,
 * read from the offer endpoint, and the plan table's own wherever that can't be read.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { asHeld, type PublicPlan, withOffers } from '@blockly/contracts'
import { offeredPlans } from './plans.ts'

const free = {
  key: 'free',
  name: 'Free trial',
  available: true,
  monthlyPriceCents: 0,
  yearlyPriceCents: null,
  includedHours: 20,
  per: 'once',
  extraHourCents: null,
  totalHours: 20,
  sleepsAfterMinutes: 10,
  maxServers: 1,
  maxPlayers: 5,
  sizes: [{ gb: 3, maxPlayers: 5, hoursAnHour: 1 }],
  mods: false,
  datapacks: false,
  downloads: 'daily',
  sessionsKept: 3,
  restsAfterDays: 14,
  deletedAfterDays: 365,
} satisfies PublicPlan
const core: PublicPlan = {
  ...free,
  key: 'core',
  name: 'Core',
  monthlyPriceCents: 999,
  includedHours: 40,
  per: 'month',
}
const plans = [free, core]

describe('the plans as a new subscriber is told them', () => {
  const real = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = real
  })

  test('take each offer’s price and hours, and leave the trial as it is', () => {
    const offers = [
      { plan: 'core', priceCents: 700, includedHours: 90 },
      { plan: 'free', priceCents: 1, includedHours: 1 },
    ]
    expect(withOffers(plans, offers)).toEqual([free, { ...core, monthlyPriceCents: 700, includedHours: 90 }])
    expect(withOffers(plans, [])).toEqual(plans)
    // An offer that doesn't say its hours keeps the plan's.
    expect(withOffers(plans, [{ plan: 'core', priceCents: 700, includedHours: null }])[1]).toMatchObject({
      monthlyPriceCents: 700,
      includedHours: 40,
    })
  })

  test('are read from the offer endpoint, and are the plan table’s own when it fails', async () => {
    const asked: string[] = []
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url))
      return Response.json([{ plan: 'core', priceCents: 700, includedHours: 90 }])
    }) as typeof fetch
    expect((await offeredPlans(plans))[1]).toMatchObject({ monthlyPriceCents: 700, includedHours: 90 })
    expect(asked[0]).toEndWith('/api/public/offer')
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch
    expect(await offeredPlans(plans)).toEqual(plans)
    globalThis.fetch = (async () => {
      throw new Error('unreachable')
    }) as unknown as typeof fetch
    expect(await offeredPlans(plans)).toEqual(plans)
  })

  test('leave a subscriber’s own plan at the price and hours they pay', () => {
    const offered = { ...core, monthlyPriceCents: 700, includedHours: 90 }
    const held = { plan: 'core', monthlyPriceCents: 999, includedUnits: 40 }
    expect(asHeld(offered, held)).toMatchObject({ monthlyPriceCents: 999, includedHours: 40 })
    expect(asHeld(offered, { ...held, plan: 'plus' })).toBe(offered)
    expect(asHeld(free, { ...held, plan: 'free' })).toBe(free)
  })
})
