/**
 * The guards on extra play, as `extraPlay` decides them from what the billing provider said: each
 * one that stops it, the sentence it says, and the ceiling that grows with a paid renewal.
 */
import { describe, expect, test } from 'bun:test'
import { EXTRA_CEILING, entitlementsFor } from './entitlements.ts'
import { type BillingFacts, extraPlay, extraUnits } from './extra-play.ts'

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
  test('a paying Plus account may allow some, up to $5 until a renewal is paid, then $25', () => {
    expect(EXTRA_CEILING).toEqual({ untilRenewed: 20, renewed: 100 })
    expect(extraPlay(plus, 50, paying())).toEqual({ may: true, ceiling: 20, units: 20 })
    expect(extraPlay(plus, 50, paying({ paidRenewals: 1 }))).toEqual({ may: true, ceiling: 100, units: 50 })
    expect(extraPlay(plus, 500, paying({ paidRenewals: 3 }))).toEqual({ may: true, ceiling: 100, units: 100 })
    // Nothing allowed is nothing to play.
    expect(extraUnits(extraPlay(plus, 0, paying()))).toBe(0)
  })

  test('Free never may, and says which plan does', () => {
    expect(extraPlay(entitlementsFor('free'), 20, paying())).toEqual({
      may: false,
      why: 'Extra hours come with Plus.',
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
