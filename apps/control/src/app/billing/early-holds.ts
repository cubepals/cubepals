// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The price a month of a plan will charge, decided once for an account when its checkout page
 * opens: the plan's early price while there is room for it (`early-room.ts`), or the plan's own.
 * An early price is held for the account for an hour, taken from the room under the lock on the
 * controls row, so however many checkouts open at once, holds never take more than the room. One
 * hold per account: opening the page again keeps it, another plan or a year lets it go. A hold
 * counts against the room until it expires unpaid, or once paid until the room is set again,
 * which counts the subscription it became. A payment after its hold ran out is still the price
 * the person was shown, and is kept.
 *
 * It starts no checkout (`service.ts`) and moves no subscription (`plan-moves.ts`).
 */
import { HOUR_MS } from '@blockly/contracts/durations'
import { type Db, type Queryable, schema, type Tx } from '@blockly/db'
import { and, eq, gt, isNotNull, isNull, or, sum } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import type { DeploymentCapabilities } from '../capabilities.ts'
import type { EarlyProduct } from '../ports/optional.ts'
import { type EarlyRoom, readEarlyRoom, roomNow } from './early-room.ts'

/** How long a checkout page keeps the price it showed. */
const HELD_MS = HOUR_MS

const holds = schema.earlyHolds

/** What a month of a plan charges, as a checkout will sell it now. */
export interface PlanOffer {
  planKey: string
  priceCents: number
  includedUnits: number | null
  mostExtraUnits: number | null
  /** The early product it is sold on; null for the plan's own product and price. */
  productId: string | null
}

/** A month of the plan at its own price, from the plan table. */
export function planOwn(planKey: string): PlanOffer {
  const plan = entitlementsFor(planKey)
  return {
    planKey,
    priceCents: plan.monthlyPriceCents,
    includedUnits: plan.includedUnits,
    mostExtraUnits: plan.mostExtraUnits,
    productId: null,
  }
}

const offerOf = (
  product: Pick<EarlyProduct, 'planKey' | 'id' | 'priceCents' | 'includedUnits' | 'mostExtraUnits'>,
) => ({
  planKey: product.planKey,
  priceCents: product.priceCents,
  includedUnits: product.includedUnits,
  mostExtraUnits: product.mostExtraUnits,
  productId: product.id,
})

/** The points a checkout of the plan takes from the room; 0 for a plan with none. */
const pointsOf = (room: EarlyRoom, planKey: string): number =>
  planKey === 'core' || planKey === 'plus' ? room.points[planKey] : 0

/**
 * The holds that still count against the room: unpaid ones until they expire, and paid ones, however
 * long ago their hour ended, until the room is set from figures read after the payment, which count
 * the subscription it became.
 */
const counting = (room: EarlyRoom, now: Date) =>
  or(
    and(isNull(holds.paidAt), gt(holds.expiresAt, now)),
    room.setAt === null ? isNotNull(holds.paidAt) : gt(holds.paidAt, room.setAt),
  )

/** The room left for another hold now: what is set, less what counted holds took. */
async function roomLeft(q: Queryable, room: EarlyRoom, now: Date): Promise<number> {
  const [taken] = await q
    .select({ points: sum(holds.points) })
    .from(holds)
    .where(counting(room, now))
  return roomNow(room, now) - Number(taken?.points ?? 0)
}

export class EarlyHolds {
  readonly #db: Db
  readonly #caps: DeploymentCapabilities

  constructor(deps: { db: Db; capabilities: DeploymentCapabilities }) {
    this.#db = deps.db
    this.#caps = deps.capabilities
  }

  /**
   * What a month of `planKey` charges `userId` if they buy it now: the hold they have on it, a new
   * one where there is room, or the plan's own. An unpaid hold on another plan is let go. A paid
   * one stays while it counts against the room (the subscription it became isn't counted yet), and
   * meanwhile the account is offered the plan's own price. A provider that can't say what it sells
   * early leaves the plan's own price.
   */
  async offer(userId: string, planKey: string, now = new Date()): Promise<PlanOffer> {
    const product = await this.#earlyWhereRoom(planKey, now)
    return this.#db.transaction(async (tx) => {
      // The room and every hold on it are decided one checkout at a time.
      await tx
        .select({ id: schema.platformControls.id })
        .from(schema.platformControls)
        .where(eq(schema.platformControls.id, 1))
        .for('update')
      const [held] = await tx.select().from(holds).where(eq(holds.userId, userId))
      if (held && held.planKey === planKey && held.expiresAt > now && held.paidAt === null)
        return offerOf({ ...held, id: held.productId })
      const room = await readEarlyRoom(tx)
      if (held?.paidAt && (room.setAt === null || held.paidAt > room.setAt)) return planOwn(planKey)
      if (held) await tx.delete(holds).where(eq(holds.userId, userId))
      if (product === null) return planOwn(planKey)
      const points = pointsOf(room, planKey)
      if (points < 1 || (await roomLeft(tx, room, now)) < points) return planOwn(planKey)
      await tx.insert(holds).values({
        userId,
        planKey,
        productId: product.id,
        points,
        priceCents: product.priceCents,
        includedUnits: product.includedUnits,
        mostExtraUnits: product.mostExtraUnits,
        expiresAt: new Date(now.getTime() + HELD_MS),
      })
      return offerOf(product)
    })
  }

  /**
   * What a month of `planKey` would charge a new subscriber now, holding nothing: the early price
   * while the room left takes a checkout of it and `spare` more besides, or the plan's own.
   */
  async peek(planKey: string, spare = 0, now = new Date()): Promise<PlanOffer> {
    const product = await this.#earlyWhereRoom(planKey, now)
    if (product === null) return planOwn(planKey)
    const room = await readEarlyRoom(this.#db)
    const points = pointsOf(room, planKey)
    const left = await roomLeft(this.#db, room, now)
    return points >= 1 && left >= points * (1 + spare) ? offerOf(product) : planOwn(planKey)
  }

  /**
   * The account's unpaid hold goes: what it buys now is not a month of that plan. A paid one stays
   * until the room no longer counts it.
   */
  async release(userId: string): Promise<void> {
    await this.#db.delete(holds).where(and(eq(holds.userId, userId), isNull(holds.paidAt)))
  }

  /**
   * The plan's early product now, asked of the provider only while the room is set for a checkout
   * of the plan; null where it isn't, none is sold, or the provider can't say.
   */
  async #earlyWhereRoom(planKey: string, now: Date): Promise<EarlyProduct | null> {
    const billing = this.#caps.billing
    const room = await readEarlyRoom(this.#db)
    const points = pointsOf(room, planKey)
    if (!billing || points < 1 || roomNow(room, now) < points) return null
    try {
      return await billing.earlyProduct(planKey)
    } catch (error) {
      console.error(`billing: no early product for ${planKey}: ${(error as Error).message}`)
      return null
    }
  }
}

/**
 * The account's hold became a subscription on its product: from now it counts against the room
 * only until the room is set again, which counts the subscription.
 */
export async function holdPaid(tx: Tx, userId: string, productId: string, now: Date): Promise<void> {
  await tx
    .update(holds)
    .set({ paidAt: now })
    .where(and(eq(holds.userId, userId), eq(holds.productId, productId), isNull(holds.paidAt)))
}
