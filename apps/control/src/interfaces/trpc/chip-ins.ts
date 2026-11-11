// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { ChipInInput, ServerRef, SetChipInInput } from '@blockly/contracts'
import { authedProcedure, router } from './trpc.ts'

/** Friends chipping in to a server: the payment from its page, and what its owner sees of it. */
export const chipIns = router({
  /** A checkout for hours on the server behind the page the payer is on, as they reached it. */
  start: authedProcedure.input(ChipInInput).mutation(async ({ ctx, input }) => {
    const reached = await ctx.services.sharingQueries.reach(input.to, ctx.actor)
    return ctx.services.billing.chipIns.start(
      ctx.actor,
      reached?.server ?? null,
      input.cents,
      reached?.page ?? '/',
      input.consent,
    )
  }),
  own: authedProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.billing.chipIns.view(ctx.actor, input.serverId)),
  setOpen: authedProcedure
    .input(SetChipInInput)
    .mutation(({ ctx, input }) =>
      ctx.services.billing.chipIns.setOpen(ctx.actor, input.serverId, input.open),
    ),
})
