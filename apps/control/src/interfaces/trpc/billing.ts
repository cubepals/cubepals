// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { CheckoutInput } from '@blockly/contracts'
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
    }),
  ),
  /** A smaller plan from the month's end, the plan now staying until then (`plan-moves.ts`). */
  moveTo: authedProcedure
    .input(z.object({ plan: z.string().trim().min(1).max(40) }))
    .mutation(({ ctx, input }) => ctx.services.billing.moveToSmaller(ctx.actor, input.plan)),
  portal: authedProcedure.mutation(({ ctx }) => ctx.services.billing.customerPortal(ctx.actor)),
  /** What is owed and can no longer be retried, paid at once (`BillingService.settleBalance`). */
  settle: authedProcedure.mutation(({ ctx }) => ctx.services.billing.settleBalance(ctx.actor)),
  /** After a checkout: the provider's word now, before its webhook arrives. */
  refresh: authedProcedure.mutation(({ ctx }) => ctx.services.billing.refresh(ctx.actor)),
})
