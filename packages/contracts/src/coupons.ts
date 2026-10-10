/**
 * Coupon codes for the paid plans, as admins make and see them: what one takes off, for how
 * long, and how far it can go. Customers type them at checkout, where the billing provider
 * applies them.
 */
import { z } from 'zod'

const CouponOff = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), percent: z.number().int().min(1).max(100) }),
  // Whole cents, up to $10,000.
  z.object({ kind: z.literal('amount'), cents: z.number().int().min(1).max(1_000_000) }),
])

const CouponDuration = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once') }),
  z.object({ kind: z.literal('forever') }),
  z.object({ kind: z.literal('months'), months: z.number().int().min(1).max(36) }),
])

export const CreateCouponInput = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{3,32}$/, 'A code is 3 to 32 letters and digits, with no spaces.'),
  off: CouponOff,
  duration: CouponDuration,
  /** How many times it can be used in all; null for no limit. */
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullable(),
  /** When it stops working; null for never. */
  endsAt: z.iso.datetime({ offset: true }).nullable(),
})
export type CreateCouponInput = z.infer<typeof CreateCouponInput>

export const CouponRef = z.object({ couponId: z.string().min(1).max(100) })

/** A coupon as the admin page lists it, with how many times it was used. */
export interface CouponView {
  id: string
  code: string
  off: z.infer<typeof CouponOff>
  duration: z.infer<typeof CouponDuration>
  maxRedemptions: number | null
  redemptions: number
  endsAt: string | null
  createdAt: string
}
