/**
 * Coupon codes for the paid plans, as admins make, list and delete them. The billing provider
 * holds them and applies them when a customer types one at checkout; nothing about them is kept
 * here but the audit log's record of who made or deleted which.
 */
import type { CouponView, CreateCouponInput } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { type Actor, requestedBy } from '../actor.ts'
import type { DeploymentCapabilities } from '../capabilities.ts'
import { AppError, NotFound } from '../errors.ts'
import { BillingUnavailable, type Discount, DiscountRefused } from '../ports/optional.ts'

export class Coupons {
  readonly #db: Db
  readonly #caps: DeploymentCapabilities

  constructor(deps: { db: Db; capabilities: DeploymentCapabilities }) {
    this.#db = deps.db
    this.#caps = deps.capabilities
  }

  /** Every code for the plans, newest first, with how many times each was used. */
  async list(actor: Actor): Promise<CouponView[]> {
    const billing = this.#billing(actor)
    return (await ask(() => billing.discounts())).map(couponView)
  }

  async create(actor: Actor, input: CreateCouponInput): Promise<CouponView> {
    const billing = this.#billing(actor)
    const endsAt = input.endsAt === null ? null : new Date(input.endsAt)
    if (endsAt !== null && endsAt.getTime() <= Date.now())
      throw new AppError('invalid_choice', 'That end date has passed. Pick a later one.')
    const made = await ask(() =>
      billing.createDiscount({
        code: input.code,
        off: input.off,
        duration: input.duration,
        maxRedemptions: input.maxRedemptions,
        endsAt,
      }),
    )
    const coupon = couponView(made)
    await this.#audit(actor, 'billing.coupon_created', coupon)
    return coupon
  }

  /** Customers can't type it from now on. */
  async delete(actor: Actor, couponId: string): Promise<void> {
    const billing = this.#billing(actor)
    const deleted = await ask(() => billing.deleteDiscount(couponId))
    if (deleted === null) throw new NotFound('Coupon')
    await this.#audit(actor, 'billing.coupon_deleted', couponView(deleted))
  }

  /** The provider, for an admin; anyone else is told there is nothing here. */
  #billing(actor: Actor) {
    if (actor.kind !== 'admin') throw new NotFound('Coupons')
    if (this.#caps.billing === null)
      throw new AppError('deployment_unsupported', 'This deployment takes no payments, so it has no coupons.')
    return this.#caps.billing
  }

  async #audit(actor: Actor, action: string, coupon: CouponView): Promise<void> {
    await this.#db.insert(schema.auditLog).values({
      actor: requestedBy(actor),
      action,
      subjectType: 'coupon',
      subjectId: coupon.id,
      data: {
        code: coupon.code,
        off: coupon.off,
        duration: coupon.duration,
        maxRedemptions: coupon.maxRedemptions,
        endsAt: coupon.endsAt,
        redemptions: coupon.redemptions,
      },
    })
  }
}

/** The provider's answer, with its outage and its refusals said for the admin. */
async function ask<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    if (error instanceof BillingUnavailable)
      throw new AppError(
        'billing_unavailable',
        'Payments are not answering right now. Try again in a minute.',
      )
    if (error instanceof DiscountRefused)
      throw new AppError('invalid_choice', `Payments wouldn’t take that code: ${error.message}`)
    throw error
  }
}

const couponView = (discount: Discount): CouponView => ({
  id: discount.id,
  code: discount.code,
  off: discount.off,
  duration: discount.duration,
  maxRedemptions: discount.maxRedemptions,
  redemptions: discount.redemptions,
  endsAt: discount.endsAt?.toISOString() ?? null,
  createdAt: discount.createdAt.toISOString(),
})
