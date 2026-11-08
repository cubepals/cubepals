import { InviteRef, JoinThroughInviteInput, PageRef, ServerRef } from '@blockly/contracts'
import { authedProcedure, publicProcedure, router } from './trpc.ts'

/** Sharing a server: its page, an invitation, and what the owner sees behind Share. */
export const sharing = router({
  /** Anyone may open a public page, signed in or not. */
  page: publicProcedure
    .input(PageRef)
    .query(({ ctx, input }) =>
      ctx.services.sharingQueries.page(input.slug, ctx.actor, { reactions: true, from: ctx.clientAddress }),
    ),
  invite: publicProcedure
    .input(InviteRef)
    .query(({ ctx, input }) => ctx.services.sharingQueries.invite(input.code, ctx.actor, ctx.clientAddress)),
  /** The invitee puts their own Minecraft name on the whitelist; no account needed. */
  join: publicProcedure
    .input(JoinThroughInviteInput)
    .mutation(({ ctx, input }) => ctx.services.sharing.joinThroughInvite(input.code, input.playerName)),
  own: authedProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.sharingQueries.share(ctx.actor, input.serverId)),
  /** The owner copied the invite link. */
  inviteShared: authedProcedure
    .input(ServerRef)
    .mutation(({ ctx, input }) => ctx.services.sharing.inviteShared(ctx.actor, input.serverId)),
  /** The invitation's page ran in someone's browser; it answers nothing either way. */
  inviteOpened: publicProcedure
    .input(InviteRef)
    .mutation(({ ctx, input }) =>
      ctx.services.sharing.inviteOpened(input.code, ctx.actor, ctx.clientAddress),
    ),
})
