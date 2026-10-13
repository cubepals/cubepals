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
 * - `upgrade_shown`: a plan was offered where someone reached for what theirs leaves out
 *   (`PlusOffer`), once where it is drawn: `plan`, `reason` (an `UpgradeReason`), `where` the page
 *   is (app/(public)/steps.ts), and `button`, whether it came with its price and a way to get it
 *   or only as the line that says why. `upgrade_pressed`: its button was pressed. `upgrade_declined`:
 *   the way on without it was taken ("Choose plain Minecraft instead"). Both with `plan`, `reason`
 *   and `where`.
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
  upgradeShown: 'upgrade_shown',
  upgradePressed: 'upgrade_pressed',
  upgradeDeclined: 'upgrade_declined',
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

/** Where a plan is offered: which plan, why, and on what page. */
interface Offered {
  plan: string
  reason: UpgradeReason
  where: string
}

/** A plan offered where it was reached for; `button`: with its price and a way to get it. */
export function upgradeShown(offered: Offered, button: boolean): void {
  capture(PAYING_EVENTS.upgradeShown, { ...offered, button })
}

/** The offer's button, on to the checkout page. */
export function upgradePressed(offered: Offered): void {
  capture(PAYING_EVENTS.upgradePressed, { ...offered }, true)
}

/** The way on without it. */
export function upgradeDeclined(offered: Offered): void {
  capture(PAYING_EVENTS.upgradeDeclined, { ...offered })
}

/** The owner's limit on extra play, in hours. */
export function extraPlaySet(units: number): void {
  capture(PAYING_EVENTS.extraPlaySet, { units })
}
