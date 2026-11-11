// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every call Blockly makes to the billing provider, with what cancelling a purchase within 14 days
 * does with what the call can charge. A call added to `BillingProvider` doesn't compile here until
 * it says, so no new way to charge is left out of a cancel by being forgotten (`AGENTS.md`, Money).
 * It proves nothing about the answer given: `withdrawals.test.ts` holds each to its behaviour.
 */
import { expect, test } from 'bun:test'
import type { BillingProvider } from '../ports/optional.ts'

/** What a cancel does with a call's charge, or that the call charges nothing. */
type OnCancel =
  /** It charges nothing. */
  | 'charges nothing'
  /** Its order is a purchase that can be cancelled by itself. */
  | 'a purchase of its own'
  /** Its order is cancelled and refunded with the subscription's first month. */
  | 'goes with its first month'
  /** It is no new purchase and has no 14 days of its own; `why` says what it is. */
  | { never: string }

const ON_CANCEL = {
  provider: 'charges nothing',
  // A plan's first month, or a year paid at once.
  checkoutUrl: 'a purchase of its own',
  sells: 'charges nothing',
  sellsYear: 'charges nothing',
  earlyProduct: 'charges nothing',
  stopRenewing: 'charges nothing',
  // Applies when the period paid for ends: what it charges then is a renewal.
  moveToPlan: { never: 'its charge is the next renewal' },
  // Charges the difference at once, as an order of its own on the same subscription.
  upgradeSubscription: 'goes with its first month',
  endSubscription: 'charges nothing',
  refundedAsWithdrawal: 'charges nothing',
  portalUrl: 'charges nothing',
  settleUrl: { never: 'it pays for play already had' },
  chipInUrl: 'a purchase of its own',
  receive: 'charges nothing',
  order: 'charges nothing',
  giftProducts: 'charges nothing',
  giftCheckoutUrl: 'a purchase of its own',
  refund: 'charges nothing',
  stateOf: 'charges nothing',
  pastDueSince: 'charges nothing',
  // Extra play is billed with the renewal it falls in.
  reportUsage: { never: 'it is billed with a renewal, for play already had' },
  discounts: 'charges nothing',
  createDiscount: 'charges nothing',
  deleteDiscount: 'charges nothing',
} satisfies Record<keyof BillingProvider, OnCancel>

test('each call that charges says what a cancel within 14 days does with it', () => {
  const charging = Object.entries(ON_CANCEL).filter(([, does]) => does !== 'charges nothing')
  expect(charging.map(([call]) => call).sort()).toEqual([
    'checkoutUrl',
    'chipInUrl',
    'giftCheckoutUrl',
    'moveToPlan',
    'reportUsage',
    'settleUrl',
    'upgradeSubscription',
  ])
  for (const [, does] of charging) if (typeof does !== 'string') expect(does.never.length).toBeGreaterThan(0)
})
