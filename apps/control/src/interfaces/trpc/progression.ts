// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A server's switches for Offline world progression (`app/progression/`): the whole, and each part. */
import { SetProgressionInput, SetProgressionPartInput } from '@blockly/contracts'
import { authedProcedure } from './trpc.ts'

export const serverProgression = {
  /** Whether a server starts with Offline world progression; it restarts nothing. */
  setProgression: authedProcedure.input(SetProgressionInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.progression.set(ctx.actor, input.serverId, input.on)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  /** Whether one of its parts runs at the server's next start; it restarts nothing. */
  setProgressionPart: authedProcedure.input(SetProgressionPartInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.progression.setPart(ctx.actor, input.serverId, input.part, input.on)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
}
