// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { MINUTE_S } from '@blockly/contracts/durations'
import { type Queryable, schema, type Tx } from '@blockly/db'
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  min,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import type { PlatformControls } from '../../domain/policy/policy.ts'
import type { DaySpend } from '../../domain/policy/spend.ts'

const alerts = schema.platformAlerts
const jobs = schema.jobHealth
const log = schema.auditLog
const servers = schema.minecraftServers
const operations = schema.serverOperations

// ─── Platform controls ──────────────────────────────────────────────────────────────────────

export async function saveControls(tx: Tx, controls: PlatformControls, updatedBy: string): Promise<void> {
  await tx
    .update(schema.platformControls)
    .set({ ...controls, updatedBy, updatedAt: new Date() })
    .where(eq(schema.platformControls.id, 1))
}

export async function controlsChangedBy(q: Queryable): Promise<{ by: string | null; at: Date }> {
  const [row] = await q
    .select({ by: schema.platformControls.updatedBy, at: schema.platformControls.updatedAt })
    .from(schema.platformControls)
    .where(eq(schema.platformControls.id, 1))
  return row ?? { by: null, at: new Date(0) }
}

/** Creates the platform closed by itself for want of room; null while they are open. */
export interface CreatesFull {
  for: 'free' | 'everyone'
  because: string
  since: Date
}

export async function loadCreatesFull(q: Queryable): Promise<CreatesFull | null> {
  const controls = schema.platformControls
  const [row] = await q
    .select({
      for: controls.createsFullFor,
      because: controls.createsFullBecause,
      since: controls.createsFullSince,
    })
    .from(controls)
    .where(eq(controls.id, 1))
  if (row?.for == null || row.since === null) return null
  return { for: row.for, because: row.because ?? '', since: row.since }
}

/** Records creates closed by themselves, or open again with null; the operator's switch is left. */
export async function saveCreatesFull(tx: Tx, full: CreatesFull | null): Promise<void> {
  await tx
    .update(schema.platformControls)
    .set({
      createsFullFor: full?.for ?? null,
      createsFullBecause: full?.because ?? null,
      createsFullSince: full?.since ?? null,
    })
    .where(eq(schema.platformControls.id, 1))
}

/** When the oldest create still waiting for a worker was asked for, but `except`'s; null when none waits. */
export async function oldestWaitingCreate(q: Queryable, except?: string): Promise<Date | null> {
  const [row] = await q
    .select({ at: min(operations.createdAt) })
    .from(operations)
    .where(
      and(
        eq(operations.kind, 'provision'),
        eq(operations.status, 'queued'),
        except === undefined ? undefined : ne(operations.serverId, except),
      ),
    )
  return row?.at ?? null
}

// ─── Spend ──────────────────────────────────────────────────────────────────────────────────

const intervals = schema.powerIntervals
const days = schema.spendDays

/** Power intervals that overlap `[from, to)`, open ones included, with the size each ran at. */
export async function runsBetween(
  q: Queryable,
  from: Date,
  to: Date,
): Promise<Array<{ tier: string; startedAt: Date; stoppedAt: Date | null }>> {
  return q
    .select({ tier: intervals.memoryTier, startedAt: intervals.startedAt, stoppedAt: intervals.stoppedAt })
    .from(intervals)
    .where(
      and(
        lt(intervals.startedAt, to),
        or(isNull(intervals.stoppedAt), sql`${intervals.stoppedAt} > ${from}`),
      ),
    )
}

/**
 * Servers that hold a disk at the provider, each with its owner's plan and the size it grew to:
 * every server but a resting or purged one (one in the trash keeps its disk until it is purged).
 */
export async function disksHeld(
  q: Queryable,
): Promise<Array<{ plan: string | null; grownGb: number | null }>> {
  return q
    .select({ plan: schema.accountStanding.plan, grownGb: schema.serverRuntimes.storageGb })
    .from(servers)
    .leftJoin(schema.serverRuntimes, eq(schema.serverRuntimes.serverId, servers.id))
    .leftJoin(schema.accountStanding, eq(schema.accountStanding.userId, servers.ownerId))
    .where(notInArray(servers.status, ['stored', 'purged']))
}

export interface SpendDayRecord extends DaySpend {
  day: string
  strayMachines: number
  runningServers: number
  computedAt: Date
  trippedAt: Date | null
  notifiedAt: Date | null
}

export async function loadSpendDay(q: Queryable, day: string): Promise<SpendDayRecord | null> {
  const [row] = await q.select().from(days).where(eq(days.day, day))
  if (row === undefined) return null
  return { ...row, cents: row.computeCents + row.strayCents + row.storageCents }
}

