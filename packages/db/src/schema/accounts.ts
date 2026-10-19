// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Blockly knows about each account and the platform as a whole: admins, an account's standing
 * and plan, the platform's kill switches and caps, what each day cost, the places sign-ups in
 * flight hold and the waitlist for sign-up, the alerts that need an admin, and how the platform's
 * own recurring work last went.
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
   * The owner's time zone, as their browser last reported it ("Europe/Paris"): where a plan's day
   * begins. Null until it has; the day is UTC's until then. Nobody picks it. It is the zone the
   * current month is counted in: a zone reported later waits in `nextTimeZone`.
   */
  timeZone: text('time_zone'),
  /**
   * When `timeZone` took over from the zone before it, and when the month and day it took over in
   * began, in that zone before: that month and day run from then. Null when it has been the zone
   * from the start.
   */
  timeZoneFrom: ts('time_zone_from'),
  timeZoneBegan: ts('time_zone_began'),
  /**
   * A zone the browser reported that differs from `timeZone`, and when it takes over: once the
   * month has begun again in both, so a change never opens a month's hours early. Null when none
   * waits.
   */
  nextTimeZone: text('next_time_zone'),
  nextTimeZoneFrom: ts('next_time_zone_from'),
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
    // Conservative defaults for a new deployment: maxServers stays under the provider's machine
    // limit, and admins raise both on the platform page.
    maxServers: integer('max_servers').notNull().default(30),
    maxRunningServers: integer('max_running_servers').notNull().default(10),
    /** Accounts on the free plan before sign-up says it is full and offers a waitlist instead. */
    maxFreeAccounts: integer('max_free_accounts').notNull().default(30),
    /**
     * What a day may cost, in US cents, before the spend watchdog turns off starts and creation.
     */
    dailySpendLimitCents: integer('daily_spend_limit_cents').notNull().default(1000),
    /**
     * Whether servers put to sleep on Fly are suspended rather than stopped, as an admin set it;
     * null leaves it to FLY_SUSPEND.
     */
    flySuspend: boolean('fly_suspend'),
    /**
     * Creates the platform closed by itself when it found no room (`app/platform/room.ts`): for
     * free plans only, or for everyone; null while they are open. Apart from
     * `provisioningEnabled`, the operator's own switch, which reopening never touches.
     */
    createsFullFor: text('creates_full_for').$type<'free' | 'everyone'>(),
    /** What ran out when they closed: `servers`, `running`, `runtimes` or `queue`. */
    createsFullBecause: text('creates_full_because'),
    createsFullSince: ts('creates_full_since'),
    updatedBy: text('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [check('platform_controls_singleton', sql`${t.id} = 1`)],
)

/**
 * What each UTC day cost, as the spend watchdog last worked it out from what the control plane
 * recorded: compute from power intervals by size, compute the provider ran
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
 * written. Taking one is the same locked step as the check, so two sign-ups
 * at the last place can't both get it. It stops counting once the account exists, or once
 * `heldUntil` passes for a sign-up that never finished.
 */
export const signupHolds = pgTable('signup_holds', {
  email: text('email').primaryKey(),
  heldUntil: ts('held_until').notNull(),
})

/**
 * People who found sign-up full and left an address to hear when it opens.
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

/**
 * How each piece of the platform's recurring work last went: every scheduled job by its name, as the
 * worker that ran it recorded it (`every_seconds` its schedule's interval), and the parts of one that
 * fail on their own (`spend-figure`, the provider read for the spend watchdog; `realtime-certificate`,
 * the realtime role's renewals). The `admin-alerts` sweep and `/api/health` read it. A scheduled job's
 * row is also where workers take its passes (`claimed_at`, `claimed_until`), so that one runs at a time.
 */
export const jobHealth = pgTable('job_health', {
  job: text('job').primaryKey(),
  /** How often a scheduled job runs; null for what runs on no schedule of its own. */
  everySeconds: integer('every_seconds'),
  firstSeenAt: ts('first_seen_at').notNull(),
  lastSucceededAt: ts('last_succeeded_at'),
  lastFailedAt: ts('last_failed_at'),
  lastError: text('last_error'),
  /** Failures in a row since the last success. */
  failures: integer('failures').notNull().default(0),
  /** When a worker last took the right to run a scheduled job: one pass is taken once a minute. */
  claimedAt: ts('claimed_at'),
  /** Until when the pass taken holds the job, if it doesn't end first: the next may not start before. */
  claimedUntil: ts('claimed_until'),
  /** When a pass out of schedule was asked for (a script's sweep now): the next minute's claim takes it. */
  askedAt: ts('run_asked_at'),
})
