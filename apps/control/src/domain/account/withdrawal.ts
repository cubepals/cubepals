// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the Refunds page's rule gives back when a purchase is cancelled within its 14 days. Pure.
 * Time on a plan (a first month, a year, a gift redeemed): everything below
 * `FULL_REFUND_UNDER_HOURS` played, once per person; otherwise the person pays for the hours played
 * out of the hours the plan includes in a month, from its first month's share of the price, and
 * gets the rest back, the other months in full. Time that hasn't started, and a gift nobody
 * redeemed, come back whole. A chip-in gives back its share for the hours nobody has played.
 *
 * The amount is what the operator is told and the person shown; nothing here pays it. Where the
 * purchase and its play are read from is `app/billing/withdrawable.ts`.
 */

/**
 * Hours played below which a plan cancelled within 14 days is refunded in full, once per person.
 * The web app's policy states it (`apps/web/src/legal/figures.ts`), and `scripts/legal-figures.test.ts`
 * holds the two to the same number.
 */
export const FULL_REFUND_UNDER_HOURS = 30

/** Which part of the rule gave the amount. `full` is the one a person has once. */
export type WithdrawalRule = 'full' | 'played' | 'unstarted' | 'unredeemed' | 'unplayed'

/** What a purchase is, for the rule. Cents are what the order charged, tax included. */
export type Withdrawn =
  | {
      /** Time on a plan: `months` of it paid by the order (1 for a first month, 12 for a year). */
      kind: 'time'
      paidCents: number
      months: number
      /** Whether its time has begun; time paid ahead that hasn't comes back whole. */
      started: boolean
      /** Hours played since it began, as the account counts them (a large server two an hour). */
      playedUnits: number
      /** The hours a month its plan includes; null for a plan with none. */
      includedUnits: number | null
      /** The person had a full refund on an earlier purchase. */
      earlierFull: boolean
    }
  | { kind: 'unredeemed'; paidCents: number }
  | {
      kind: 'chip_in'
      paidCents: number
      /** The hours it bought, and those of them played, in thousandths. */
      milli: number
      playedMilli: number
    }

/**
 * The refund the rule gives, in cents, and which part of it gave it. What is kept is rounded down,
 * so a cent's doubt goes to the person.
 */
export function withdrawalAmount(purchase: Withdrawn): { refundCents: number; rule: WithdrawalRule } {
  if (purchase.kind === 'unredeemed') return { refundCents: purchase.paidCents, rule: 'unredeemed' }
  if (purchase.kind === 'chip_in') {
    const share = purchase.milli <= 0 ? 0 : Math.min(1, Math.max(0, purchase.playedMilli / purchase.milli))
    const kept = Math.floor(purchase.paidCents * share)
    return { refundCents: purchase.paidCents - kept, rule: 'unplayed' }
  }
  if (!purchase.started) return { refundCents: purchase.paidCents, rule: 'unstarted' }
  if (purchase.playedUnits < FULL_REFUND_UNDER_HOURS && !purchase.earlierFull)
    return { refundCents: purchase.paidCents, rule: 'full' }
  // A plan with no monthly hours has none to measure play against: nothing of it is kept.
  const included = purchase.includedUnits ?? 0
  const share = included <= 0 ? 0 : Math.min(1, Math.max(0, purchase.playedUnits / included))
  const kept = Math.floor((purchase.paidCents * share) / Math.max(1, purchase.months))
  return { refundCents: purchase.paidCents - kept, rule: 'played' }
}
