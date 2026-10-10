// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { AppErrorCode, PlatformCapabilities } from '@blockly/contracts'
import { initTRPC, TRPCError } from '@trpc/server'
import { ZodError } from 'zod'
import type { PlayerFaces } from '../../app/access/faces.ts'
import type { AccessService } from '../../app/access/service.ts'
import type { AccountQueries } from '../../app/accounts/queries.ts'
import type { AccountService } from '../../app/accounts/service.ts'
import type { UserActor } from '../../app/actor.ts'
import type { BackupQueries } from '../../app/backups/queries.ts'
import type { BackupService } from '../../app/backups/service.ts'
import type { BillingService } from '../../app/billing/service.ts'
import type { ConsoleService } from '../../app/console/service.ts'
import type { PackCuration } from '../../app/curation/service.ts'
import { AppError, inPlainWords, NotFound } from '../../app/errors.ts'
import type { GuestbookService } from '../../app/guestbook/service.ts'
import type { InsightService } from '../../app/insight/service.ts'
import type { ItemIcons } from '../../app/items/icons.ts'
import type { ListingQueries } from '../../app/listings/queries.ts'
import type { ListingService } from '../../app/listings/service.ts'
import type { ModQueries } from '../../app/mods/queries.ts'
import type { ModService } from '../../app/mods/service.ts'
import type { PackChanges } from '../../app/packs/changes.ts'
import type { PackService } from '../../app/packs/service.ts'
import type { PlatformAlerts } from '../../app/platform/alerts.ts'
import type { AuditQueries } from '../../app/platform/audit.ts'
import type { PlatformControlsService } from '../../app/platform/controls.ts'
import type { Fleet } from '../../app/platform/fleet.ts'
import type { ServerRepairs } from '../../app/platform/repairs.ts'
import type { StuckWork } from '../../app/platform/stuck.ts'
import type { PlayerService } from '../../app/players/service.ts'
import type { RealtimeTickets } from '../../app/ports/tickets.ts'
import type { RevisionService } from '../../app/revisions/service.ts'
import type { ServerQueries } from '../../app/servers/queries.ts'
import type { MinecraftServerService } from '../../app/servers/service.ts'
import type { SharingQueries } from '../../app/sharing/queries.ts'
import type { SharingService } from '../../app/sharing/service.ts'
import type { WorldQueries } from '../../app/worlds/queries.ts'
import type { WorldService } from '../../app/worlds/service.ts'

/** What procedures may call. Each procedure calls exactly one of these methods. */
export interface Services {
  servers: MinecraftServerService
  accounts: AccountService
  accountQueries: AccountQueries
  billing: BillingService
  listings: ListingService
  listingQueries: ListingQueries
  sharing: SharingService
  sharingQueries: SharingQueries
  guestbook: GuestbookService
  insight: InsightService
  revisions: RevisionService
  mods: ModService
  modQueries: ModQueries
  packs: PackService
  packChanges: PackChanges
  curation: PackCuration
  backups: BackupService
  backupQueries: BackupQueries
  worlds: WorldService
  worldQueries: WorldQueries
  queries: ServerQueries
  access: AccessService
  players: PlayerService
  items: ItemIcons
  faces: PlayerFaces
  console: ConsoleService
  tickets: RealtimeTickets
  realtime: { url: string; fallbackUrl: string; certificateSha256(): Promise<string | null> }
  platform: { capabilities: PlatformCapabilities }
  platformControls: PlatformControlsService
  stuck: StuckWork
  repairs: ServerRepairs
  fleet: Fleet
  alerts: PlatformAlerts
  audit: AuditQueries
}

export interface Context {
  actor: UserActor | null
  services: Services
}