/** The newest day worked out, for the admin page. */
export async function latestSpendDay(q: Queryable): Promise<SpendDayRecord | null> {
  const [row] = await q.select().from(days).orderBy(desc(days.day)).limit(1)
  if (row === undefined) return null
  return { ...row, cents: row.computeCents + row.strayCents + row.storageCents }
}

/** Today's figure, written over the last one; whether and when it tripped is kept as it was. */
export async function saveSpendDay(
  q: Queryable,
  day: string,
  spend: DaySpend,
  counts: { strayMachines: number; runningServers: number },
  at: Date,
): Promise<void> {
  const figure = {
    computeCents: spend.computeCents,
    strayCents: spend.strayCents,
    storageCents: spend.storageCents,
    ...counts,
    computedAt: at,
  }
  await q
    .insert(days)
    .values({ day, ...figure })
    .onConflictDoUpdate({ target: days.day, set: figure })
}

/** Marks the day tripped, once: false when another pass already had. */
export async function markSpendTripped(q: Queryable, day: string, at: Date): Promise<boolean> {
  const rows = await q
    .update(days)
    .set({ trippedAt: at })
    .where(and(eq(days.day, day), isNull(days.trippedAt)))
    .returning({ day: days.day })
  return rows.length > 0
}

export async function markSpendNotified(q: Queryable, day: string, at: Date): Promise<void> {
  await q.update(days).set({ notifiedAt: at }).where(eq(days.day, day))
}

// ─── Alerts ─────────────────────────────────────────────────────────────────────────────────

export interface AlertRecord {
  key: string
  summary: string
  raisedAt: Date
  notifiedAt: Date | null
  clearedAt: Date | null
}

export async function loadAlerts(q: Queryable): Promise<Map<string, AlertRecord>> {
  const rows = await q.select().from(alerts)
  return new Map(rows.map((row) => [row.key, row]))
}

/** Raised now, whether new or back after it had cleared; admins are told again. */
export async function raiseAlert(q: Queryable, key: string, summary: string, at: Date): Promise<void> {
  const raised = { summary, raisedAt: at, notifiedAt: null, clearedAt: null }
  await q
    .insert(alerts)
    .values({ key, ...raised })
    .onConflictDoUpdate({ target: alerts.key, set: raised })
}

export async function restateAlert(q: Queryable, key: string, summary: string): Promise<void> {
  await q.update(alerts).set({ summary }).where(eq(alerts.key, key))
}

export async function alertNotified(q: Queryable, key: string, at: Date): Promise<void> {
  await q.update(alerts).set({ notifiedAt: at }).where(eq(alerts.key, key))
}

export async function clearAlert(q: Queryable, key: string, at: Date): Promise<void> {
  await q.update(alerts).set({ clearedAt: at }).where(eq(alerts.key, key))
}

// ─── Job health ──────────────────────────────────────────────────────────────────────────────

export type JobHealthRecord = typeof schema.jobHealth.$inferSelect

export async function loadJobHealth(q: Queryable): Promise<JobHealthRecord[]> {
  return q.select().from(jobs)
}

/** What `overdue` reads of a job: when it was first seen and last got through, and how often it runs. */
export type JobProgress = Pick<JobHealthRecord, 'job' | 'everySeconds' | 'firstSeenAt' | 'lastSucceededAt'>

/** The progress of `names`, or of every job, without the errors and claims the rows also hold. */
export async function loadJobProgress(q: Queryable, names?: readonly string[]): Promise<JobProgress[]> {
  return q
    .select({
      job: jobs.job,
      everySeconds: jobs.everySeconds,
      firstSeenAt: jobs.firstSeenAt,
      lastSucceededAt: jobs.lastSucceededAt,
    })
    .from(jobs)
    .where(names === undefined ? undefined : inArray(jobs.job, [...names]))
}

/**
 * The scheduled jobs as they are now, each with its interval; one first seen now counts from now.
 * Scheduled jobs no longer among them are forgotten; what runs on no schedule is kept.
 */
export async function recordSchedule(
  q: Queryable,
  scheduled: ReadonlyArray<{ job: string; everySeconds: number }>,
  at: Date,
): Promise<void> {
  if (scheduled.length === 0) return
  await q
    .insert(jobs)
    .values(scheduled.map(({ job, everySeconds }) => ({ job, everySeconds, firstSeenAt: at })))
    .onConflictDoUpdate({ target: jobs.job, set: { everySeconds: sql`excluded.every_seconds` } })
  await q.delete(jobs).where(
    and(
      sql`${jobs.everySeconds} IS NOT NULL`,
      notInArray(
        jobs.job,
        scheduled.map((s) => s.job),
      ),
    ),
  )
}

/**
 * How long after a pass of a scheduled job was taken another may be: a minute's ticks, which every
 * worker makes, take it once between them, and the ticks of one minute fall well within this.
 */
