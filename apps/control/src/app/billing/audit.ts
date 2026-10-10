// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The audit trail of what people pay for: every change to a subscription and to the
 * plan it gives an account, with who or what made it and where it came from, so a billing dispute
 * can be answered from the log. A provider's word arrives as a before and after of the account's
 * subscriptions (`recordSubscriptionChanges`); a paid period that runs out with no word at all is
 * found by the clock (`recordLapses`). Deciding the plan is `persistence.ts`'s, not this file's.
 */
import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, desc, eq, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'
import { loadStanding } from '../accounts/persistence.ts'
import { PAST_DUE_GRACE_MS, PAYING, RENEWAL_GRACE_MS } from './persistence.ts'

const subscriptions = schema.billingSubscriptions

/**
 * Where a change came from: the provider's webhook, the person (back from a checkout or the
 * portal, asking for their standing), or a scheduled job noticing a paid period ran out.
 */
export type BillingSource = 'webhook' | 'user' | 'scheduled'

/** What the audit trail compares of one subscription. */
export interface SubscriptionSnapshot {
  id: string
  provider: string
  planKey: string
  status: string
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  pastDueAt: Date | null
}

export interface AuditEntry {
  action: string
  data: Record<string, unknown>
}

/** The account's subscriptions as they stand, by their provider's id. */
export async function snapshotSubscriptions(
  q: Queryable,
  userId: string,
): Promise<Map<string, SubscriptionSnapshot>> {
  const rows = await q
    .select({
      id: subscriptions.externalSubscriptionId,
      provider: subscriptions.provider,
      planKey: subscriptions.planKey,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      pastDueAt: subscriptions.pastDueAt,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
  return new Map(rows.map((row) => [`${row.provider}:${row.id}`, row]))
}

const paying = (s: SubscriptionSnapshot | undefined) => s !== undefined && PAYING.includes(s.status)
const iso = (at: Date | null) => at?.toISOString() ?? null

/**
 * What changed between two snapshots of an account's subscriptions, as audit entries: a new
 * subscription (or one paying again), a switch of plan, a cancel scheduled or taken back, a
 * renewal that failed, and a subscription that ended. Nothing changed is nothing to record.
 */
export function subscriptionChanges(
  before: ReadonlyMap<string, SubscriptionSnapshot>,
  after: ReadonlyMap<string, SubscriptionSnapshot>,
): AuditEntry[] {
  return [...after].flatMap(([key, now]) => changesOf(before.get(key), now))
}

/** What changed of one subscription, in the order it happened. */
function changesOf(was: SubscriptionSnapshot | undefined, now: SubscriptionSnapshot): AuditEntry[] {
  const about = { provider: now.provider, subscription: now.id, plan: now.planKey }
  const entry = (action: string, data: Record<string, unknown> = {}) => ({
    action,
    data: { ...about, ...data },
  })
  const periodEnd = iso(now.currentPeriodEnd)
  if (paying(now) && !paying(was)) {
    const start = was?.status === 'past_due' ? 'billing.renewal_recovered' : 'billing.subscribed'
    return [
      entry(start, { periodEnd }),
      ...(now.cancelAtPeriodEnd ? [entry('billing.cancel_scheduled', { endsAt: periodEnd })] : []),
    ]
  }
  if (was === undefined) return []
  if (paying(now)) return whilePaying(was, now, entry, periodEnd)
  if (now.status === was.status) return []
  if (now.status === 'past_due') return [entry('billing.renewal_failed', { since: iso(now.pastDueAt) })]
  if (now.status === 'ended') return [entry('billing.subscription_ended', { was: was.status })]
  return []
}

/** A subscription that paid and still does: a switch of plan, or a cancel scheduled or undone. */
function whilePaying(
  was: SubscriptionSnapshot,
  now: SubscriptionSnapshot,
  entry: (action: string, data?: Record<string, unknown>) => AuditEntry,
  periodEnd: string | null,
): AuditEntry[] {
  const entries: AuditEntry[] = []
  if (now.planKey !== was.planKey) entries.push(entry('billing.plan_switched', { fromPlan: was.planKey }))
  if (now.cancelAtPeriodEnd !== was.cancelAtPeriodEnd)
    entries.push(
      now.cancelAtPeriodEnd
        ? entry('billing.cancel_scheduled', { endsAt: periodEnd })
        : entry('billing.cancel_undone', { periodEnd }),
    )
  return entries
}

/** Entries about one account, written by `actor` from `source`. */
export async function writeEntries(
  q: Queryable,
  userId: string,
  actor: string,
  source: BillingSource,
  entries: readonly AuditEntry[],
): Promise<void> {
  if (entries.length === 0) return
  await q.insert(schema.auditLog).values(
    entries.map((entry) => ({
      actor,
      action: entry.action,
      subjectType: 'account',
      subjectId: userId,
      data: { ...entry.data, source },
    })),
  )
}

/** The plan in force went from one to another; nothing when it is the same plan. */
export const planChange = (from: string, to: string, extra: Record<string, unknown> = {}): AuditEntry[] =>
  from === to ? [] : [{ action: 'account.plan_changed', data: { from, to, ...extra } }]

/**
 * When a subscription stops paying by the clock alone, with no word from the provider: a paid
 * period past its renewal grace, or a failed renewal past its own (`billedPlan`). Null while it
 * still pays, or when nothing ends it.
 */
function lapsesAt(s: SubscriptionSnapshot): Date | null {
  if (PAYING.includes(s.status) && s.currentPeriodEnd !== null)
    return new Date(s.currentPeriodEnd.getTime() + RENEWAL_GRACE_MS)
  if (s.status === 'past_due' && s.pastDueAt !== null)
    return new Date(s.pastDueAt.getTime() + PAST_DUE_GRACE_MS)
  return null
}

/** Accounts with a subscription whose paid time has run out by `now`, recorded or not. */
export async function accountsWithLapses(q: Queryable, now: Date): Promise<string[]> {
  const rows = await q
    .selectDistinct({ userId: subscriptions.userId })
    .from(subscriptions)
    .where(
      or(
        and(
          inArray(subscriptions.status, PAYING),
          isNotNull(subscriptions.currentPeriodEnd),
          lte(subscriptions.currentPeriodEnd, new Date(now.getTime() - RENEWAL_GRACE_MS)),
        ),
        and(
          eq(subscriptions.status, 'past_due'),
          lte(subscriptions.pastDueAt, new Date(now.getTime() - PAST_DUE_GRACE_MS)),
        ),
      ),
    )
  return rows.map((row) => row.userId)
}

/**
 * Each of the account's subscriptions whose paid time ran out by `now` and isn't recorded yet,
 * recorded once as `billing.subscription_lapsed` (keyed by the subscription and the moment it
 * lapsed, so a period that is renewed and lapses again is recorded again), with the plan change it
 * made. Run under the account's standing lock, so a webhook for the same account waits.
 */
export async function recordLapses(
  tx: Tx,
  userId: string,
  actor: string,
  source: BillingSource,
  now: Date,
): Promise<number> {
  let recorded = 0
  for (const s of (await snapshotSubscriptions(tx, userId)).values()) {
    const at = lapsesAt(s)
    if (at === null || at > now) continue
    const [seen] = await tx
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.subjectType, 'account'),
          eq(schema.auditLog.subjectId, userId),
          eq(schema.auditLog.action, 'billing.subscription_lapsed'),
          sql`${schema.auditLog.data}->>'subscription' = ${s.id}`,
          sql`${schema.auditLog.data}->>'lapsedAt' = ${at.toISOString()}`,
        ),
      )
      .limit(1)
    if (seen) continue
    const before = (await loadStanding(tx, userId, new Date(at.getTime() - 1))).plan
    const after = (await loadStanding(tx, userId, now)).plan
    // A word that arrived after it lapsed may have recorded the drop already.
    const told = before !== after && (await planRecordedSince(tx, userId, at)) === after
    await writeEntries(tx, userId, actor, source, [
      {
        action: 'billing.subscription_lapsed',
        data: {
          provider: s.provider,
          subscription: s.id,
          plan: s.planKey,
          was: s.status,
          lapsedAt: at.toISOString(),
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        },
      },
      ...(told ? [] : planChange(before, after, { lapsedAt: at.toISOString() })),
    ])
    recorded++
  }
  return recorded
}

/** The plan the account's latest recorded plan change since `at` went to, if there is one. */
async function planRecordedSince(q: Queryable, userId: string, at: Date): Promise<string | null> {
  const [row] = await q
    .select({ to: sql<string>`${schema.auditLog.data}->>'to'` })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.subjectType, 'account'),
        eq(schema.auditLog.subjectId, userId),
        eq(schema.auditLog.action, 'account.plan_changed'),
        gte(schema.auditLog.at, at),
      ),
    )
    .orderBy(desc(schema.auditLog.at))
    .limit(1)
  return row?.to ?? null
}
