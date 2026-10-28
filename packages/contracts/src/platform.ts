// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'

/** What this Blockly deployment can do at all, whoever is asking (§15.4). */
export interface PlatformCapabilities {
  /** Durable archives: downloads, uploads and backups that outlive a server. */
  archives: boolean
  /** Paid plans. Without it, plans are set by an admin. */
  billing: boolean
  /** Paid plans billing has no product for: not for sale yet. Empty where there is no billing. */
  unsoldPlans: string[]
}

// ─── What admins run the platform with ──────────────────────────────────────────────────────

/** The kill switches and global caps (§4 PlatformControls), with who last changed them. */
export interface PlatformControlsView {
  provisioningEnabled: boolean
  startsEnabled: boolean
  publicListingEnabled: boolean
  uploadsEnabled: boolean
  storingEnabled: boolean
  expiringEnabled: boolean
  maxServers: number
  maxRunningServers: number
  /** Free accounts before sign-up is full and offers a waitlist. */
  maxFreeAccounts: number
  /** What a day may cost, in US cents, before the spend watchdog pauses starts and creation. */
  dailySpendLimitCents: number
  /**
   * Creates the platform closed by itself for want of room, apart from `provisioningEnabled`: for
   * free plans or everyone, what ran out, and since when. Null while they are open.
   */
  createsFull: { for: 'free' | 'everyone'; because: string; since: string } | null
  updatedBy: string | null
  /** Who that is, when it was a person. */
  updatedByEmail: string | null
  updatedAt: string
  /** Against the caps: live servers, and how many run. */
  usage: { servers: number; running: number }
  /** Against `maxFreeAccounts`: accounts on the free plan, and addresses left on the waitlist. */
  signups: { freeAccounts: number; waitlist: number }
  /** Today's spend as the watchdog last worked it out (UTC day); null before its first pass. */
  spend: SpendView | null
  /** When the mod catalog last answered a refresh; null before anything was tracked. */
  catalogHeardAt: string | null
  /** The most servers the hosting provider can hold, by its own limit (§19.12); null when unlimited. */
  serverCeiling: number | null
  /** The play domains, the primary first, with the joins the edge saw through each (§11). */
  playDomains: { domain: string; alias: boolean; joins: number; lastJoinAt: string | null }[]
  /**
   * The runtime keyring (§11): the current version, the earlier ones still accepted, and how
   * many servers holding compute last booted on an earlier one. Those can go once that is 0.
   */
  runtimeKeys: { version: number; previousVersions: number[]; behind: number }
  /**
   * The room for checkouts at an early price, as last set from outside: the room and what a
   * checkout of each plan takes, in points, until when it holds and when it was set; whether an
   * admin has it closed; and the checkout pages holding an early price now, with what they took.
   */
  earlyRoom: {
    roomPoints: number
    points: { core: number; plus: number }
    validUntil: string | null
    setAt: string | null
    closedSince: string | null
    closedBy: string | null
    holds: { count: number; points: number }
  }
}

export const EarlyClosedInput = z.object({ closed: z.boolean() })

/** One UTC day's cost, from what the control plane recorded. */
export interface SpendView {
  /** `YYYY-MM-DD`, UTC. */
  day: string
  /** Everything: the parts below added up, in US cents. */
  cents: number
  computeCents: number
  /** Compute the provider ran that no running server here accounts for. */
  strayCents: number
  storageCents: number
  strayMachines: number
  runningServers: number
  computedAt: string
  /** When the day passed its limit and the watchdog paused starts and creation; null if not. */
  trippedAt: string | null
}

export const PlatformControlsInput = z.object({
  provisioningEnabled: z.boolean(),
  startsEnabled: z.boolean(),
  publicListingEnabled: z.boolean(),
  uploadsEnabled: z.boolean(),
  storingEnabled: z.boolean(),
  expiringEnabled: z.boolean(),
  maxServers: z.number().int().min(0).max(100_000),
  maxRunningServers: z.number().int().min(0).max(100_000),
  maxFreeAccounts: z.number().int().min(0).max(100_000),
  // Whole dollars up to $999,999 a day, as the admin form takes them.
  dailySpendLimitCents: z.number().int().min(0).max(99_999_900),
})

/**
 * Whether servers put to sleep on Fly are suspended, which wakes them in about a second, or
 * stopped, which boots them in about 45 s.
 */
export interface FlySuspendView {
  on: boolean
  /** `stored` when an admin set it; `default` when FLY_SUSPEND decides. */
  source: 'stored' | 'default'
  /** What FLY_SUSPEND gives when nothing is stored. */
  default: boolean
}

/** On or off, or null to leave it to FLY_SUSPEND again. */
export const FlySuspendInput = z.object({ on: z.boolean().nullable() })

