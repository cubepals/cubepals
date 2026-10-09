import type { AccountDetailView, AccountOverviewView, AccountView, UploadStartView } from '@blockly/contracts'
import {
  AccountRef,
  AccountSearchInput,
  AddNoteInput,
  AddPlayerInput,
  AllowExtraPlayInput,
  ApplyModChangeInput,
  ArchiveBackupInput,
  AuditSearchInput,
  BackupRef,
  BanInput,
  BeginModUploadInput,
  BeginPackUploadInput,
  BeginWorldUploadInput,
  BrowseInput,
  ChangeAddressInput,
  ChangeAuthenticationInput,
  ChangePackInput,
  ChangeSettingsInput,
  ChangeVersionInput,
  CheckoutInput,
  CreateBackupInput,
  CreateServerInput,
  CreateWorldInput,
  CuratedReleaseInput,
  DeleteServerInput,
  FinishModUploadInput,
  FinishPackUploadInput,
  FinishWorldUploadInput,
  FleetSearchInput,
  GameModeInput,
  InviteRef,
  ItemIconsInput,
  JoinThroughInviteInput,
  JoinWaitlistInput,
  LimitsInput,
  ListingRef,
  MaintenanceStopInput,
  ModChangeInput,
  ModerateInput,
  ModSearchInput,
  ModUploadRef,
  NoteRef,
  NotesRef,
  OperationRef,
  PackImportRef,
  PackLinkInput,
  PackVersionsInput,
  PageRef,
  PlanInput,
  PlanVersionInput,
  PlatformControlsInput,
  PlayerInput,
  PowerInput,
  RecordSourceInput,
  RelocateInput,
  ReportListingInput,
  ReportRef,
  ResizeInput,
  RestoreBackupInput,
  RestrictionsInput,
  RollbackInput,
  SaveIdentityInput,
  SearchModpacksInput,
  ServerRef,
  SetAfkKickInput,
  SetCopyableInput,
  SetPublicInput,
  SetupRef,
  StandingReasonInput,
  StarInput,
  SuggestAddressInput,
  SwitchWorldInput,
  TeleportInput,
  TrustProjectInput,
  UntrustProjectInput,
  WaitingInput,
  WhitelistModeInput,
  WithdrawReleaseInput,
  WorldRef,
} from '@blockly/contracts'
import type { RealtimeConnectInfo } from '@blockly/contracts/realtime'
import { z } from 'zod'
import { type AccountDetail, type AccountRow, publicPlans } from '../../app/accounts/queries.ts'
import { insight } from './insight.ts'
import { adminProcedure, authedProcedure, publicProcedure, router } from './trpc.ts'

/** Each procedure: parse, get the actor, call one service method, return. Nothing else. */

