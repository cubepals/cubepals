// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's own choices about its players: its idle kick, and whether players are told when the
 * owner acts on them; putting back a file set aside for a start; and the reload message for an account page from the previous web release.
 */
import { PutAsideBackInput, SetAfkKickInput, SetTellPlayersInput } from '@blockly/contracts'
import { accountAfkKickMoved } from '../../app/servers/afk-kick.ts'
import { authedProcedure } from './trpc.ts'

export const serverIdleKick = {
  setAfkKick: authedProcedure.input(SetAfkKickInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.afkKick.set(ctx.actor, input.serverId, input.minutes)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  setTellPlayers: authedProcedure.input(SetTellPlayersInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.tellPlayers.set(ctx.actor, input.serverId, input.tell)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  /** A file set aside for a start goes back at the next one, or stays aside; it restarts nothing. */
  putBack: authedProcedure.input(PutAsideBackInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.setAside.putBack(ctx.actor, input.serverId, input.path, input.back)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
}

export const accountIdleKick = {
  setAfkKick: authedProcedure
    .input(SetAfkKickInput.pick({ minutes: true }))
    .mutation(() => accountAfkKickMoved()),
}
