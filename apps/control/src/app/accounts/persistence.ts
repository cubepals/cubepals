import { type Queryable, schema, type Tx } from '@blockly/db'
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { METER_UNITS } from '../../domain/account/meter.ts'
import { type AccountStanding, newStanding } from '../../domain/account/standing.ts'
import type { PlatformControls } from '../../domain/policy/policy.ts'
import type { ServerStatus } from '../../domain/server/lifecycle.ts'
import { billedPlan, PAYING } from '../billing/persistence.ts'

const standing = schema.accountStanding
const servers = schema.minecraftServers

/** Statuses that hold, or are about to hold, compute. */
const ACTIVE_STATUSES: ServerStatus[] = [
  'provisioning',
  'starting',
  'running',
  'stopping',
  'updating',
  'restoring',
  'relocating',
]

const toStanding = (row: typeof standing.$inferSelect): AccountStanding => ({
  userId: row.userId,
  status: row.status,
  reason: row.reason,
  plan: row.plan,
  restrictions: row.restrictions,
  limitOverrides: row.limitOverrides,
  extraUnitsAllowed: row.extraUnitsAllowed,
  afkKickMinutes: row.afkKickMinutes,
  playWarned: row.playWarned,
})

/**
 * An account's standing, with the plan in force: a paying subscription's plan when there is one,
 * otherwise the plan set on the account (free, or one an admin gave it). Every entitlement is
 * read through here.
 */
export async function loadStanding(q: Queryable, userId: string, now = new Date()): Promise<AccountStanding> {
  const [row] = await q.select().from(standing).where(eq(standing.userId, userId))
  const found = row ? toStanding(row) : newStanding(userId)
  const billed = await billedPlan(q, userId, now)
  return billed === null ? found : { ...found, plan: billed }
}

/** An account's standing, locked for a change; null when there is no such account. */
export async function lockStanding(tx: Tx, userId: string): Promise<AccountStanding | null> {
  const [user] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
  if (!user) return null
  await ensureStanding(tx, userId)
  const [row] = await tx.select().from(standing).where(eq(standing.userId, userId)).for('update')
  return row ? toStanding(row) : null
}

export async function saveStanding(
  tx: Tx,
  userId: string,
  change: Partial<Omit<AccountStanding, 'userId'>>,
): Promise<void> {
  await tx
    .update(standing)
    .set({ ...change, updatedAt: new Date() })
    .where(eq(standing.userId, userId))
}

/** Accounts whose standing no longer lets them run anything, for the enforcement sweep. */
export async function ownersNotActive(
  q: Queryable,
): Promise<Array<{ userId: string; status: 'suspended' | 'terminated' }>> {
  const rows = await q
    .select({ userId: standing.userId, status: standing.status })
    .from(standing)
    .where(inArray(standing.status, ['suspended', 'terminated']))
  return rows as Array<{ userId: string; status: 'suspended' | 'terminated' }>
}

/** Accounts that have a server starting or running. */
export async function ownersRunning(q: Queryable): Promise<string[]> {
  const rows = await q
    .selectDistinct({ ownerId: servers.ownerId })
    .from(servers)
    .where(and(isNull(servers.deletedAt), inArray(servers.status, ['starting', 'running'])))
  return rows.map((r) => r.ownerId)
}

// ─── Admins ─────────────────────────────────────────────────────────────────────────────────

const admins = schema.platformAdmins

export async function isAdmin(q: Queryable, userId: string): Promise<boolean> {
  const [row] = await q.select({ userId: admins.userId }).from(admins).where(eq(admins.userId, userId))
  return row !== undefined
}

export async function grantAdmin(q: Queryable, userId: string, grantedBy: string): Promise<boolean> {
  const rows = await q.insert(admins).values({ userId, grantedBy }).onConflictDoNothing().returning()
  return rows.length > 0
}

export async function revokeAdmin(q: Queryable, userId: string): Promise<void> {
  await q.delete(admins).where(eq(admins.userId, userId))
}

export async function listAdmins(
  q: Queryable,
): Promise<Array<{ userId: string; grantedBy: string; email: string }>> {
  return q
    .select({ userId: admins.userId, grantedBy: admins.grantedBy, email: schema.users.email })
    .from(admins)
    .innerJoin(schema.users, eq(schema.users.id, admins.userId))
}

/** An account's email address; null when there is no such account. */
export async function emailOf(q: Queryable, userId: string): Promise<string | null> {
  const [row] = await q
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
  return row?.email ?? null
}

/** Accounts with a confirmed email among these (lowercase). */
export async function verifiedByEmail(q: Queryable, emails: readonly string[]): Promise<string[]> {
  if (emails.length === 0) return []
  const rows = await q
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.emailVerified, true), inArray(sql`lower(${schema.users.email})`, [...emails])))
  return rows.map((r) => r.id)
}

// ─── Accounts, as admins look them up ───────────────────────────────────────────────────────

export interface AccountRow {
  userId: string
  name: string
  email: string
  emailVerified: boolean
  createdAt: Date
  standing: AccountStanding
  admin: boolean
  servers: number
}

