// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The guards on extra play, as `extraPlay` decides them from what the billing provider said: each
 * one that stops it, the sentence it says, and the ceiling that grows with a paid renewal.
 */
import { describe, expect, test } from 'bun:test'
import type { Entitlements } from './entitlements.ts'
import { entitlementsFor } from './entitlements.ts'
import { type BillingFacts, ceilingsFor, extraPlay as decide, extraUnits } from './extra-play.ts'

/** Ceilings for these tests, not a deployment's. */
const CEILINGS = { untilRenewed: 20, renewed: 60 }
const extraPlay = (plan: Entitlements, allowed: number, billing: BillingFacts) =>
  decide(plan, allowed, billing, CEILINGS)

const plus = entitlementsFor('plus')

/** Plus, active, its first payment made, no renewal yet, nothing owed, unless patched. */
const paying = (patch: Partial<BillingFacts> = {}): BillingFacts => ({
  subscription: { status: 'active', cancelAtPeriodEnd: false },
  paidOrders: 1,
  paidRenewals: 0,
  owedCents: 0,
  ...patch,
})

describe('extra play', () => {
  test('Core allows extra play as Plus does, at the same price, under the same guards', () => {
    const core = entitlementsFor('core')
    expect(core.mayBuyMore).toBe(true)
    expect(extraPlay(core, 50, paying())).toEqual({ may: true, ceiling: 20, units: 20 })
    expect(extraPlay(core, 50, paying({ paidRenewals: 1 }))).toEqual({ may: true, ceiling: 60, units: 50 })
    expect(
      extraPlay(core, 10, paying({ subscription: { status: 'past_due', cancelAtPeriodEnd: false } })),
    ).toMatchObject({
      may: false,
    })
    expect(extraPlay(core, 10, paying({ owedCents: 500 }))).toMatchObject({ may: false })
    // The words name the plan it is billed on.
    expect(extraPlay(core, 10, paying({ paidOrders: 0 }))).toEqual({
      may: false,
      why: 'Extra hours open once your first Core payment has gone through.',
    })
    expect(extraPlay(core, 10, { ...paying(), subscription: null })).toEqual({
      may: false,
      why: 'Extra hours are billed on a Core subscription, and this account doesn’t have one.',
    })
  })

  test('Core’s own ceiling is 60 extra hours, whatever the account’s: no more is allowed than Polar bills', () => {
    const core = entitlementsFor('core')
    // Ceilings of 20 until a renewal and 200 after, as a deployment may set them.
    const wide = { untilRenewed: 20, renewed: 200 }
    expect(decide(core, 500, paying(), wide)).toEqual({ may: true, ceiling: 20, units: 20 })
    expect(decide(core, 500, paying({ paidRenewals: 1 }), wide)).toEqual({
      may: true,
      ceiling: 60,
      units: 60,
    })
    // A ceiling already under Core's own is the ceiling.
    expect(decide(core, 500, paying({ paidRenewals: 1 }), { untilRenewed: 10, renewed: 40 })).toEqual({
      may: true,
      ceiling: 40,
      units: 40,
    })
    // Plus keeps the account's ceiling.
    expect(decide(plus, 500, paying({ paidRenewals: 1 }), wide)).toEqual({
      may: true,
      ceiling: 200,
      units: 200,
    })
    expect(ceilingsFor(core, wide)).toEqual({ untilRenewed: 20, renewed: 60 })
    expect(ceilingsFor(plus, wide)).toEqual(wide)
  })

  test('a paying Plus account may allow some, up to one ceiling until a renewal is paid, then another', () => {
    expect(extraPlay(plus, 50, paying())).toEqual({ may: true, ceiling: 20, units: 20 })
    expect(extraPlay(plus, 50, paying({ paidRenewals: 1 }))).toEqual({ may: true, ceiling: 60, units: 50 })
    expect(extraPlay(plus, 500, paying({ paidRenewals: 3 }))).toEqual({ may: true, ceiling: 60, units: 60 })
    // Nothing allowed is nothing to play.
    expect(extraUnits(extraPlay(plus, 0, paying()))).toBe(0)
  })

  test('Free never may, and says which plan does', () => {
    expect(extraPlay(entitlementsFor('free'), 20, paying())).toEqual({
      may: false,
      why: 'Extra hours come with Core.',
    })
  })

  test('nothing paid yet, a trial, or a plan with no subscription to bill may not', () => {
    const first = 'Extra hours open once your first Plus payment has gone through.'
    expect(extraPlay(plus, 20, paying({ paidOrders: 0 }))).toEqual({ may: false, why: first })
    expect(
      extraPlay(plus, 20, paying({ subscription: { status: 'trialing', cancelAtPeriodEnd: false } })),
    ).toEqual({ may: false, why: first })
    const none = 'Extra hours are billed on a Plus subscription, and this account doesn’t have one.'
    expect(extraPlay(plus, 20, paying({ subscription: null }))).toEqual({ may: false, why: none })
    expect(
      extraPlay(plus, 20, paying({ subscription: { status: 'ended', cancelAtPeriodEnd: false } })),
    ).toEqual({ may: false, why: none })
  })

  test('cancelling, a failed payment and money owed each stop it, and say why', () => {
    expect(
      extraPlay(plus, 20, paying({ subscription: { status: 'active', cancelAtPeriodEnd: true } })),
    ).toEqual({
      may: false,
      why: 'Your Plus is set to end, so extra hours are off. Keep Plus in Manage billing to allow them.',
    })
    expect(
      extraPlay(plus, 20, paying({ subscription: { status: 'past_due', cancelAtPeriodEnd: false } })),
    ).toEqual({
      may: false,
      why: 'Your last payment didn’t go through, so extra hours are off until it does.',
    })
    // Owing comes first: it is the one thing to fix, whatever else is true.
    expect(extraPlay(plus, 20, paying({ owedCents: 2000, paidRenewals: 2 }))).toEqual({
      may: false,
      why: 'You owe $20.00 from a payment that didn’t go through, so extra hours are off until it’s paid.',
    })
    expect(extraUnits(extraPlay(plus, 20, paying({ owedCents: 1 })))).toBe(0)
  })
})
