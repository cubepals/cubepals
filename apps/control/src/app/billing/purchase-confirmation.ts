// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The confirmation of a purchase a buyer can keep, by email, once its order is paid: what they
 * bought, what they paid as the order states it, the hours it includes, that it started straight
 * away as they asked (a gift starts only when redeemed), and that they can cancel within 14 days
 * and where. The order is marked (`confirmed_at`) in the transaction that sends it, so a delivery
 * that comes again, or two at once, sends nothing more, and one whose email failed stays unmarked
 * for the billing pass to send (`confirmUnsent`), the way a cancellation's emails are. That makes it
 * sent at least once: an email that went just before its mark failed to be kept goes again, which
 * is better than a confirmation the law asks for never going. A renewal is no new purchase and has
 * none; nor has an order already refunded, or one older than its 14 days.
 *
 * The provider's own receipt is separate. Not here: what a purchase is (`withdrawable.ts`).
 */
import { type Db, schema } from '@blockly/db'
import { and, eq, isNull } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { emailOf } from '../accounts/persistence.ts'
import { purchaseConfirmed } from '../emails/purchases.ts'
import type { Mailer } from '../ports/platform.ts'
import { WITHDRAWAL_MS } from './ending.ts'
import { offeredHours } from './paid-offered.ts'
import { type Purchase, purchasesOf, purchaseTitle, subscriptionHours } from './withdrawable.ts'

const orders = schema.billingOrders

/** A day as the email says when a year starts: "26 October 2027". */
const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

interface Confirming {
  db: Db
  mailer: Mailer
  webOrigin: string
}

/**
 * Emails the buyer what an order they paid bought, once. Run after the order's word was handled
 * (`BillingService`), so the year, gift or chip-in it made is there to say.
 */
export async function confirmPurchase(
  deps: Confirming,
  provider: string,
  order: string,
  now = new Date(),
): Promise<void> {
  const [purchase] = await purchasesOf(deps.db, provider, { order })
  if (purchase === undefined) return
  await confirm(deps, purchase, now)
}

/**
 * The billing pass: each purchase of the last 14 days whose confirmation is still unsent, sent now,
 * the oldest first. One that fails is handed to `failed` and waits for the next pass; one with
 * nobody to send to is passed over, so it holds nothing back.
 */
export async function confirmUnsent(
  deps: Confirming,
  provider: string,
  failed: (order: string, error: unknown) => void,
  now = new Date(),
): Promise<void> {
  const since = new Date(now.getTime() - WITHDRAWAL_MS)
  const unsent = await purchasesOf(deps.db, provider, { since, unconfirmed: true })
  for (const purchase of unsent.reverse()) {
    try {
      await confirm(deps, purchase, now)
    } catch (error) {
      failed(purchase.externalOrderId, error)
    }
  }
}

async function confirm(deps: Confirming, purchase: Purchase, now: Date): Promise<void> {
  if (purchase.kind === null || purchase.refundedCents > 0 || purchase.confirmedAt !== null) return
  if (now > purchase.until) return
  const to =
    purchase.userId !== null ? await emailOf(deps.db, purchase.userId) : (purchase.gift?.buyerEmail ?? null)
  if (to === null) return
  const email = purchaseConfirmed({
    title: purchaseTitle(purchase),
    paidCents: purchase.paidCents,
    currency: purchase.currency,
    includes: await includes(purchase),
    started: started(purchase, now),
    until: purchase.until,
    onAccount: purchase.userId !== null,
    origin: deps.webOrigin,
  })
  await deps.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(orders)
      .set({ confirmedAt: now })
      .where(
        and(
          eq(orders.provider, purchase.provider),
          eq(orders.externalOrderId, purchase.externalOrderId),
          isNull(orders.confirmedAt),
        ),
      )
      .returning({ order: orders.externalOrderId })
    if (claimed !== undefined) await deps.mailer.send({ to, ...email })
  })
}

/** The hours it includes, said whole; null for a plan with none. */
async function includes(purchase: Purchase): Promise<string | null> {
  if (purchase.kind === 'chip_in' && purchase.chipIn !== null) {
    const hours = Math.floor(purchase.chipIn.milli / 100) / 10
    return `${hours} hours of play on ${purchase.chipIn.serverName}, kept there until they’re played`
  }
  const monthly = purchase.kind === 'plan' ? subscriptionHours(purchase) : await tableHours(purchase)
  if (monthly === null) return null
  if (purchase.kind === 'gift') {
    const months = purchase.gift?.months ?? 1
    return `${monthly} hours of play each month, for ${months === 1 ? 'a month' : `${months} months`} from when it’s redeemed`
  }
  return `${monthly} hours of play each month`
}

/**
 * The hours a month a year or a gift gives: the plan table's, said only when they are the hours
 * the pricing page offers now, so the email never names hours a page doesn't; null otherwise.
 */
async function tableHours(purchase: Purchase): Promise<number | null> {
  const planKey = purchase.year?.planKey ?? purchase.gift?.planKey ?? null
  if (planKey === null) return null
  const hours = entitlementsFor(planKey).includedUnits
  return hours !== null && hours === (await offeredHours(planKey)) ? hours : null
}

/** How its time started, as the buyer asked at checkout; null for a gift, which starts when redeemed. */
function started(purchase: Purchase, now: Date): string | null {
  if (purchase.kind === 'gift') return null
  if (purchase.kind === 'chip_in') return 'Its hours were added straight away, as you asked.'
  if (purchase.kind === 'year' && purchase.year !== null && purchase.year.startsAt > now)
    return `It starts on ${DAY.format(purchase.year.startsAt)}, when the time you’ve paid for ends. You asked for it to start as soon as it could.`
  return 'It started straight away, as you asked.'
}