const PASS_SPACING_S = MINUTE_S - 5

/**
 * Takes the right to run a pass of each of `names` that is due: those no pass holds (one ends when
 * it is recorded, or after `holdSeconds`) and, when `spaced`, that no worker took within
 * `PASS_SPACING_S`; of each job a pass was asked for out of its schedule, and of each whose hold lapsed
 * with no end recorded (its worker died) (`runScheduledNow` in
 * infra/pg/jobs.ts), once.
 * Returns the ones taken. The database's clock decides, so workers on other machines agree.
 */
export async function claimJobs(
  q: Queryable,
  names: readonly string[],
  holdSeconds: number,
  spaced: boolean,
): Promise<string[]> {
  const now = sql`clock_timestamp()`
  const due = and(
    inArray(jobs.job, [...names]),
    spaced
      ? or(
          isNull(jobs.claimedAt),
          lt(jobs.claimedAt, sql`clock_timestamp() - make_interval(secs => ${PASS_SPACING_S})`),
        )
      : undefined,
  )
  const rows = await q
    .update(jobs)
    .set({
      claimedAt: now,
      claimedUntil: sql`clock_timestamp() + make_interval(secs => ${holdSeconds})`,
      askedAt: null,
    })
    .where(
      and(
        or(isNull(jobs.claimedUntil), lt(jobs.claimedUntil, now)),
        // A hold that lapsed without the pass's end recorded (success and failure both clear it) means
        // its worker died: the job is taken again whether or not it is due.
        or(due, isNotNull(jobs.askedAt), isNotNull(jobs.claimedUntil)),
      ),
    )
    .returning({ job: jobs.job })
  return rows.map((r) => r.job)
}

/** Each of these passes succeeded at its time, in one write; the pass ends, so the job can be taken again. */
export async function recordJobsSucceeded(q: Queryable, done: ReadonlyMap<string, Date>): Promise<void> {
  if (done.size === 0) return
  await q
    .insert(jobs)
    .values([...done].map(([job, at]) => ({ job, firstSeenAt: at, lastSucceededAt: at })))
    .onConflictDoUpdate({
      target: jobs.job,
      set: { lastSucceededAt: sql`excluded.last_succeeded_at`, failures: 0, claimedUntil: null },
    })
}

export async function recordJobSucceeded(q: Queryable, job: string, at: Date): Promise<void> {
  await recordJobsSucceeded(q, new Map([[job, at]]))
}

/** The most of an error kept: enough to know it by. */
const ERROR_KEPT = 1000

export async function recordJobFailed(q: Queryable, job: string, at: Date, failure: string): Promise<void> {
  const error = failure.slice(0, ERROR_KEPT)
  await q
    .insert(jobs)
    .values({ job, firstSeenAt: at, lastFailedAt: at, lastError: error, failures: 1 })
    .onConflictDoUpdate({
      target: jobs.job,
      set: { lastFailedAt: at, lastError: error, failures: sql`${jobs.failures} + 1`, claimedUntil: null },
    })
}

// ─── Work that needs an admin ───────────────────────────────────────────────────────────────

export interface OverduePurge {
  id: string
  name: string
  ownerId: string
  purgeAfter: Date
}

/** Deleted servers whose purge date passed before `before`: the purge hasn't converged. */
export async function overduePurges(q: Queryable, before: Date): Promise<OverduePurge[]> {
  const rows = await q
    .select({ id: servers.id, name: servers.name, ownerId: servers.ownerId, purgeAfter: servers.purgeAfter })
    .from(servers)
    .where(and(eq(servers.status, 'deleted'), lte(servers.purgeAfter, before)))
    .orderBy(servers.purgeAfter)
  return rows.flatMap((row) => (row.purgeAfter === null ? [] : [{ ...row, purgeAfter: row.purgeAfter }]))
}

/**
 * World data each account keeps on disks, as last measured, where it comes to more than
 * `atLeastBytes`: the servers still holding storage, not resting or deleted ones.
 */
export async function worldDataByAccount(
  q: Queryable,
  atLeastBytes: number,
): Promise<Array<{ ownerId: string; bytes: number }>> {
  const bytes = sql<number>`coalesce(sum(${schema.serverRuntimes.diskUsedBytes}), 0)::bigint`
  const rows = await q
    .select({ ownerId: servers.ownerId, bytes })
    .from(servers)
    .innerJoin(schema.serverRuntimes, eq(schema.serverRuntimes.serverId, servers.id))
    .where(notInArray(servers.status, ['storing', 'stored', 'deleted', 'purged']))
    .groupBy(servers.ownerId)
    .having(sql`${bytes} > ${atLeastBytes}`)
  return rows.map((row) => ({ ownerId: row.ownerId, bytes: Number(row.bytes) }))
}

