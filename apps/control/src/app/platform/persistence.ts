import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, count, desc, eq, inArray, isNull, like, lt, lte, notInArray, or, sql } from 'drizzle-orm'
import type { PlatformControls } from '../../domain/policy/policy.ts'
import type { DaySpend } from '../../domain/policy/spend.ts'

const alerts = schema.platformAlerts
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
}

export interface AuditFilter {
  /** An action, or a family of them ending in a dot, such as `account.`. */
  action: string | null
  /** Actor strings, any of which matches, such as `user:<id>` and `admin:<id>`. */
  actors: string[] | null
  subjectId: string | null
  /** The page after this entry, newest first. */
  after: { at: Date; id: string } | null
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
      : [or(lt(log.at, filter.after.at), and(eq(log.at, filter.after.at), lt(log.id, filter.after.id)))]),
  )
  return q.select().from(log).where(where).orderBy(desc(log.at), desc(log.id)).limit(filter.limit)
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
