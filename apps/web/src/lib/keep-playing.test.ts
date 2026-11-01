// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The plan offered at a free trial's end, and the checkout it leads to. */
import { describe, expect, test } from 'bun:test'
import type { PublicPlan } from '@blockly/contracts'
import { checkoutOf } from './checkout'
import { keepPlayingHref, monthlyOnSale } from './keep-playing'

const trial = {
  key: 'free',
  name: 'Free trial',
  available: true,
  monthlyPriceCents: 0,
  includedHours: 20,
  per: 'once',
  totalHours: 20,
} as PublicPlan
const monthly = {
  ...trial,
  key: 'month',
  name: 'Month',
  monthlyPriceCents: 1200,
  includedHours: 50,
  per: 'month',
  totalHours: null,
} as PublicPlan
const bigger = { ...monthly, key: 'bigger', name: 'Bigger', monthlyPriceCents: 3000 } as PublicPlan

describe('the plan that keeps a server playing after its free trial', () => {
  test('is the first by the month that is for sale here', () => {
    expect(monthlyOnSale([trial, monthly, bigger])).toBe(monthly)
    expect(monthlyOnSale([trial, { ...monthly, available: false }, bigger])).toBe(bigger)
  })

  test('is never the trial, a plan with hours in all, or a free one, and none where nothing sells', () => {
    expect(monthlyOnSale([trial])).toBeNull()
    expect(monthlyOnSale([{ ...monthly, totalHours: 100 }])).toBeNull()
    expect(monthlyOnSale([{ ...monthly, per: 'once' }])).toBeNull()
    expect(monthlyOnSale([{ ...monthly, monthlyPriceCents: 0 }])).toBeNull()
    expect(monthlyOnSale([])).toBeNull()
  })

  test('goes to its checkout by the month, counted as the trial’s end, and back to the server after', () => {
    const href = keepPlayingHref('month', 'srv_1')
    expect(href.startsWith('/checkout?')).toBe(true)
    expect(checkoutOf(new URLSearchParams(href.slice('/checkout?'.length)))).toEqual({
      plan: 'month',
      term: 'month',
      reason: 'trial_over',
      next: '/servers/srv_1',
    })
  })
})
