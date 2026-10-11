// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What platform admins call: accounts, listings, packs, the platform, servers and the audit log. */
import type { AccountDetailView, AccountView } from '@blockly/contracts'
import {
  AccountRef,
  AccountSearchInput,
  AdminRestoreInput,
  AdminStartInput,
  AdminTrashInput,
  AdminUntrashInput,
  AuditSearchInput,
  CreateTestAccountInput,
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
  ServerRef,
  StandingReasonInput,
  TestAccountInput,
  TrustProjectInput,
  UntrustProjectInput,
  WithdrawReleaseInput,
} from '@blockly/contracts'
import type { AccountDetail, AccountRow } from '../../app/accounts/queries.ts'
import { coupons } from './coupons.ts'
import { adminProcedure, router, sessionOf } from './trpc.ts'

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
  test: row.standing.testAccount,
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
  /** An account to test Cubepals with: confirmed, on the plan picked, and marked as a test account. */
  createTestAccount: adminProcedure
    .input(CreateTestAccountInput)
    .mutation(({ ctx, input }) =>
      ctx.services.accounts.createTestAccount(ctx.actor, input.email, input.plan),
    ),
  setTestAccount: adminProcedure
    .input(TestAccountInput)
    .mutation(({ ctx, input }) => ctx.services.accounts.setTestAccount(ctx.actor, input.userId, input.test)),
  /** Signed in as a test account, to play and test as it, until it switches back (`account.switchBack`). */
  useAs: adminProcedure
    .input(AccountRef)
    .mutation(({ ctx, input }) => ctx.services.impersonation.start(ctx.actor, input.userId, sessionOf(ctx))),
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
  /** Someone's server as an admin fixes it, the way its owner would: why goes in the audit log. */
  startServer: adminProcedure.input(AdminStartInput).mutation(async ({ ctx, input }) => {
    await ctx.services.repairs.start(ctx.actor, input.serverId, input.requestId, input.reason)
  }),
  trashServer: adminProcedure.input(AdminTrashInput).mutation(async ({ ctx, input }) => {
    await ctx.services.repairs.trash(ctx.actor, input.serverId, input.confirmName, input.reason)
  }),
  untrashServer: adminProcedure.input(AdminUntrashInput).mutation(async ({ ctx, input }) => {
    await ctx.services.repairs.untrash(ctx.actor, input.serverId, input.reason)
  }),
  /** Its backups, as its owner's backups page lists them, to restore one. */
  serverBackups: adminProcedure
    .input(ServerRef)
    .query(({ ctx, input }) => ctx.services.backupQueries.list(ctx.actor, input.serverId)),
  restoreBackup: adminProcedure.input(AdminRestoreInput).mutation(async ({ ctx, input }) => {
    await ctx.services.repairs.restore(ctx.actor, input.serverId, input, input.requestId, input.reason)
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
    .query(({ ctx, input }) => ctx.services.fleet.list(ctx.actor, { ...input, limit: 200 })),
  audit: adminProcedure
    .input(AuditSearchInput)
    .query(({ ctx, input }) => ctx.services.audit.search(ctx.actor, input)),
  coupons,
})
