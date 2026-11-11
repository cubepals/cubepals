// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'
import { CheckoutConsent } from './agreements.ts'
import { ServerId } from './server.ts'
import { InviteRef, PageRef } from './sharing.ts'

/**
 * Friends chipping in to a server they play on: from its page or an invitation, a one-time payment
 * that becomes hours of play on that server, and what its owner sees of it.
 */

/** What one chip-in may be, in US cents, tax included: $5 is the least, $50 the most. */
export const CHIP_IN_CENTS = { min: 500, max: 5000 } as const

/** The amounts the page offers. */
export const CHIP_IN_AMOUNTS = [500, 1000, 2000] as const

/**
 * A chip-in from the page it was offered on: a public page by its slug, or an invitation, with
 * what the person agreed to there, as a plan's checkout asks it (the Terms, and that its hours
 * start straight away, inside the 14 days they can cancel in).
 */
export const ChipInInput = z.object({
  to: z.union([PageRef, InviteRef]),
  cents: z.number().int().min(CHIP_IN_CENTS.min).max(CHIP_IN_CENTS.max),
  consent: CheckoutConsent,
})

export const SetChipInInput = z.object({ serverId: ServerId, open: z.boolean() })

/** What the owner sees: whether friends may chip in, what they did, and what is left of it. */
export interface ChipInsView {
  /** The owner lets friends chip in. */
  open: boolean
  /**
   * The server's page offers it: open, and on a plan whose monthly hours chip-ins add to. Hours
   * already chipped in wait while it isn't.
   */
  offered: boolean
  /** Hours chipped in not yet played, as the account counts them: a large server uses two an hour. */
  hoursLeft: number
  /** Who chipped in, newest first, with the hours each bought, refunds taken off. */
  people: Array<{ name: string; hours: number; at: string }>
}
