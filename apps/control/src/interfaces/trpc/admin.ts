/** What platform admins call: accounts, listings, packs, the platform, servers and the audit log. */
import type { AccountDetailView, AccountView } from '@blockly/contracts'
import {
  AccountRef,
  AccountSearchInput,
  AuditSearchInput,
  CuratedReleaseInput,
  FleetSearchInput,
  LimitsInput,
  MaintenanceStopInput,
  ModerateInput,
  OperationRef,
  PlanInput,
  PlatformControlsInput,
  ReportRef,
  RestrictionsInput,
  StandingReasonInput,
  TrustProjectInput,
  UntrustProjectInput,
  WithdrawReleaseInput,
} from '@blockly/contracts'
import type { AccountDetail, AccountRow } from '../../app/accounts/queries.ts'
import { coupons } from './coupons.ts'
import { adminProcedure, router } from './trpc.ts'

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
    includedUnits: detail.standing.limitOverrides.includedUnits ?? null,
  },
  serverList: detail.serverList,
  history: detail.history.map((h) => ({ ...h, at: h.at.toISOString() })),
})

export const admin = router({
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
  /** Versions Cubepals tested past their catalog's listing, and templates whose plugins lag. */
  compatibility: adminProcedure.query(({ ctx }) => ctx.services.curation.compatibility(ctx.actor)),
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
  coupons,
})
