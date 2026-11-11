// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plans the public pages state: each paid plan with what a month of it charges now, read from
 * the offer endpoint, a year only where twelve of those months don't cost less, and the plan
 * table's own wherever the offer can't be read.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { asHeld, type PublicPlan, withOffers } from '@blockly/contracts'
import { pricedPlans } from './plans.ts'

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

  test('drop a year where twelve months at the offered price cost less, and keep it where not', () => {
    const yearly = { ...core, yearlyPriceCents: 9000 }
    expect(withOffers([yearly], [{ plan: 'core', priceCents: 700, includedHours: null }])[0]).toMatchObject({
      monthlyPriceCents: 700,
      yearlyPriceCents: null,
    })
    expect(withOffers([yearly], [{ plan: 'core', priceCents: 750, includedHours: null }])[0]).toMatchObject({
      yearlyPriceCents: 9000,
    })
    expect(withOffers([yearly], [])[0]).toBe(yearly)
  })

  test('are read from the offer endpoint, and are the plan table’s own when it fails', async () => {
    const asked: string[] = []
    const offer = (answer: () => Response) => {
      globalThis.fetch = (async (url: string) => {
        asked.push(new URL(url).pathname)
        return url.endsWith('/api/public/plans') ? Response.json(plans) : answer()
      }) as typeof fetch
    }
    offer(() => Response.json([{ plan: 'core', priceCents: 700, includedHours: 90 }]))
    expect((await pricedPlans())[1]).toMatchObject({ monthlyPriceCents: 700, includedHours: 90 })
    expect(asked).toEqual(['/api/public/plans', '/api/public/offer'])
    offer(() => new Response('down', { status: 503 }))
    expect(await pricedPlans()).toEqual(plans)
    offer(() => {
      throw new Error('unreachable')
    })
    expect(await pricedPlans()).toEqual(plans)
  })

  test('leave a subscriber’s own plan at the price and hours they pay', () => {
    const offered = { ...core, monthlyPriceCents: 700, includedHours: 90 }
    const held = { plan: 'core', monthlyPriceCents: 999, includedUnits: 40 }
    expect(asHeld(offered, held)).toMatchObject({ monthlyPriceCents: 999, includedHours: 40 })
    expect(asHeld(offered, { ...held, plan: 'plus' })).toBe(offered)
    expect(asHeld(free, { ...held, plan: 'free' })).toBe(free)
  })
})
