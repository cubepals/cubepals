// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What paying reports, from the checkout page, the account page and chipping in:
 *
 * - `checkout_opened`: the checkout page showed a plan to buy. `plan`, `term` (`month`, `year`)
 *   and `reason`, the place it was reached for (an `UpgradeReason`).
 * - `checkout_continued`: both boxes ticked, on to the payment provider: `plan` and `term`.
 * - `billing_returned`: back on the account page from the provider's pages (paying, or managing
 *   billing). `plan_changed` says whether the plan is another than before: paid, where the
 *   control plane's own `plan_upgraded` says it once per account and plan.
 * - `chip_in_opened`: an amount pressed to chip in, signed in, on to paying: `cents`.
 *   `chip_in_returned`: back on the server's page from paying.
 * - `extra_play_set`: the owner's own limit on extra play changed: `units`, its hours.
 *
 * Amounts are the offer's own, never a card, an address or a name; PostHog runs cookieless
 * (lib/insight.tsx).
 */
import type { AccountOverviewView, BillingTerm, UpgradeReason } from '@blockly/contracts'
import { capture } from './insight'

/** The events, by what they report. Their names are a contract with the analytics built on them. */
const PAYING_EVENTS = {
  checkoutOpened: 'checkout_opened',
  checkoutContinued: 'checkout_continued',
  billingReturned: 'billing_returned',
  chipInOpened: 'chip_in_opened',
  chipInReturned: 'chip_in_returned',
  extraPlaySet: 'extra_play_set',
} as const

type Plan = AccountOverviewView['plan']

/** The checkout page showed a plan to buy. */
export function checkoutOpened(plan: string, term: BillingTerm, reason: UpgradeReason): void {
  capture(PAYING_EVENTS.checkoutOpened, { plan, term, reason })
}

/** On to the payment provider's page. */
export function checkoutContinued(plan: string, term: BillingTerm): void {
  capture(PAYING_EVENTS.checkoutContinued, { plan, term }, true)
}

/** Back from the provider's pages: whether the plan, or the year paid for, is another than before. */
export function billingReturned(before: Plan, after: Plan): void {
  const changed = before.key !== after.key || before.year?.endsAt !== after.year?.endsAt
  capture(PAYING_EVENTS.billingReturned, { plan_changed: changed })
}

/** An amount pressed to chip in. */
export function chipInOpened(cents: number): void {
  capture(PAYING_EVENTS.chipInOpened, { cents }, true)
}

/** Back on the server's page from chipping in. */
export function chipInReturned(): void {
  capture(PAYING_EVENTS.chipInReturned, {})
}

/** The owner's limit on extra play, in hours. */
export function extraPlaySet(units: number): void {
  capture(PAYING_EVENTS.extraPlaySet, { units })
}
