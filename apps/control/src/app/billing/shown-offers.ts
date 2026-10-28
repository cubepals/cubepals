// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PublicOffer } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'

/** What reads the offers fresh: `BillingService.liveOffers`. */
interface OffersSource {
  liveOffers(): Promise<PublicOffer[]>
}

/**
 * The offers the pricing page and the public endpoint show, read once a minute at most: every
 * page and every caller in that minute shares one answer, and callers who ask while it is being
 * read wait for that read rather than starting their own. A read that fails answers no offers, so
 * the plan table stands, and isn't kept. Not for a checkout, which asks `BillingService.offer` for
 * the price it will charge.
 */
export class ShownOffers {
  readonly #read: () => Promise<PublicOffer[]>
  readonly #now: () => number
  #kept: { at: number; offers: Promise<PublicOffer[]> } | null = null

  constructor(read: () => Promise<PublicOffer[]>, now: () => number = Date.now) {
    this.#read = read
    this.#now = now
  }

  read(): Promise<PublicOffer[]> {
    const at = this.#now()
    if (this.#kept !== null && at - this.#kept.at < MINUTE_MS) return this.#kept.offers
    const offers = this.#read().catch((error: unknown) => {
      console.error(`billing: offers unread, the plan table stands: ${(error as Error).message}`)
      if (this.#kept === kept) this.#kept = null
      return []
    })
    const kept = { at, offers }
    this.#kept = kept
    return offers
  }
}

const SHOWN = new WeakMap<OffersSource, ShownOffers>()

/** The one `ShownOffers` of a billing service, which the public endpoint and tRPC's `billing.plans` share. */
export function shownOffersOf(billing: OffersSource): ShownOffers {
  let shown = SHOWN.get(billing)
  if (shown === undefined) {
    shown = new ShownOffers(() => billing.liveOffers())
    SHOWN.set(billing, shown)
  }
  return shown
}
