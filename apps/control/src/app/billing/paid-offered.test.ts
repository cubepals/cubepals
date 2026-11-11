// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What an email says brings play back: the plan on sale, with the hours it is offered with now. */
import { afterEach, expect, test } from 'bun:test'
import { entitlementsFor, PAID_PLANS, planName } from '../../domain/account/entitlements.ts'
import { installUnsoldPlans, planOnSaleHere } from '../../domain/account/on-sale.ts'
import { installOffers, paidOffered } from './paid-offered.ts'

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