/** How many of a server's operations of one kind failed, and the newest one's error. */
export async function failuresOf(
  q: Queryable,
  serverId: string,
  kind: 'purge',
): Promise<{ failed: number; lastError: string | null }> {
  const [counted] = await q
    .select({ n: count() })
    .from(operations)
    .where(and(eq(operations.serverId, serverId), eq(operations.kind, kind), eq(operations.status, 'failed')))
  const [latest] = await q
    .select({ error: operations.error, detail: operations.detail })
    .from(operations)
    .where(and(eq(operations.serverId, serverId), eq(operations.kind, kind)))
    .orderBy(desc(operations.createdAt))
    .limit(1)
  // Admins read what was actually said; owners' words are the fallback for older rows.
  return { failed: counted?.n ?? 0, lastError: latest?.detail ?? latest?.error ?? null }
}

/** Operations waiting behind blocked ones, per server; the blocked ones don't count themselves. */
export async function queuedBehind(
  q: Queryable,
  blocked: ReadonlyArray<{ serverId: string; operationId: string }>,
): Promise<Map<string, number>> {
  if (blocked.length === 0) return new Map()
  const rows = await q
    .select({ serverId: operations.serverId, n: count() })
    .from(operations)
    .where(
      and(
        inArray(
          operations.serverId,
          blocked.map((b) => b.serverId),
        ),
        notInArray(
          operations.id,
          blocked.map((b) => b.operationId),
        ),
        eq(operations.status, 'queued'),
      ),
    )
    .groupBy(operations.serverId)
  return new Map(rows.map((row) => [row.serverId, row.n]))
}

// ─── The audit log ──────────────────────────────────────────────────────────────────────────

export interface AuditRow {
  id: string
  at: Date
  actor: string
  action: string
  subjectType: string
  subjectId: string
  data: Record<string, unknown>
  /** `at` to the microsecond, as Postgres keeps it. A `Date` holds only milliseconds, and a cursor
   * cut to those would skip the entries written later in the same millisecond. */
  mark: string
}

export interface AuditFilter {
  /** An action, or a family of them ending in a dot, such as `account.`. */
  action: string | null
  /** Actor strings, any of which matches, such as `user:<id>` and `admin:<id>`. */
  actors: string[] | null
  subjectId: string | null
  /** The page after this entry, newest first. */
  after: { at: string; id: string } | null
  limit: number
}

/** The platform's audit log, newest first (`audit_log_at`, `audit_log_actor`, `audit_log_subject`). */
export async function searchAudit(q: Queryable, filter: AuditFilter): Promise<AuditRow[]> {
  const where = and(
    ...(filter.action === null
      ? []
      : [
          filter.action.endsWith('.') ? like(log.action, `${filter.action}%`) : eq(log.action, filter.action),
        ]),
    ...(filter.actors === null ? [] : [inArray(log.actor, filter.actors.length > 0 ? filter.actors : [''])]),
    ...(filter.subjectId === null ? [] : [eq(log.subjectId, filter.subjectId)]),
    ...(filter.after === null
      ? []
      : [
          or(
            sql`${log.at} < ${filter.after.at}::timestamptz`,
            and(sql`${log.at} = ${filter.after.at}::timestamptz`, lt(log.id, filter.after.id)),
          ),
        ]),
  )
  return q
    .select({
      ...getTableColumns(log),
      mark: sql<string>`to_char(${log.at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(log)
    .where(where)
    .orderBy(desc(log.at), desc(log.id))
    .limit(filter.limit)
}

/** Emails for account ids, and names for server ids, to show who and what an entry is about. */
export async function namesFor(
  q: Queryable,
  ids: { users: readonly string[]; servers: readonly string[] },
): Promise<{ users: Map<string, string>; servers: Map<string, string> }> {
  const users =
    ids.users.length === 0
      ? []
      : await q
          .select({ id: schema.users.id, email: schema.users.email })
          .from(schema.users)
          .where(inArray(schema.users.id, [...ids.users]))
  const named =
    ids.servers.length === 0
      ? []
      : await q
          .select({ id: servers.id, name: servers.name })
          .from(servers)
          .where(inArray(sql`${servers.id}::text`, [...ids.servers]))
  return {
    users: new Map(users.map((u) => [u.id, u.email])),
    servers: new Map(named.map((s) => [s.id, s.name])),
  }
}

/** Account ids whose email is this one, for finding what someone did by their email. */
export async function usersByEmail(q: Queryable, email: string): Promise<string[]> {
  const rows = await q
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.email})`, email.toLowerCase()))
  return rows.map((row) => row.id)
}
