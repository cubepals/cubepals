// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A purchase cancelled within its 14 days stops being usable at once, the way a refund from the
 * provider already stops it, by the same code: a first month's subscription is marked ended here
 * (`endedHere`; the provider ended it first), a year ends now or, not started, never starts, and
 * its end is recorded (`recordYearEnds`), a gift is voided (`voidGift`), and a chip-in's hours
 * nobody played can no longer be played (`withdrawn_milli`). Run in the transaction that keeps the
 * request (`withdrawals.ts`). It decides nothing about whether it may be cancelled, and pays nothing.
 */
import { schema, type Tx } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { planName } from '../../domain/account/entitlements.ts'
import { AppError, NotFound } from '../errors.ts'
import { writeEntries } from './audit.ts'
import { endedHere, REVOKED } from './ending.ts'
import { voidGift } from './gifts.ts'
import type { Assessed, Purchase } from './withdrawable.ts'
import { recordYearEnds } from './years.ts'

/** What stopping it changed: the accounts whose plan or servers it moved, and what ended, said whole. */
export interface Stopped {
  affected: string[]
  ended: string
}

/** Hours as the page and the emails say them: to a tenth. */
export const tenths = (milli: number) => Math.round(milli / 100) / 10

/** Stops the purchase; `by` is who asked, as the audit log names them. */
export function stopPurchase(
  tx: Tx,
  purchase: Purchase,
  assessed: Assessed,
  by: string,
  now: Date,
): Promise<Stopped> {
  if (purchase.kind === 'plan') return stopPlan(tx, purchase, by)
  if (purchase.kind === 'year') return stopYear(tx, purchase, by, now)
  if (purchase.kind === 'gift') return stopGift(tx, purchase, by)
  return stopChipIn(tx, purchase, assessed, by, now)
}

async function stopPlan(tx: Tx, purchase: Purchase, by: string): Promise<Stopped> {
  const userId = purchase.userId
  const sub = purchase.externalSubscriptionId
  if (userId === null || sub === null) throw new NotFound('Purchase')
  const ending = { provider: purchase.provider, userId, sub, why: 'withdrawal' as const }
  // Ended here already, the provider's word on its end having come first: why is kept all the same.
  if ((await endedHere(tx, ending, by, 'user')) === null)
    await writeEntries(tx, userId, by, 'user', [
      {
        action: REVOKED,
        data: { provider: purchase.provider, subscription: sub, plan: purchase.planKey, why: 'withdrawal' },
      },
    ])
  const plan = planName(purchase.planKey ?? 'plus')
  return {
    affected: [userId],
    ended: `${plan} has ended, and nothing more will be charged for it. Your account is on the free trial now; your worlds stay.`,
  }
}

async function stopYear(tx: Tx, purchase: Purchase, by: string, now: Date): Promise<Stopped> {
  const year = purchase.year
  if (year === null) throw new NotFound('Purchase')
  const waiting = year.startsAt > now
  await tx
    .update(schema.planYears)
    .set({ endsAt: waiting ? year.startsAt : now, updatedAt: now })
    .where(
      and(
        eq(schema.planYears.provider, year.provider),
        eq(schema.planYears.externalOrderId, year.externalOrderId),
      ),
    )
  await recordYearEnds(tx, year.userId, by, 'user', now)
  const plan = planName(year.planKey)
  return {
    affected: [year.userId],
    ended: waiting
      ? `Your year of ${plan} won’t start.`
      : `Your year of ${plan} has ended. Your account is on the free trial now, unless something else you paid for runs; your worlds stay.`,
  }
}

async function stopGift(tx: Tx, purchase: Purchase, by: string): Promise<Stopped> {
  if (purchase.gift === null) throw new NotFound('Purchase')
  const [row] = await tx
    .select()
    .from(schema.planGifts)
    .where(eq(schema.planGifts.id, purchase.gift.id))
    .for('update')
  if (row === undefined || row.voidedAt !== null)
    throw new AppError('changed_meanwhile', 'That gift was refunded a moment ago.')
  const redeemedBy = await voidGift(tx, row, { actor: by, source: 'user', action: 'billing.gift_withdrawn' })
  return {
    affected: redeemedBy === null ? [] : [redeemedBy],
    ended:
      redeemedBy === null
        ? 'Its code has stopped working.'
        : 'Its code has stopped working, and the time it gave the account that redeemed it has ended.',
  }
}

async function stopChipIn(
  tx: Tx,
  purchase: Purchase,
  assessed: Assessed,
  by: string,
  now: Date,
): Promise<Stopped> {
  const chipIn = purchase.chipIn
  if (chipIn === null) throw new NotFound('Purchase')
  const unplayed = Math.max(0, chipIn.milli - assessed.playedMilli)
  await tx
    .update(schema.chipIns)
    .set({ withdrawnMilli: unplayed, updatedAt: now })
    .where(
      and(
        eq(schema.chipIns.provider, chipIn.provider),
        eq(schema.chipIns.externalOrderId, chipIn.externalOrderId),
      ),
    )
  await tx.insert(schema.auditLog).values({
    actor: by,
    action: 'billing.chip_in_withdrawn',
    subjectType: 'server',
    subjectId: chipIn.serverId,
    data: { order: chipIn.externalOrderId, payer: chipIn.payerId, milli: unplayed },
  })
  return { affected: [], ended: `The ${tenths(unplayed)} hours of it nobody had played can’t be played now.` }
}
