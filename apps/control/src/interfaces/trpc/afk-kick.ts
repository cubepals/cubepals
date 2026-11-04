// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Server idle-kick choices and the reload message for an account page from the previous web release. */
import { SetAfkKickInput } from '@blockly/contracts'
import { accountAfkKickMoved } from '../../app/servers/afk-kick.ts'
import { authedProcedure } from './trpc.ts'

export const serverIdleKick = {
  setAfkKick: authedProcedure.input(SetAfkKickInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.afkKick.set(ctx.actor, input.serverId, input.minutes)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
}

export const accountIdleKick = {
  setAfkKick: authedProcedure
    .input(SetAfkKickInput.pick({ minutes: true }))
    .mutation(() => accountAfkKickMoved()),
}
