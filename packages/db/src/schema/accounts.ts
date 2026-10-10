// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Blockly knows about each account and the platform as a whole: admins, an account's standing
 * and plan, the platform's kill switches and caps, what each day cost, the places sign-ups in
 * flight hold and the waitlist for sign-up, and the alerts that need an admin.
 */
import { sql } from 'drizzle-orm'
import { boolean, check, date, integer, jsonb, pgEnum, pgTable, text } from 'drizzle-orm/pg-core'
import type { AccountRestrictionsJson, LimitOverridesJson } from '../json.ts'
import { users } from './auth.ts'
import { createdAt, ts, updatedAt } from './columns.ts'

// ─── Accounts and platform ──────────────────────────────────────────────────────────────────

export const accountStatus = pgEnum('account_status', ['active', 'suspended', 'terminated'])

/** People who administer the platform: the `admin:<id>` actors (§4, §9), and who made each one. */
export const platformAdmins = pgTable('platform_admins', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  /** `config` for a verified email listed in ADMIN_EMAILS; otherwise the admin who granted it. */
  grantedBy: text('granted_by').notNull(),
  grantedAt: ts('granted_at').notNull().defaultNow(),
})

export const accountStanding = pgTable('account_standing', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  status: accountStatus('status').notNull().default('active'),
  reason: text('reason'),
  plan: text('plan').notNull().default('free'),
  restrictions: jsonb('restrictions').$type<AccountRestrictionsJson>().notNull().default({}),
  limitOverrides: jsonb('limit_overrides').$type<LimitOverridesJson>().notNull().default({}),
  /** Play past the plan's included block that the owner allows, in meter units (§15.5). */
  extraUnitsAllowed: integer('extra_units_allowed').notNull().default(0),
  /**
   * Minutes a player may stand still before the server kicks them, where the owner set it
   * themselves; null leaves the plan's own. On metered play an idle player spends money.
   */
  afkKickMinutes: integer('afk_kick_minutes'),
  /**
   * The last warning about this month's play that was sent, as `YYYY-MM:percent`. A month and a
   * threshold together, so the same warning is never sent twice and a new month starts quiet.
   */
  playWarned: text('play_warned'),
  /**
   * The last email about extra play sent, as `YYYY-MM:mark`: `0` when it started being used, then
   * 80 and 100 of what the owner allowed. Kept the way `playWarned` is.
   */
  extraWarned: text('extra_warned'),
  /**
   * Where the account came from, as the link that brought it said (`?ref=` or `utm_source=`),
   * kept once in the week after sign-up; null when no link said. No cookie carries it.
   */
  signupSource: text('signup_source'),
  /**
   * The rest of the link's campaign tags (`utm_medium`, `utm_campaign`, `utm_content`,
   * `utm_term`), kept with the source and the same way: once, in the first week, never replaced.
   */
  signupMedium: text('signup_medium'),
  signupCampaign: text('signup_campaign'),
  signupContent: text('signup_content'),
  signupTerm: text('signup_term'),
  /**
   * An account the people who run Cubepals use to test it: made by an admin or marked by one. It
   * is left out of the business's numbers and never sent to the billing provider or analytics.
   */
  testAccount: boolean('test_account').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const platformControls = pgTable(
  'platform_controls',
  {
    id: integer('id').primaryKey().default(1),
    provisioningEnabled: boolean('provisioning_enabled').notNull().default(true),
    startsEnabled: boolean('starts_enabled').notNull().default(true),
    publicListingEnabled: boolean('public_listing_enabled').notNull().default(true),
    uploadsEnabled: boolean('uploads_enabled').notNull().default(true),
    /** Whether worlds nobody plays are packed away and their compute and storage let go. */
    storingEnabled: boolean('storing_enabled').notNull().default(true),
    /**
     * Whether worlds a plan keeps only so long after their last play are deleted when that ends,
     * after two emails. Off until someone turns it on.
     */
    expiringEnabled: boolean('expiring_enabled').notNull().default(false),
    // Conservative defaults for a new deployment (docs/money-guards.md): maxServers stays under the
    // provider's machine limit, and admins raise both on the platform page.
    maxServers: integer('max_servers').notNull().default(30),
    maxRunningServers: integer('max_running_servers').notNull().default(10),
    /** Accounts on the free plan before sign-up says it is full and offers a waitlist instead. */
    maxFreeAccounts: integer('max_free_accounts').notNull().default(30),
    /**
     * What a day may cost, in US cents, before the spend watchdog turns off starts and creation
     * (docs/money-guards.md).
     */
    dailySpendLimitCents: integer('daily_spend_limit_cents').notNull().default(1000),
    updatedBy: text('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [check('platform_controls_singleton', sql`${t.id} = 1`)],
)

/**
 * What each UTC day cost, as the spend watchdog last worked it out from what the control plane
 * recorded (docs/money-guards.md): compute from power intervals by size, compute the provider ran
 * that no server here accounts for, and disks. Rewritten through the day; the last figure stands.
 */
export const spendDays = pgTable('spend_days', {
  day: date('day', { mode: 'string' }).primaryKey(),
  computeCents: integer('compute_cents').notNull(),
  strayCents: integer('stray_cents').notNull(),
  storageCents: integer('storage_cents').notNull(),
  /** Machines the provider runs that the control plane thinks hold no running server. */
  strayMachines: integer('stray_machines').notNull(),
  runningServers: integer('running_servers').notNull(),
  computedAt: ts('computed_at').notNull(),
  /** When the day passed its limit and starts and creation were turned off; null if it didn't. */
  trippedAt: ts('tripped_at'),
  /** When admins were told it tripped; null until every email went out. */
  notifiedAt: ts('notified_at'),
})

/**
 * A free place held for a sign-up between the check that there's room and its account being
 * written (docs/money-guards.md). Taking one is the same locked step as the check, so two sign-ups
 * at the last place can't both get it. It stops counting once the account exists, or once
 * `heldUntil` passes for a sign-up that never finished.
 */
export const signupHolds = pgTable('signup_holds', {
  email: text('email').primaryKey(),
  heldUntil: ts('held_until').notNull(),
})

/**
 * People who found sign-up full and left an address to hear when it opens (docs/money-guards.md).
 * Only the address, lowercased, and the link that brought them.
 */
export const waitlist = pgTable('waitlist', {
  email: text('email').primaryKey(),
  source: text('source'),
  createdAt: createdAt(),
})

/**
 * Conditions that need an admin (§9, §15.3): raised when the `admin-alerts` sweep first sees
 * one, emailed to admins once, cleared when it passes. A condition that returns is raised again.
 */
export const platformAlerts = pgTable('platform_alerts', {
  key: text('key').primaryKey(),
  summary: text('summary').notNull(),
  raisedAt: ts('raised_at').notNull(),
  /** When admins were told; null until an email went out. */
  notifiedAt: ts('notified_at'),
  clearedAt: ts('cleared_at'),
})