const HTTP_CODES: Record<AppErrorCode, TRPCError['code']> = {
  deployment_unsupported: 'FORBIDDEN',
  platform_paused: 'SERVICE_UNAVAILABLE',
  account_suspended: 'FORBIDDEN',
  restricted: 'FORBIDDEN',
  email_unverified: 'FORBIDDEN',
  not_entitled: 'FORBIDDEN',
  limit_reached: 'FORBIDDEN',
  rate_limited: 'TOO_MANY_REQUESTS',
  payment_due: 'FORBIDDEN',
  invalid_transition: 'CONFLICT',
  slug_taken: 'CONFLICT',
  slug_invalid: 'BAD_REQUEST',
  confirmation_mismatch: 'BAD_REQUEST',
  unknown_player: 'NOT_FOUND',
  server_not_running: 'PRECONDITION_FAILED',
  command_refused: 'BAD_REQUEST',
  invalid_choice: 'BAD_REQUEST',
  invalid_settings: 'BAD_REQUEST',
  invalid_name: 'BAD_REQUEST',
  version_downgrade: 'CONFLICT',
  mods_conflict: 'CONFLICT',
  changed_meanwhile: 'CONFLICT',
  revoked_artifacts: 'CONFLICT',
  catalog_unavailable: 'SERVICE_UNAVAILABLE',
  invalid_upload: 'BAD_REQUEST',
  billing_unavailable: 'SERVICE_UNAVAILABLE',
}

/**
 * An input the contracts refused, in a sentence: tRPC's own message is the list of Zod issues as
 * JSON, which reached people on the console, the admin pages and notes. A message a schema wrote
 * for people is kept; Zod's own ("Too big: expected string to have <=256 characters") is not.
 */
export function inputInWords(error: ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'That doesn’t look right. Check it and try again.'
  if (!/^(Too (big|small)|Invalid|Expected|Required)/i.test(issue.message)) return issue.message
  const many = (n: number | bigint, one: string) => `${n} ${one}${Number(n) === 1 ? '' : 's'}`
  if (issue.code === 'too_big' && issue.origin === 'string')
    return `That’s too long: up to ${many(issue.maximum, 'character')}.`
  if (issue.code === 'too_big' && issue.origin === 'array') return `That’s too many: up to ${issue.maximum}.`
  if (issue.code === 'too_big') return `Pick a number up to ${issue.maximum}.`
  if (issue.code === 'too_small' && issue.origin === 'string')
    return Number(issue.minimum) <= 1
      ? 'That can’t be empty.'
      : `That’s too short: at least ${many(issue.minimum, 'character')}.`
  if (issue.code === 'too_small' && issue.origin === 'array') return 'Pick at least one.'
  if (issue.code === 'too_small') return `Pick a number of at least ${issue.minimum}.`
  return 'That doesn’t look right. Check it and try again.'
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const cause = error.cause
    return {
      ...shape,
      // What went wrong inside isn't for the person asking: a provider's raw answer once reached the
      // account page. They read whose side it was on; the detail is logged (http/api.ts).
      ...(error.code === 'INTERNAL_SERVER_ERROR' ? { message: inPlainWords(cause) } : {}),
      ...(cause instanceof ZodError ? { message: inputInWords(cause) } : {}),
      data: { ...shape.data, appCode: cause instanceof AppError ? cause.code : null },
    }
  },
})

/** Services speak in AppError and NotFound; this is the only place they become HTTP. */
const translateErrors = t.middleware(async ({ next }) => {
  const result = await next()
  if (!result.ok) {
    const cause = result.error.cause
    if (cause instanceof AppError)
      throw new TRPCError({ code: HTTP_CODES[cause.code], message: cause.message, cause })
    if (cause instanceof NotFound) throw new TRPCError({ code: 'NOT_FOUND', message: cause.message, cause })
  }
  return result
})

export const router = t.router
export const publicProcedure = t.procedure.use(translateErrors)
export const authedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (ctx.actor === null) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in first.' })
  return next({ ctx: { ...ctx, actor: ctx.actor } })
})

/**
 * For platform admins only, acting as `admin:<id>`. Anyone else is told there is nothing here,
 * the way a server they don't own looks.
 */
export const adminProcedure = authedProcedure.use(async ({ ctx, next }) => {
  if (!(await ctx.services.accounts.isAdmin(ctx.actor.userId)))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' })
  return next({ ctx: { ...ctx, actor: { kind: 'admin' as const, userId: ctx.actor.userId } } })
})