/** Accounts by name or email, newest first, with how many live servers each has. */
export async function searchAccounts(
  q: Queryable,
  search: string,
  offset: number,
  limit: number,
): Promise<{ rows: AccountRow[]; total: number }> {
  const users = schema.users
  const text = search.trim()
  const match = text ? or(ilike(users.email, `%${text}%`), ilike(users.name, `%${text}%`)) : undefined
  const [total] = await q.select({ n: count() }).from(users).where(match)
  const found = await q
    .select({
      user: users,
      standing,
      admin: admins.userId,
      servers: sql<number>`(select count(*)::int from ${servers} where ${servers.ownerId} = ${users.id} and ${servers.deletedAt} is null)`,
    })
    .from(users)
    .leftJoin(standing, eq(standing.userId, users.id))
    .leftJoin(admins, eq(admins.userId, users.id))
    .where(match)
    .orderBy(desc(users.createdAt))
    .offset(offset)
    .limit(limit)
  return {
    total: total?.n ?? 0,
    rows: found.map((row) => ({
      userId: row.user.id,
      name: row.user.name,
      email: row.user.email,
      emailVerified: row.user.emailVerified,
      createdAt: row.user.createdAt,
      standing: row.standing ? toStanding(row.standing) : newStanding(row.user.id),
      admin: row.admin !== null,
      servers: Number(row.servers),
    })),
  }
}

/** Called when an account is created, so standing always has a row to lock and audit. */
export async function ensureStanding(q: Queryable, userId: string): Promise<void> {
  await q.insert(standing).values({ userId }).onConflictDoNothing()
}

export async function loadControls(q: Queryable): Promise<PlatformControls> {
  const [row] = await q.select().from(schema.platformControls).where(eq(schema.platformControls.id, 1))
  if (!row) throw new Error('platform_controls has no row; run the migrations')
  return row
}

export async function emailVerified(q: Queryable, userId: string): Promise<boolean> {
  const [row] = await q
    .select({ verified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
  return row?.verified ?? false
}

export async function countServers(
  q: Queryable,
  ownerId?: string,
): Promise<{ servers: number; running: number }> {
  const live = isNull(servers.deletedAt)
  // The platform's own count is of what holds compute: a resting world holds none, and doesn't
  // count against the runtime's server ceiling. An account's count is of the servers it has.
  const scope =
    ownerId === undefined
      ? and(live, notInArray(servers.status, ['stored']))
      : and(live, eq(servers.ownerId, ownerId))
  const [all] = await q.select({ n: count() }).from(servers).where(scope)
  const [active] = await q
    .select({ n: count() })
    .from(servers)
    .where(and(scope, inArray(servers.status, ACTIVE_STATUSES)))
  return { servers: all?.n ?? 0, running: active?.n ?? 0 }
}

export async function createsSince(q: Queryable, ownerId: string, since: Date): Promise<number> {
  const [row] = await q
    .select({ n: count() })
    .from(servers)
    .where(and(eq(servers.ownerId, ownerId), gte(servers.createdAt, since)))
  return row?.n ?? 0
}

/**
 * Play since `since`, in meter units: every run weighted by the size it ran on, open ones
 * counted up to now. This is the number a plan's included block is measured against, and the
 * one a meter would bill.
 */
export async function runUnitsSince(q: Queryable, ownerId: string, since: Date, now: Date): Promise<number> {
  const intervals = schema.powerIntervals
  const weights = Object.entries(METER_UNITS)
  // One CASE over the sizes the meter knows; a size it doesn't know counts as one unit an hour,
  // which is the smallest a server can cost and never overcharges.
  const weight = sql.join(
    [
      sql`case`,
      // Cast, or Postgres reads a weight like 1.8 as an integer parameter and refuses it.
      ...weights.map(([tier, units]) => sql`when ${intervals.memoryTier} = ${tier} then ${units}::numeric`),
      sql`else 1 end`,
    ],
    sql` `,
  )
  const [row] = await q
    .select({
      units: sql<string>`coalesce(sum(extract(epoch from (least(coalesce(${intervals.stoppedAt}, ${now}), ${now}) - greatest(${intervals.startedAt}, ${since}))) * (${weight})), 0)`,
    })
    .from(intervals)
    .innerJoin(servers, eq(servers.id, intervals.serverId))
    .where(and(eq(servers.ownerId, ownerId), sql`coalesce(${intervals.stoppedAt}, ${now}) > ${since}`))
  return Number(row?.units ?? 0) / 3600
}

/** Hours the owner's servers have run since `since`, counting open intervals up to now. */
export async function runHoursSince(q: Queryable, ownerId: string, since: Date, now: Date): Promise<number> {
  const intervals = schema.powerIntervals
  const [row] = await q
    .select({
      seconds: sql<string>`coalesce(sum(extract(epoch from (least(coalesce(${intervals.stoppedAt}, ${now}), ${now}) - greatest(${intervals.startedAt}, ${since})))), 0)`,
    })
    .from(intervals)
    .innerJoin(servers, eq(servers.id, intervals.serverId))
    .where(and(eq(servers.ownerId, ownerId), sql`coalesce(${intervals.stoppedAt}, ${now}) > ${since}`))
  return Number(row?.seconds ?? 0) / 3600
}

/** Serializes capacity decisions: count-then-write races become impossible. */
export async function lockCapacity(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('blockly:capacity'))`)
}

/** Serializes an account's rate-limited actions, so each counts the ones before it. */
export async function lockAccountActions(tx: Tx, accountId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`blockly:actions:${accountId}`}))`)
}