const servers = router({
  list: authedProcedure.query(({ ctx }) => ctx.services.queries.list(ctx.actor)),
  get: authedProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.queries.get(ctx.actor, input.serverId)),
  createOptions: authedProcedure.query(({ ctx }) => ctx.services.queries.createOptions(ctx.actor)),
  /** What a template or another server's setup would make, before anyone commits to it. */
  searchModpacks: authedProcedure
    .input(SearchModpacksInput)
    .query(({ ctx, input }) => ctx.services.queries.searchModpacks(ctx.actor, input)),
  /** A link pasted where packs are searched: the pack it points at, or what to do instead. */
  packFromLink: authedProcedure
    .input(PackLinkInput)
    .query(({ ctx, input }) => ctx.services.queries.packFromLink(ctx.actor, input.url)),
  packVersions: authedProcedure
    .input(PackVersionsInput)
    .query(({ ctx, input }) => ctx.services.queries.packVersions(input.projectId)),
  setupPreview: authedProcedure
    .input(SetupRef)
    .query(({ ctx, input }) => ctx.services.queries.setupPreview(ctx.actor, input.from, input.partySize)),
  suggestAddress: authedProcedure
    .input(SuggestAddressInput)
    .query(({ ctx, input }) => ctx.services.queries.suggestAddress(ctx.actor, input)),
  create: authedProcedure.input(CreateServerInput).mutation(async ({ ctx, input }) => {
    const server = await ctx.services.servers.createMinecraftServer(ctx.actor, input)
    return ctx.services.queries.get(ctx.actor, server.id)
  }),
  start: authedProcedure.input(PowerInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.start(ctx.actor, input.serverId, input.requestId)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  stop: authedProcedure.input(PowerInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.stop(ctx.actor, input.serverId, input.requestId)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  restart: authedProcedure.input(PowerInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.restart(ctx.actor, input.serverId, input.requestId)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  retry: authedProcedure.input(PowerInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.retry(ctx.actor, input.serverId, input.requestId)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  delete: authedProcedure.input(DeleteServerInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.deleteServer(ctx.actor, input.serverId, input.confirmName)
  }),
  trash: authedProcedure.query(({ ctx }) => ctx.services.queries.trash(ctx.actor)),
  /** Servers gone for good whose downloadable backups are still kept. */
  purgedArchives: authedProcedure.query(({ ctx }) => ctx.services.queries.purgedArchives(ctx.actor)),
  undelete: authedProcedure.input(ServerRef).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.undeleteServer(ctx.actor, input.serverId)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  saveIdentity: authedProcedure.input(SaveIdentityInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.saveIdentity(ctx.actor, input.serverId, input)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  /** A new invite link; the old one stops working. */
  keep: authedProcedure.input(ServerRef).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.keep(ctx.actor, input.serverId)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  keepWorld: authedProcedure.input(ServerRef).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.keepWorld(ctx.actor, input.serverId)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  resetInvite: authedProcedure.input(ServerRef).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.resetInvite(ctx.actor, input.serverId)
    return ctx.services.sharingQueries.share(ctx.actor, input.serverId)
  }),
  changeAddress: authedProcedure.input(ChangeAddressInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.changeAddress(ctx.actor, input.serverId, input.slug)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  settingsOptions: authedProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.queries.settingsOptions(ctx.actor, input.serverId)),
  revisions: authedProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.queries.revisions(ctx.actor, input.serverId)),
  changeSettings: authedProcedure.input(ChangeSettingsInput).mutation(async ({ ctx, input }) => {
    await ctx.services.revisions.changeSettings(ctx.actor, input.serverId, input.settings, input.requestId, {
      acknowledgeRevoked: input.acknowledgeRevoked,
      version: input.version,
    })
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  /** Whether players are checked with Minecraft's account servers: its own change (§15.1). */
  changeAuthentication: authedProcedure.input(ChangeAuthenticationInput).mutation(async ({ ctx, input }) => {
    await ctx.services.revisions.changeAuthentication(
      ctx.actor,
      input.serverId,
      input.onlineMode,
      input.requestId,
      { version: input.version },
    )
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  /** What a new game version or server type does to the mods, before choosing it. */
  planVersion: authedProcedure.input(PlanVersionInput).query(async ({ ctx, input }) =>
    ctx.services.modQueries.planView(
      await ctx.services.mods.planVersion(ctx.actor, input.serverId, {
        gameVersion: input.gameVersion,
        loader: input.loader,
      }),
    ),
  ),
  changeVersion: authedProcedure.input(ChangeVersionInput).mutation(async ({ ctx, input }) => {
    await ctx.services.mods.changeVersion(
      ctx.actor,
      input.serverId,
      { gameVersion: input.gameVersion, loader: input.loader, onPaper: input.onPaper },
      input.expected,
      input.requestId,
      { acknowledgeRevoked: input.acknowledgeRevoked, version: input.version },
    )
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  resize: authedProcedure.input(ResizeInput).mutation(async ({ ctx, input }) => {
    await ctx.services.revisions.resize(ctx.actor, input.serverId, input.partySize, input.requestId, {
      acknowledgeRevoked: input.acknowledgeRevoked,
      version: input.version,
    })
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  relocate: authedProcedure.input(RelocateInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.relocate(ctx.actor, input.serverId, input.regionKey, input.requestId)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  rollback: authedProcedure.input(RollbackInput).mutation(async ({ ctx, input }) => {
    await ctx.services.revisions.rollback(ctx.actor, input.serverId, input.revisionId, input.requestId, {
      acknowledgeRevoked: input.acknowledgeRevoked,
      version: input.version,
    })
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
})

const backups = router({
  list: authedProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.backupQueries.list(ctx.actor, input.serverId)),
  create: authedProcedure
    .input(CreateBackupInput)
    .mutation(({ ctx, input }) =>
      ctx.services.backups.createBackup(ctx.actor, input.serverId, input.requestId),
    ),
  delete: authedProcedure
    .input(BackupRef)
    .mutation(({ ctx, input }) =>
      ctx.services.backups.deleteBackup(ctx.actor, input.serverId, input.backupId),
    ),
  archive: authedProcedure
    .input(ArchiveBackupInput)
    .mutation(({ ctx, input }) =>
      ctx.services.backups.archiveBackup(ctx.actor, input.serverId, input.backupId, input.requestId),
    ),
  beginUpload: authedProcedure
    .input(BeginWorldUploadInput)
    .mutation(({ ctx, input }) => ctx.services.backups.beginWorldUpload(ctx.actor, input.serverId, input)),
  finishUpload: authedProcedure.input(FinishWorldUploadInput).mutation(async ({ ctx, input }) => {
    const backup = await ctx.services.backups.finishWorldUpload(
      ctx.actor,
      input.serverId,
      input.ticket,
      input.name,
    )
    return { backupId: backup.id }
  }),
  /**
   * A mutation: every call makes a new link, and none may be cached. A world download being made
   * says so, and `downloadState` says when it's ready.
   */
  download: authedProcedure
    .input(BackupRef)
    .mutation(({ ctx, input }) =>
      ctx.services.backups.downloads.ask(ctx.actor, input.serverId, input.backupId),
    ),
  downloadState: authedProcedure
    .input(BackupRef)
    .query(({ ctx, input }) =>
      ctx.services.backups.downloads.state(ctx.actor, input.serverId, input.backupId),
    ),
  restore: authedProcedure.input(RestoreBackupInput).mutation(async ({ ctx, input }) => {
    await ctx.services.backups.restoreBackup(ctx.actor, input.serverId, input.backupId, input.requestId, {
      withConfiguration: input.withConfiguration,
      acknowledgeRevoked: input.acknowledgeRevoked,
    })
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
})

const worlds = router({
  list: authedProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.worldQueries.list(ctx.actor, input.serverId)),
  create: authedProcedure.input(CreateWorldInput).mutation(async ({ ctx, input }) => {
    await ctx.services.worlds.createWorld(
      ctx.actor,
      input.serverId,
      { name: input.name, seed: input.seed, levelType: input.levelType, hardcore: input.hardcore },
      input.requestId,
    )
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  switch: authedProcedure.input(SwitchWorldInput).mutation(async ({ ctx, input }) => {
    await ctx.services.worlds.switchWorld(ctx.actor, input.serverId, input.worldId, input.requestId)
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  delete: authedProcedure
    .input(WorldRef)
    .mutation(({ ctx, input }) => ctx.services.worlds.deleteWorld(ctx.actor, input.serverId, input.worldId)),
})

const mods = router({
  list: authedProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.modQueries.list(ctx.actor, input.serverId)),
  search: authedProcedure.input(ModSearchInput).query(async ({ ctx, input }) => {
    const [found, installed] = await Promise.all([
      ctx.services.mods.search(ctx.actor, input.serverId, {
        text: input.text,
        offset: input.offset,
        limit: 20,
      }),
      ctx.services.modQueries.list(ctx.actor, input.serverId),
    ])
    const ids = new Set(installed.mods.map((m) => m.id))
    return {
      total: found.total,
      hits: found.hits.map((hit) => ({
        projectId: hit.projectId,
        slug: hit.slug,
        name: hit.name,
        summary: hit.summary,
        iconUrl: hit.iconUrl,
        downloads: hit.downloads,
        installed: ids.has(hit.projectId),
        runsOnServers: hit.runsOnServers,
      })),
    }
  }),
  plan: authedProcedure
    .input(ModChangeInput)
    .query(async ({ ctx, input }) =>
      ctx.services.modQueries.planView(await ctx.services.mods.plan(ctx.actor, input.serverId, input)),
    ),
  change: authedProcedure.input(ApplyModChangeInput).mutation(async ({ ctx, input }) => {
    await ctx.services.mods.apply(ctx.actor, input.serverId, input, input.expected, input.requestId, {
      acknowledgeRevoked: input.acknowledgeRevoked,
    })
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
  uploads: authedProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.modQueries.uploads(ctx.actor, input.serverId)),
  beginUpload: authedProcedure
    .input(BeginModUploadInput)
    .mutation(async ({ ctx, input }): Promise<UploadStartView> => {
      const start = await ctx.services.mods.beginUpload(ctx.actor, input.serverId, input)
      return start.kind === 'known' ? { kind: 'known', uploadId: start.upload.id } : start
    }),
  finishUpload: authedProcedure.input(FinishModUploadInput).mutation(async ({ ctx, input }) => {
    const upload = await ctx.services.mods.finishUpload(ctx.actor, input.serverId, input.ticket)
    return { uploadId: upload.id }
  }),
  deleteUpload: authedProcedure
    .input(ModUploadRef)
    .mutation(({ ctx, input }) => ctx.services.mods.deleteUpload(ctx.actor, input.serverId, input.uploadId)),
  /** Another version of the server's pack, or a pack its owner uploaded in its place. */
  changePack: authedProcedure.input(ChangePackInput).mutation(async ({ ctx, input }) => {
    await ctx.services.packChanges.change(ctx.actor, input.serverId, input.to, input.requestId, {
      version: input.version,
      acknowledgeRevoked: input.acknowledgeRevoked,
    })
    return ctx.services.queries.get(ctx.actor, input.serverId)
  }),
})

/** Packs people bring in a file: sent, read and built off the request, then picked like any pack. */
const packs = router({
  beginUpload: authedProcedure
    .input(BeginPackUploadInput)
    .mutation(({ ctx, input }) => ctx.services.packs.beginUpload(ctx.actor, input)),
  finishUpload: authedProcedure
    .input(FinishPackUploadInput)
    .mutation(({ ctx, input }) => ctx.services.packs.finishUpload(ctx.actor, input.ticket)),
  import: authedProcedure
    .input(PackImportRef)
    .query(({ ctx, input }) => ctx.services.packs.view(ctx.actor, input.importId)),
})

const access = router({
  get: authedProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.queries.access(ctx.actor, input.serverId)),
  /** The page was opened: bring in what changed in game (deduped per minute). */
  refresh: authedProcedure
    .input(ServerRef)
    .mutation(({ ctx, input }) => ctx.services.access.refresh(ctx.actor, input.serverId)),
  setWhitelist: authedProcedure
    .input(WhitelistModeInput)
    .mutation(({ ctx, input }) =>
      ctx.services.access.setWhitelistEnabled(ctx.actor, input.serverId, input.enabled),
    ),
  addToWhitelist: authedProcedure
    .input(AddPlayerInput)
    .mutation(({ ctx, input }) =>
      ctx.services.access.add(ctx.actor, input.serverId, 'whitelist', input.name),
    ),
  removeFromWhitelist: authedProcedure
    .input(PlayerInput)
    .mutation(({ ctx, input }) =>
      ctx.services.access.remove(ctx.actor, input.serverId, 'whitelist', input.playerUuid),
    ),
  op: authedProcedure
    .input(AddPlayerInput)
    .mutation(({ ctx, input }) => ctx.services.access.add(ctx.actor, input.serverId, 'operator', input.name)),
  deop: authedProcedure
    .input(PlayerInput)
    .mutation(({ ctx, input }) =>
      ctx.services.access.remove(ctx.actor, input.serverId, 'operator', input.playerUuid),
    ),
  ban: authedProcedure
    .input(BanInput)
    .mutation(({ ctx, input }) =>
      ctx.services.access.add(ctx.actor, input.serverId, 'ban', input.name, input.reason),
    ),
  pardon: authedProcedure
    .input(PlayerInput)
    .mutation(({ ctx, input }) =>
      ctx.services.access.remove(ctx.actor, input.serverId, 'ban', input.playerUuid),
    ),
})

/** One player's page: what they are up to, and what the owner can do for them. */
const players = router({
  get: authedProcedure
    .input(PlayerInput)
    .query(({ ctx, input }) => ctx.services.players.view(ctx.actor, input.serverId, input.playerUuid)),
  teleport: authedProcedure
    .input(TeleportInput)
    .mutation(({ ctx, input }) =>
      ctx.services.players.teleport(ctx.actor, input.serverId, input.playerUuid, input.to),
    ),
  setGameMode: authedProcedure
    .input(GameModeInput)
    .mutation(({ ctx, input }) =>
      ctx.services.players.setGameMode(ctx.actor, input.serverId, input.playerUuid, input.mode),
    ),
  /** How each item in an inventory is drawn, from the release's own art. */
  icons: authedProcedure
    .input(ItemIconsInput)
    .query(({ ctx, input }) => ctx.services.items.icons(input.gameVersion, input.ids)),
  cancel: authedProcedure
    .input(WaitingInput)
    .mutation(({ ctx, input }) =>
      ctx.services.players.cancel(ctx.actor, input.serverId, input.playerUuid, input.kind),
    ),
})

const consoleRoutes = router({
  run: authedProcedure
    .input(z.object({ serverId: z.uuid(), command: z.string().min(1).max(256) }))
    .mutation(async ({ ctx, input }) => ({
      output: await ctx.services.console.run(ctx.actor, input.serverId, input.command),
    })),
})

const realtime = router({
  connectInfo: authedProcedure.query(
    async ({ ctx }): Promise<RealtimeConnectInfo> => ({
      url: ctx.services.realtime.url,
      fallbackUrl: ctx.services.realtime.fallbackUrl,
      certificateSha256: await ctx.services.realtime.certificateSha256(),
      ticket: await ctx.services.tickets.issue(ctx.actor.userId),
    }),
  ),
})

const account = router({
  me: authedProcedure.query(({ ctx }) => ctx.services.accountQueries.me(ctx.actor)),
  overview: authedProcedure.query(async ({ ctx }): Promise<AccountOverviewView> => {
    const overview = await ctx.services.accountQueries.overview(ctx.actor)
    const billed = overview.plan.billed
    return {
      ...overview,
      entitlements: {
        ...overview.entitlements,
        allowedMemoryTiers: [...overview.entitlements.allowedMemoryTiers],
        sizeLabels: [...overview.sizeLabels],
        allowedLoaders: [...overview.entitlements.allowedLoaders],
      },
      plans: overview.plans.map((p) => ({
        key: p.key,
        entitlements: {
          ...p.entitlements,
          allowedMemoryTiers: [...p.entitlements.allowedMemoryTiers],
          sizeLabels: [...p.sizeLabels],
          allowedLoaders: [...p.entitlements.allowedLoaders],
        },
      })),
      plan: {
        key: overview.plan.key,
        billed:
          billed === null
            ? null
            : {
                ...billed,
                periodEnd: billed.periodEnd?.toISOString() ?? null,
                pastDueUntil: billed.pastDueUntil?.toISOString() ?? null,
              },
      },
    }
  }),
  /** Where the account came from, from the link that brought it; kept once, after sign-up. */
  recordSource: authedProcedure
    .input(RecordSourceInput)
    .mutation(({ ctx, input }) => ctx.services.accounts.recordSource(ctx.actor, input.source, input)),
  setAfkKick: authedProcedure.input(SetAfkKickInput).mutation(async ({ ctx, input }) => {
    await ctx.services.accounts.setAfkKick(ctx.actor, input.minutes)
    return ctx.services.accountQueries.overview(ctx.actor)
  }),
  /** The owner's own spending cap: what Blockly may charge past the included block. */
  allowExtraPlay: authedProcedure.input(AllowExtraPlayInput).mutation(async ({ ctx, input }) => {
    await ctx.services.accounts.allowExtraPlay(ctx.actor, input.units)
    return ctx.services.accountQueries.overview(ctx.actor)
  }),
})

const billing = router({
  /** Every plan as the pricing page shows it, for anyone: the table everything enforces. */
  plans: publicProcedure.query(() => publicPlans()),
  checkout: authedProcedure.input(CheckoutInput).mutation(({ ctx, input }) =>
    ctx.services.billing.startCheckout(ctx.actor, input.plan, {
      reason: input.reason,
      consent: input.consent,
      ...(input.next === undefined ? {} : { next: input.next }),
    }),
  ),
  portal: authedProcedure.mutation(({ ctx }) => ctx.services.billing.customerPortal(ctx.actor)),
  /** After a checkout: the provider's word now, before its webhook arrives. */
  refresh: authedProcedure.mutation(({ ctx }) => ctx.services.billing.refresh(ctx.actor)),
})

const accountView = (row: AccountRow): AccountView => ({
  userId: row.userId,
  name: row.name,
  email: row.email,
  emailVerified: row.emailVerified,
  createdAt: row.createdAt.toISOString(),
  status: row.standing.status,
  reason: row.standing.reason,
  plan: row.standing.plan,
  admin: row.admin,
  servers: row.servers,
})

const accountDetailView = (detail: AccountDetail): AccountDetailView => ({
  ...accountView(detail),
  plans: detail.plans,
  restrictions: {
    provisioning: detail.standing.restrictions.provisioning === true,
    publicListing: detail.standing.restrictions.publicListing === true,
    consoleCommands: detail.standing.restrictions.consoleCommands === true,
  },
  limits: {
    maxServers: detail.standing.limitOverrides.maxServers ?? null,
    maxRunning: detail.standing.limitOverrides.maxRunning ?? null,
  },
  serverList: detail.serverList,
  history: detail.history.map((h) => ({ ...h, at: h.at.toISOString() })),
})

const admin = router({
  accounts: adminProcedure.input(AccountSearchInput).query(async ({ ctx, input }) => {
    const found = await ctx.services.accountQueries.list(ctx.actor, { ...input, limit: 50 })
    return { total: found.total, accounts: found.accounts.map(accountView) }
  }),
  account: adminProcedure
    .input(AccountRef)
    .query(async ({ ctx, input }) =>
      accountDetailView(await ctx.services.accountQueries.get(ctx.actor, input.userId)),
    ),
  suspend: adminProcedure
    .input(StandingReasonInput)
    .mutation(({ ctx, input }) => ctx.services.accounts.suspend(ctx.actor, input.userId, input.reason)),
  reinstate: adminProcedure
    .input(AccountRef)
    .mutation(({ ctx, input }) => ctx.services.accounts.reinstate(ctx.actor, input.userId)),
  terminate: adminProcedure
    .input(StandingReasonInput)
    .mutation(({ ctx, input }) => ctx.services.accounts.terminate(ctx.actor, input.userId, input.reason)),
  setRestrictions: adminProcedure
    .input(RestrictionsInput)
    .mutation(({ ctx, input }) => ctx.services.accounts.setRestrictions(ctx.actor, input.userId, input)),
  setPlan: adminProcedure
    .input(PlanInput)
    .mutation(({ ctx, input }) => ctx.services.accounts.setPlan(ctx.actor, input.userId, input.plan)),
  setLimits: adminProcedure
    .input(LimitsInput)
    .mutation(({ ctx, input }) => ctx.services.accounts.setLimits(ctx.actor, input.userId, input)),
  grantAdmin: adminProcedure
    .input(AccountRef)
    .mutation(({ ctx, input }) => ctx.services.accounts.grantAdmin(ctx.actor, input.userId)),
  revokeAdmin: adminProcedure
    .input(AccountRef)
    .mutation(({ ctx, input }) => ctx.services.accounts.revokeAdmin(ctx.actor, input.userId)),
  reports: adminProcedure.query(({ ctx }) => ctx.services.listingQueries.reports(ctx.actor)),
  removedListings: adminProcedure.query(({ ctx }) => ctx.services.listingQueries.removed(ctx.actor)),
  moderate: adminProcedure
    .input(ModerateInput)
    .mutation(({ ctx, input }) =>
      ctx.services.listings.moderate(ctx.actor, input.serverId, input.action, input.note),
    ),
  dismissReport: adminProcedure
    .input(ReportRef)
    .mutation(({ ctx, input }) => ctx.services.listings.dismissReport(ctx.actor, input.reportId)),
  allowlist: adminProcedure.query(({ ctx }) => ctx.services.listingQueries.allowlist(ctx.actor)),
  trust: adminProcedure
    .input(TrustProjectInput)
    .mutation(({ ctx, input }) =>
      ctx.services.listings.trustProject(ctx.actor, input.projectId, input.note ?? null),
    ),
  untrust: adminProcedure
    .input(UntrustProjectInput)
    .mutation(({ ctx, input }) =>
      ctx.services.listings.untrustProject(ctx.actor, input.catalog, input.projectId),
    ),
  /** Packs Blockly offers by name, and where each reviewed release stands (docs/modpack-templates.md). */
  curatedPacks: adminProcedure.query(({ ctx }) => ctx.services.curation.review(ctx.actor)),
  publishRelease: adminProcedure
    .input(CuratedReleaseInput)
    .mutation(({ ctx, input }) => ctx.services.curation.publish(ctx.actor, input)),
  withdrawRelease: adminProcedure
    .input(WithdrawReleaseInput)
    .mutation(({ ctx, input }) =>
      ctx.services.curation.withdraw(ctx.actor, { key: input.key, version: input.version }, input.reason),
    ),
  retryRelease: adminProcedure
    .input(CuratedReleaseInput)
    .mutation(({ ctx, input }) => ctx.services.curation.retry(ctx.actor, input)),
  alerts: adminProcedure.query(({ ctx }) => ctx.services.alerts.active(ctx.actor)),
  platform: adminProcedure.query(({ ctx }) => ctx.services.platformControls.view(ctx.actor)),
  setPlatform: adminProcedure
    .input(PlatformControlsInput)
    .mutation(({ ctx, input }) => ctx.services.platformControls.set(ctx.actor, input)),
  refreshCatalog: adminProcedure.mutation(({ ctx }) =>
    ctx.services.platformControls.refreshCatalog(ctx.actor),
  ),
  stopForMaintenance: adminProcedure.input(MaintenanceStopInput).mutation(async ({ ctx, input }) => {
    await ctx.services.servers.stopForMaintenance(ctx.actor, input.serverId, input.requestId, input.reason)
  }),
  stuck: adminProcedure.query(({ ctx }) => ctx.services.stuck.list(ctx.actor)),
  retryOperation: adminProcedure
    .input(OperationRef)
    .mutation(({ ctx, input }) => ctx.services.stuck.retry(ctx.actor, input.operationId)),
  discardOperation: adminProcedure
    .input(OperationRef)
    .mutation(({ ctx, input }) => ctx.services.stuck.discard(ctx.actor, input.operationId)),
  /** Every server, as an operator finds it at the provider. */
  servers: adminProcedure
    .input(FleetSearchInput)
    .query(({ ctx, input }) => ctx.services.fleet.list(ctx.actor, { ...input, limit: 50 })),
  audit: adminProcedure
    .input(AuditSearchInput)
    .query(({ ctx, input }) => ctx.services.audit.search(ctx.actor, input)),
})

const listings = router({
  /** The directory: anyone may read it, signed in or not. */
  browse: publicProcedure
    .input(BrowseInput)
    .query(({ ctx, input }) => ctx.services.listingQueries.browse(input, ctx.actor)),
  get: publicProcedure
    .input(ListingRef)
    .query(({ ctx, input }) => ctx.services.listingQueries.detail(input.serverId, ctx.actor)),
  own: authedProcedure
    .input(ListingRef)
    .query(({ ctx, input }) => ctx.services.listingQueries.own(ctx.actor, input.serverId)),
  setPublic: authedProcedure.input(SetPublicInput).mutation(async ({ ctx, input }) => {
    await ctx.services.listings.setPublic(ctx.actor, input.serverId, input.public)
    return ctx.services.sharingQueries.share(ctx.actor, input.serverId)
  }),
  setCopyable: authedProcedure.input(SetCopyableInput).mutation(async ({ ctx, input }) => {
    await ctx.services.listings.setCopyable(ctx.actor, input.serverId, input.copyable)
    return ctx.services.sharingQueries.share(ctx.actor, input.serverId)
  }),
  report: authedProcedure
    .input(ReportListingInput)
    .mutation(({ ctx, input }) => ctx.services.listings.report(ctx.actor, input.serverId, input.reason)),
  /** Stars and notes are for people signed in; anyone else is only asked to sign in. */
  star: authedProcedure
    .input(StarInput)
    .mutation(({ ctx, input }) => ctx.services.guestbook.star(ctx.actor, input.serverId, input.starred)),
  notes: authedProcedure
    .input(NotesRef)
    .query(({ ctx, input }) => ctx.services.guestbook.notes(ctx.actor, input.serverId)),
  addNote: authedProcedure
    .input(AddNoteInput)
    .mutation(({ ctx, input }) => ctx.services.guestbook.addNote(ctx.actor, input.serverId, input.body)),
  deleteNote: authedProcedure
    .input(NoteRef)
    .mutation(({ ctx, input }) => ctx.services.guestbook.deleteNote(ctx.actor, input.noteId)),
})

/** Sharing a server: its page, an invitation, and what the owner sees behind Share. */
const sharing = router({
  /** Anyone may open a public page, signed in or not. */
  page: publicProcedure
    .input(PageRef)
    .query(({ ctx, input }) => ctx.services.sharingQueries.page(input.slug, ctx.actor, { reactions: true })),
  invite: publicProcedure
    .input(InviteRef)
    .query(({ ctx, input }) => ctx.services.sharingQueries.invite(input.code, ctx.actor)),
  /** The invitee puts their own Minecraft name on the whitelist; no account needed. */
  join: publicProcedure
    .input(JoinThroughInviteInput)
    .mutation(({ ctx, input }) => ctx.services.sharing.joinThroughInvite(input.code, input.playerName)),
  own: authedProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.sharingQueries.share(ctx.actor, input.serverId)),
})

const platform = router({
  capabilities: authedProcedure.query(({ ctx }) => ctx.services.platform.capabilities),
  /** An address left to hear when sign-up has room again; no account needed. */
  joinWaitlist: publicProcedure
    .input(JoinWaitlistInput)
    .mutation(({ ctx, input }) => ctx.services.accounts.joinWaitlist(input.email, input.source)),
})

export const appRouter = router({
  servers,
  mods,
  packs,
  backups,
  worlds,
  access,
  players,
  console: consoleRoutes,
  realtime,
  platform,
  account,
  admin,
  billing,
  listings,
  sharing,
  insight,
})
export type AppRouter = typeof appRouter