export const ALERT_KEYS = [
  'blocked_operations',
  'purge_overdue',
  'catalog_stale',
  'worlds_outgrow_plan',
  'extra_play_unsent',
  'extra_play_waiting',
  'billing_order_unknown',
  'free_accounts_linked',
  'edge_behind',
  'resumes_hung',
  'hosts_refused',
  'storage_kept',
  'jobs_failing',
  'spend_unread',
  'realtime_certificate_expiring',
  'official_files',
  'stop_cheaters_default',
  'stop_cheaters_no_reporter',
] as const
export type AlertKey = (typeof ALERT_KEYS)[number]

/** Something that needs an admin now, and where to deal with it. */
export interface AlertView {
  key: AlertKey
  summary: string
  /** When it was first seen; the sweep records it every five minutes. */
  since: string
  href: string
}

/** An operation whose job failed for good, holding up its server's queue (§9). */
export interface BlockedOperationView {
  operationId: string
  serverId: string
  serverName: string
  kind: string
  /** The operation as its record has it: often still `running`, its attempt having hung. */
  status: string
  error: string | null
  failedAt: string | null
  /** Operations queued behind it. */
  waiting: number
}

/** A deleted server past its purge date: the purge keeps failing, and is tried again. */
export interface OverduePurgeView {
  serverId: string
  serverName: string
  purgeAfter: string
  failedAttempts: number
  lastError: string | null
}

export interface StuckWorkView {
  blocked: BlockedOperationView[]
  overduePurges: OverduePurgeView[]
}

export const OperationRef = z.object({ operationId: z.uuid() })

/** One line of the audit log, with the people and servers it names. */
export interface AuditEntryView {
  id: string
  at: string
  actor: string
  /** Who that is, when it is a person: their email. */
  actorEmail: string | null
  action: string
  subjectType: string
  subjectId: string
  /** The server's name or the account's email, when there is one. */
  subjectName: string | null
  data: Record<string, unknown>
}

export const AuditSearchInput = z.object({
  /** An action, or a family ending in a dot, such as `account.`. */
  action: z.string().trim().max(80).default(''),
  /** An email, an account id, or an actor such as `system:billing`. */
  who: z.string().trim().max(200).default(''),
  /** A server or account id. */
  subject: z.string().trim().max(80).default(''),
  /** Where the page starts: the `next` of the page before it. */
  cursor: z.string().max(120).nullish(),
})

export interface AuditPage {
  entries: AuditEntryView[]
  /** Pass back as `cursor` for the next page; null on the last one. */
  next: string | null
}

/** A server as an operator finds it: whose it is, what the provider calls it, and what it costs. */
export interface FleetServerView {
  id: string
  name: string
  slug: string
  /** Where players join it: "cherry-grove.play.cubepals.com". */
  address: string
  status: string
  deleted: boolean
  /** Marked as run by Cubepals itself. */
  official: boolean
  /** What its last start was told to load and left out, by name; empty when everything loaded. */
  notLoaded: string[]
  /** "3 GB". */
  size: string
  owner: { userId: string; email: string; name: string; plan: string }
  /**
   * Where it runs: the provider's own region where its runtime names one ("fra"), otherwise the
   * region it was made for. Servers group by this and their runtime.
   */
  region: string
  /** Players on it now; none unless it runs. */
  online: number
  /** When someone last played on it; null before anyone has. */
  lastPlayedAt: string | null
  /** The provider's names for what it holds, and a link to them; null before it holds anything. */
  provider: { names: Array<{ label: string; value: string }>; link: string | null } | null
  /**
   * The runtime it is on (docs/runtimes.md), whether this deployment runs that runtime, and the one
   * an operator asked it to move to, until it has; null for a server with no binding.
   */
  runtime: { provider: string; runs: boolean; moveTo: string | null } | null
  /**
   * This month so far: the hours it ran, and what they and its storage cost at the provider's list
   * prices, in US cents; null where the provider doesn't bill by the server.
   */
  month: { hours: number; costCents: number | null }
}

export const FleetSearchInput = z.object({
  /** A server's name, address or id, a provider's name for it, or its owner's email or name. */
  search: z.string().trim().max(200).default(''),
  offset: z.number().int().min(0).max(100_000).default(0),
})

/** Every server the search found in one place: one runtime's one region. */
export interface FleetRegionView {
  /** The runtime they are on; null for servers bound to none yet. */
  provider: string | null
  region: string
  servers: number
  /** How many are in each status. One in the trash counts as `deleted`, whatever it was doing. */
  states: Record<string, number>
  /** Their month so far, added up; costCents is null when none of them is billed by the server. */
  month: { hours: number; costCents: number | null }
}

export interface FleetPage {
  total: number
  /** The newest of them, up to the page's limit. */
  servers: FleetServerView[]
  /** Every one the search found, by where it runs, the place with the most first. */
  regions: FleetRegionView[]
}