/** How many times an actor did something since a moment, by the audit log (`audit_log_actor`). */
export async function actionsSince(
  q: Queryable,
  actor: string,
  action: string,
  since: Date,
): Promise<number> {
  const log = schema.auditLog
  const [row] = await q
    .select({ n: count() })
    .from(log)
    .where(and(eq(log.actor, actor), eq(log.action, action), gte(log.at, since)))
  return row?.n ?? 0
}

/**
 * Keeps where the account came from, with the link's campaign tags, once, and only in the week
 * after it was made: a link seen later is a returning visit, not how the account started. True
 * when it was kept.
 */
export async function recordSignupSource(
  q: Queryable,
  userId: string,
  link: {
    source: string
    medium: string | null
    campaign: string | null
    content: string | null
    term: string | null
  },
): Promise<boolean> {
  const kept = await q
    .update(schema.accountStanding)
    .set({
      signupSource: link.source,
      signupMedium: link.medium,
      signupCampaign: link.campaign,
      signupContent: link.content,
      signupTerm: link.term,
    })
    .where(
      and(
        eq(schema.accountStanding.userId, userId),
        isNull(schema.accountStanding.signupSource),
        gt(schema.accountStanding.createdAt, sql`now() - interval '7 days'`),
      ),
    )
    .returning({ userId: schema.accountStanding.userId })
  return kept.length > 0
}

// ─── Sign-ups ───────────────────────────────────────────────────────────────────────────────

/**
 * Accounts on the free plan, as sign-up counts them against `maxFreeAccounts`: every account but
 * one a subscription pays for (or holds through its grace), one an admin gave another plan, a
 * closed one, and an admin's own. An account whose standing isn't written yet is free.
 */
export async function countFreeAccounts(q: Queryable): Promise<number> {
  const standing = schema.accountStanding
  const subscriptions = schema.billingSubscriptions
  const paying = q
    .select({ one: sql`1` })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.userId, schema.users.id), inArray(subscriptions.status, [...PAYING, 'past_due'])),
    )
  const [row] = await q
    .select({ n: count() })
    .from(schema.users)
    .leftJoin(standing, eq(standing.userId, schema.users.id))
    .leftJoin(schema.platformAdmins, eq(schema.platformAdmins.userId, schema.users.id))
    .where(
      and(
        isNull(schema.platformAdmins.userId),
        notExists(paying),
        or(isNull(standing.userId), and(eq(standing.plan, 'free'), ne(standing.status, 'terminated'))),
      ),
    )
  return row?.n ?? 0
}

/** How long a sign-up keeps its free place between the check and its account being written. */
const HOLD_SECONDS = 60

/**
 * Serializes taking a free place, as `lockCapacity` does servers: the count a sign-up checks
 * can't change before its hold is written, so two at the last place can't both see room.
 */
export async function lockFreePlaces(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('blockly:free-places'))`)
}

/**
 * Free places taken, as sign-up compares them with `maxFreeAccounts`: the free accounts, and the
 * places held for sign-ups whose account isn't written yet. A hold whose account exists is
 * already counted as the account; one past its time is a sign-up that never finished.
 */
export async function countTakenFreePlaces(q: Queryable): Promise<number> {
  const holds = schema.signupHolds
  const written = q.select({ one: sql`1` }).from(schema.users).where(eq(schema.users.email, holds.email))
  const [row] = await q
    .select({ n: count() })
    .from(holds)
    .where(and(gt(holds.heldUntil, sql`now()`), notExists(written)))
  return (await countFreeAccounts(q)) + (row?.n ?? 0)
}

/** Holds a free place for this address (under `lockFreePlaces`), clearing holds that ended. */
export async function holdFreePlace(tx: Tx, email: string): Promise<void> {
  const holds = schema.signupHolds
  const until = sql`now() + make_interval(secs => ${HOLD_SECONDS})`
  await tx.delete(holds).where(lte(holds.heldUntil, sql`now()`))
  await tx
    .insert(holds)
    .values({ email: email.toLowerCase(), heldUntil: until })
    .onConflictDoUpdate({ target: holds.email, set: { heldUntil: until } })
}

/** Adds an address to the waitlist; one already on it stays as it was. */
export async function joinWaitlist(q: Queryable, email: string, source: string | null): Promise<void> {
  await q.insert(schema.waitlist).values({ email: email.toLowerCase(), source }).onConflictDoNothing()
}

export async function countWaitlist(q: Queryable): Promise<number> {
  const [row] = await q.select({ n: count() }).from(schema.waitlist)
  return row?.n ?? 0
}
