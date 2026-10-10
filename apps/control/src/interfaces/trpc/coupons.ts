import { CouponRef, CreateCouponInput } from '@blockly/contracts'
import { adminProcedure, router } from './trpc.ts'

/** Coupon codes for the paid plans, under `admin.coupons`: for admins only. */
export const coupons = router({
  list: adminProcedure.query(({ ctx }) => ctx.services.billing.coupons.list(ctx.actor)),
  create: adminProcedure
    .input(CreateCouponInput)
    .mutation(({ ctx, input }) => ctx.services.billing.coupons.create(ctx.actor, input)),
  delete: adminProcedure
    .input(CouponRef)
    .mutation(({ ctx, input }) => ctx.services.billing.coupons.delete(ctx.actor, input.couponId)),
})
