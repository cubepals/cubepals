// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The billing procedures the web app calls: the plan table, a month's price held for the checkout
 * page, checkout, moves between plans, a price switch, the provider's portal and what is owed. What
 * each decides is `app/billing/`'s.
 */
import { CheckoutInput, OfferInput, type PlanOfferView } from '@blockly/contracts'
import { z } from 'zod'
import { publicPlans } from '../../app/accounts/queries.ts'
import { authedProcedure, publicProcedure, router } from './trpc.ts'

/** Paid plans: the table, checkout, moves between plans, the provider's portal and what is owed. */
export const billing = router({
  /** Every plan as the pricing page shows it, for anyone: the table everything enforces. */
  plans: publicProcedure.query(({ ctx }) => publicPlans(ctx.services.platform.capabilities)),
  checkout: authedProcedure.input(CheckoutInput).mutation(({ ctx, input }) =>
    ctx.services.billing.startCheckout(ctx.actor, input.plan, {
      term: input.term,
      reason: input.reason,
      consent: input.consent,
      ...(input.next === undefined ? {} : { next: input.next }),
      ...(input.priceCents === undefined ? {} : { priceCents: input.priceCents }),
    }),
  ),
  /** What a month of a plan charges if bought now, held while the checkout page is open. */
  offer: authedProcedure
    .input(OfferInput)
    .mutation(async ({ ctx, input }) => offerView(await ctx.services.billing.offer(ctx.actor, input.plan))),
  /** A smaller plan from the month's end, the plan now staying until then (`plan-moves.ts`). */
  moveTo: authedProcedure
    .input(
      z.object({ plan: z.string().trim().min(1).max(40), priceCents: z.number().int().min(0).optional() }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.billing.moveToSmaller(ctx.actor, input.plan, input.priceCents),
    ),
  /** The early price of the person's own plan, where their subscription could take it now; null otherwise. */
  switchable: authedProcedure.query(async ({ ctx }) => {
    const offer = await ctx.services.billing.switchable(ctx.actor)
    return offer === null ? null : offerView(offer)
  }),
  /** The person's subscription takes that price now, as their page showed it. */
  switchPrice: authedProcedure
    .input(z.object({ priceCents: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => ctx.services.billing.switchPrice(ctx.actor, input.priceCents)),
  portal: authedProcedure.mutation(({ ctx }) => ctx.services.billing.customerPortal(ctx.actor)),
  /** What is owed and can no longer be retried, paid at once (`BillingService.settleBalance`). */
  settle: authedProcedure.mutation(({ ctx }) => ctx.services.billing.settleBalance(ctx.actor)),
  /** After a checkout: the provider's word now, before its webhook arrives. */
  refresh: authedProcedure.mutation(({ ctx }) => ctx.services.billing.refresh(ctx.actor)),
})

/** A plan's offer as the page reads it: whether it is early is the account's own record, not a label. */
const offerView = (offer: {
  planKey: string
  priceCents: number
  includedUnits: number | null
  mostExtraUnits: number | null
  productId: string | null
}): PlanOfferView => ({
  plan: offer.planKey,
  priceCents: offer.priceCents,
  includedUnits: offer.includedUnits,
  mostExtraUnits: offer.mostExtraUnits,
  early: offer.productId !== null,
})
