// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plan by the month on sale here, as the emails that name what brings play back say it (the
 * trial running out, and a friend who came to a server resting for it): its name and the hours a
 * month a new subscriber is offered now, the same the pricing page says. The offers are read
 * through what the billing service installs when it is made, as `on-sale.ts` is set when the
 * control plane is composed; until then, and where they can't be read, the plan table's own.
 */
import type { PublicOffer } from '@blockly/contracts'
import { entitlementsFor, planName } from '../../domain/account/entitlements.ts'
import { planOnSaleHere } from '../../domain/account/on-sale.ts'

type OffersNow = () => Promise<readonly PublicOffer[]>

let offersNow: OffersNow = async () => []

/** Where the offers the pricing page shows are read: `shownOffersOf(billing).read`. */
export function installOffers(read: OffersNow): void {
  offersNow = read
}

/** The plan on sale here with its hours a month now; null where none is, or it has no hours a month. */
export async function paidOffered(): Promise<{ name: string; hours: number } | null> {
  const paid = planOnSaleHere()
  if (paid === null) return null
  const now = (await offersNow().catch(() => [])).find((offer) => offer.plan === paid)
  const hours = now?.includedHours ?? entitlementsFor(paid).includedUnits
  return hours === null ? null : { name: planName(paid), hours }
}
