// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'

/**
 * Cancelling a purchase within 14 days of buying it, from the account page: what the page lists,
 * and what it sends to cancel one. The control plane decides which purchases can be, and what the
 * Refunds page's rule gives back; nothing it does pays money out.
 */

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
  /** What it cost, tax included, and what the Refunds page's rule gives back of it now. */
  paidCents: number
  refundCents: number
  /** Hours played that count, as the account counts them; null where none count (a gift not redeemed). */
  hoursPlayed: number | null
  /** The rule's part: `full` everything, `played` less the hours played, the rest everything or the unplayed share. */
  rule: 'full' | 'played' | 'unstarted' | 'unredeemed' | 'unplayed'
  /** When it was cancelled here; null while it can still be. */
  requestedAt: string | null
}
