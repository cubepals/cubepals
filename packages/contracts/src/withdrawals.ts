// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cancelling a purchase within 14 days of buying it, from the account page: what the page lists,
 * what it sends to cancel one, and how an amount of it is said. The control plane decides which
 * purchases can be, and what the Refunds page's rule gives back; nothing it does pays money out.
 */
import { z } from 'zod'

/**
 * Hours of play, counted as the account page counts them (a large server spends two an hour, the
 * largest four), below which a paid plan cancelled in its first 14 days gets everything back, the
 * first time a person has one. At or past it, only the part not played is refunded, as the law
 * requires. The Refunds page states it (`apps/web/src/legal/figures.ts`), and the control plane
 * works refunds out to it (`app/billing/withdrawable.ts`).
 */
export const FULL_REFUND_UNDER_HOURS = 30

/**
 * Money as an order states it, for the account page and the emails alike: "$15.00", or "EUR 12.00"
 * in another currency.
 */
export function orderMoney(cents: number, currency: string): string {
  const code = currency.toUpperCase()
  return code === 'USD' ? `$${(cents / 100).toFixed(2)}` : `${code} ${(cents / 100).toFixed(2)}`
}

/** What the account page sends to cancel one purchase: its order, as the list named it. */
export const WithdrawInput = z.object({ order: z.string().trim().min(1).max(200) })
export type WithdrawInput = z.infer<typeof WithdrawInput>

/** One purchase the account made in the last 14 days that can be cancelled, or was. */
export interface WithdrawalView {
  order: string
  kind: 'plan' | 'year' | 'gift' | 'chip_in'
  /** What it is called, as its emails call it: "your first month of Plus". */
  title: string
  boughtAt: string
  /** The last moment it can be cancelled here. */
  until: string
  /**
   * What it cost in all, tax included, with `also` counted, and what the Refunds page's rule gives
   * back of it now.
   */
  paidCents: number
  refundCents: number
  /** The currency its order charged in, as the provider names it: "usd". */
  currency: string
  /**
   * A first month's other charges, cancelled and refunded with it: a change of plan or price paid
   * inside its 14 days. Each as its emails call it: "the upgrade to Plus".
   */
  also: { order: string; title: string; boughtAt: string; paidCents: number }[]
  /** Hours played that count, as the account counts them; null where none count (a gift not redeemed). */
  hoursPlayed: number | null
  /** The rule's part: `full` everything, `played` less the hours played, the rest everything or the unplayed share. */
  rule: 'full' | 'played' | 'unstarted' | 'unredeemed' | 'unplayed'
  /** When it was cancelled here; null while it can still be. */
  requestedAt: string | null
}
