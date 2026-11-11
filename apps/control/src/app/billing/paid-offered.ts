// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Another plan, as the emails that name it say it, the same the pricing page says: the plan by the
 * month on sale here (the trial running out, and a friend who came to a server resting for it), and
 * the larger plan past whose extra hours it costs less (a month's play running out). Its price and
 * hours a month are what a new subscriber is offered now. The offers are read through what the
 * billing service installs when it is made, as `on-sale.ts` is set when the control plane is
 * composed; until then, and where they can't be read, the plan table's own. Not the person's own
 * plan, whose figures are what their subscription was sold with.
 */
import { extraHoursCheaper, type PublicOffer } from '@blockly/contracts'
import {
  type Entitlements,
  entitlementsFor,
  PAID_PLANS,
  planName,
} from '../../domain/account/entitlements.ts'
import { UNIT_CENTS } from '../../domain/account/meter.ts'
import { planOnSaleHere } from '../../domain/account/on-sale.ts'

type OffersNow = () => Promise<readonly PublicOffer[]>

let offersNow: OffersNow = async () => []

/** Where the offers the pricing page shows are read: `shownOffersOf(billing).read`. */
export function installOffers(read: OffersNow): void {
  offersNow = read
}

/** A paid plan's month as a new subscriber is offered it now; the plan table's where the offer doesn't say. */
async function monthOffered(plan: string): Promise<{ priceCents: number; hours: number | null }> {
  const own = entitlementsFor(plan)
  const now = (await offersNow().catch(() => [])).find((offer) => offer.plan === plan)
  return {
    priceCents: now?.priceCents ?? own.monthlyPriceCents,
    hours: now?.includedHours ?? own.includedUnits,
  }
}

/** The plan on sale here with its hours a month now; null where none is, or it has no hours a month. */
export async function paidOffered(): Promise<{ name: string; hours: number } | null> {
  const paid = planOnSaleHere()
  if (paid === null) return null
  const { hours } = await monthOffered(paid)
  return hours === null ? null : { name: planName(paid), hours }
}

/**
 * What an email about running out says of extra hours and the plan with more than `held`: its name,
 * and past how many extra hours a month it costs less (`extraHoursCheaper`), from what a month of it
 * charges a new subscriber now and what `held` pays. Nothing of a larger plan for the free trial,
 * the largest plan, or where the larger one costs no more.
 */
export async function largerOffered(held: Entitlements): Promise<{
  unitCents: number
  larger?: { name: string; extraHoursCheaper: number }
}> {
  const next = PAID_PLANS.map((key) => entitlementsFor(key)).find(
    (each) =>
      each.monthlyPriceCents > held.monthlyPriceCents &&
      (each.includedUnits ?? 0) > (held.includedUnits ?? 0),
  )
  if (next === undefined || held.plan === 'free') return { unitCents: UNIT_CENTS }
  const past = extraHoursCheaper(
    (await monthOffered(next.plan)).priceCents,
    held.monthlyPriceCents,
    UNIT_CENTS,
  )
  if (past === null) return { unitCents: UNIT_CENTS }
  return { unitCents: UNIT_CENTS, larger: { name: planName(next.plan), extraHoursCheaper: past } }
}
