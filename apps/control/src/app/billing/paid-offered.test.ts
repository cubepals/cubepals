// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What an email says of another plan: the plan on sale, and the larger one, as each is offered now. */
import { afterEach, expect, test } from 'bun:test'
import { entitlementsFor, PAID_PLANS, planName } from '../../domain/account/entitlements.ts'
import { installUnsoldPlans, planOnSaleHere } from '../../domain/account/on-sale.ts'
import { installOffers, largerOffered, paidOffered } from './paid-offered.ts'

afterEach(() => {
  installUnsoldPlans([])
  installOffers(async () => [])
})

test('says the hours a new subscriber is offered, and the plan’s own where none are read', async () => {
  const paid = planOnSaleHere()
  if (paid === null) throw new Error('a paid plan is on sale by default')
  const own = entitlementsFor(paid).includedUnits
  if (own === null) throw new Error('the plan on sale has hours a month')
  // Made-up hours, unlike any plan's own.
  const offered = own + 7
  installOffers(async () => [{ plan: paid, priceCents: 1, includedHours: offered }])
  expect(await paidOffered()).toEqual({
    name: planName(paid),
    hours: offered,
  })
  installOffers(async () => [{ plan: paid, priceCents: 1, includedHours: null }])
  expect(await paidOffered()).toEqual({
    name: planName(paid),
    hours: own,
  })
  installOffers(async () => Promise.reject(new Error('unread')))
  expect(await paidOffered()).toEqual({
    name: planName(paid),
    hours: own,
  })
  installUnsoldPlans(PAID_PLANS)
  expect(await paidOffered()).toBeNull()
})

test('says past how many extra hours the larger plan costs less from what it is offered at now', async () => {
  const held = PAID_PLANS.map((key) => entitlementsFor(key)).find((plan) =>
    PAID_PLANS.some((key) => entitlementsFor(key).monthlyPriceCents > plan.monthlyPriceCents),
  )
  if (held === undefined) throw new Error('a paid plan has a larger one')
  const table = await largerOffered(held)
  const larger = table.larger
  if (larger === undefined) throw new Error('the plan table has a larger plan')
  const key = PAID_PLANS.find((plan) => planName(plan) === larger.name) ?? ''
  // A made-up offer: seven extra hours and a little over what the held plan pays.
  const offered = held.monthlyPriceCents + 7 * table.unitCents + 3
  expect(larger.extraHoursCheaper).not.toBe(7)
  installOffers(async () => [{ plan: key, priceCents: offered, includedHours: null }])
  expect(await largerOffered(held)).toEqual({
    unitCents: table.unitCents,
    larger: { name: larger.name, extraHoursCheaper: 7 },
  })
  // Offered for no more than the held plan pays: nothing says it costs less past some hours.
  installOffers(async () => [{ plan: key, priceCents: held.monthlyPriceCents, includedHours: null }])
  expect(await largerOffered(held)).toEqual({ unitCents: table.unitCents })
  // Unread: the plan table's.
  installOffers(async () => Promise.reject(new Error('unread')))
  expect(await largerOffered(held)).toEqual(table)
})
