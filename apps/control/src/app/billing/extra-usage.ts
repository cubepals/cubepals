/**
 * Extra play, counted and sent to the billing provider to be billed on the next payment
 * (docs/money-guards.md). Blockly is the only judge of hours: it counts what an account played past
 * its included block while it was allowed to (`domain/account/extra-play.ts`), never more than the
 * owner allowed, into a ledger per calendar month, and the provider only bills what it is sent.
 *
 * What is sent goes through an outbox: each event is written, under the id the provider keeps it
 * by, before it is sent, and sent again until the provider takes it. A lost reply or a crash sends
 * an event again under the same id, which the provider counts once, so nothing is dropped or billed
 * twice. Hours are counted in thousandths, rounded down, so any rounding is the player's.
 *
 * It is not where servers stop at the end of what was allowed: `AccountService.enforceLimits` is.
 */
import { type Db, schema } from '@blockly/db'
import { and, asc, count, desc, eq, gt, gte, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { UNIT_CENTS } from '../../domain/account/meter.ts'
import { loadStanding, runUnitsSince } from '../accounts/persistence.ts'
import type { BillingOrder, BillingProvider } from '../ports/optional.ts'
import { extraPlayNow } from './persistence.ts'

const months = schema.extraPlayMonths
const reports = schema.extraPlayReports

/** An event goes once this much is waiting, in thousandths of an hour: a quarter of an hour. */
const EVENT_MILLI = 250
/** Or once anything has waited this long, so a run that ends is billed soon after. */
const EVENT_WAIT_MS = 10 * 60_000
/**
 * How far behind the clock an event is dated. The provider refuses an event from the future, and
 * one it refuses holds back the rest of its batch, so a clock a little ahead of its own never does.
 */
const EVENT_BEHIND_MS = 60_000
/** Events in one request, and requests in one pass: well inside the provider's rate limit. */
const BATCH = 25
const BATCHES_PER_PASS = 4

const monthOf = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
const day = (at: Date) => at.toISOString().slice(0, 10)

export class ExtraUsage {
  readonly #db: Db
  readonly #billing: BillingProvider | null

  constructor(deps: { db: Db; billing: BillingProvider | null }) {
    this.#db = deps.db
    this.#billing = deps.billing
  }

  /** `extra-play-report`: count, cut events from what was counted, and send what waits. */
  async report(now = new Date()): Promise<void> {
    for (const userId of await this.#playing(now)) await this.count(userId, now)
    await this.cut(now)
    const { sent, failed } = await this.send()
    if (failed > 0) console.warn(`extra-play: ${failed} events not taken yet, ${sent} sent`)
  }

  /**
   * The account's extra play this month, counted up to now, where it may play extra now: what it
   * played past its included hours, held to what it may use. It only grows, so a limit lowered
   * after hours were played never takes them back, and hours played while it couldn't use extra
   * (servers sleep then) are never counted. In a month's first hour, the month before is counted
   * too, to its last moment. True when something new was counted.
   */
  async count(userId: string, now = new Date()): Promise<boolean> {
    const standing = await loadStanding(this.#db, userId, now)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    if (plan.includedUnits === null) return false
    const { decision } = await extraPlayNow(this.#db, standing, now)
    if (!decision.may) return false
    const start = monthOf(now)
    const spans: Array<{ from: Date; to: Date }> = [{ from: start, to: now }]
    if (now.getTime() - start.getTime() < 3_600_000)
      spans.push({ from: monthOf(new Date(start.getTime() - 1)), to: start })
    let grew = false
    for (const span of spans) {
      const units = await runUnitsSince(this.#db, userId, span.from, span.to)
      // Rounded down, but not by a binary fraction's last digit: 60.05 hours is 50 thousandths past 60.
      const milli = Math.floor(Math.min(units - plan.includedUnits, decision.units) * 1000 + 1e-6)
      if (milli <= 0) continue
      const rows = await this.#db
        .insert(months)
        .values({ userId, month: day(span.from), accruedMilli: milli, pendingSince: now })
        .onConflictDoUpdate({
          target: [months.userId, months.month],
          set: {
            accruedMilli: milli,
            pendingSince: sql`coalesce(${months.pendingSince}, ${now})`,
            updatedAt: now,
          },
          setWhere: sql`${months.accruedMilli} < ${milli}`,
        })
        .returning({ userId: months.userId })
      grew ||= rows.length > 0
    }
    return grew
  }

  /**
   * Events from what was counted and not yet sent: once a quarter of an hour waits, once anything
   * has waited ten minutes, and whatever is left of a month that is over. Each is written with
   * the next id of its account's month, and what it carries counts as reported from then on.
   */
  async cut(now = new Date()): Promise<number> {
    const due = await this.#db
      .select({ userId: months.userId, month: months.month })
      .from(months)
      .where(
        and(
          gt(months.accruedMilli, months.reportedMilli),
          or(
            sql`${months.accruedMilli} - ${months.reportedMilli} >= ${EVENT_MILLI}`,
            lte(months.pendingSince, new Date(now.getTime() - EVENT_WAIT_MS)),
            sql`${months.month} < ${day(monthOf(now))}`,
          ),
        ),
      )
    for (const row of due)
      await this.#db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(months)
          .where(and(eq(months.userId, row.userId), eq(months.month, row.month)))
          .for('update')
        if (locked === undefined || locked.accruedMilli <= locked.reportedMilli) return
        const [made] = await tx
          .select({ n: count() })
          .from(reports)
          .where(and(eq(reports.userId, row.userId), eq(reports.month, row.month)))
        await tx.insert(reports).values({
          externalId: `extra:${row.userId}:${row.month.slice(0, 7)}:${(made?.n ?? 0) + 1}`,
          userId: row.userId,
          month: row.month,
          milli: locked.accruedMilli - locked.reportedMilli,
          at: new Date(now.getTime() - EVENT_BEHIND_MS),
        })
        await tx
          .update(months)
          .set({ reportedMilli: locked.accruedMilli, pendingSince: null, updatedAt: now })
          .where(and(eq(months.userId, row.userId), eq(months.month, row.month)))
      })
    return due.length
  }

  /**
   * Events not yet taken, oldest first, in batches. A batch the provider refuses is tried one
   * event at a time, so one it won't take never holds back the rest; whatever fails waits for the
   * next pass, under the same id.
   */
  async send(): Promise<{ sent: number; failed: number }> {
    const billing = this.#billing
    if (billing === null) return { sent: 0, failed: 0 }
    let sent = 0
    let failed = 0
    for (let pass = 0; pass < BATCHES_PER_PASS; pass++) {
      const batch = await this.#db
        .select()
        .from(reports)
        .where(isNull(reports.sentAt))
        .orderBy(asc(reports.at), asc(reports.externalId))
        .limit(BATCH)
      if (batch.length === 0) break
      const events = batch.map((row) => ({
        externalId: row.externalId,
        userId: row.userId,
        hours: row.milli / 1000,
        at: row.at,
      }))
      const taken = await billing.reportUsage(events).then(
        () => events,
        async (error: unknown) => {
          if (events.length === 1) {
            await this.#failed(events[0]?.externalId ?? '', error)
            return []
          }
          const one: typeof events = []
          for (const event of events)
            await billing.reportUsage([event]).then(
              () => one.push(event),
              (alone: unknown) => this.#failed(event.externalId, alone),
            )
          return one
        },
      )
      for (const event of taken)
        await this.#db
          .update(reports)
          .set({ sentAt: new Date() })
          .where(eq(reports.externalId, event.externalId))
      sent += taken.length
      failed += events.length - taken.length
      if (taken.length < events.length) break
    }
    return { sent, failed }
  }

  async #failed(externalId: string, error: unknown): Promise<void> {
    await this.#db
      .update(reports)
      .set({
        attempts: sql`${reports.attempts} + 1`,
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      })
      .where(eq(reports.externalId, externalId))
  }

  /** Accounts with a server that ran in the last quarter of an hour, or runs now. */
  async #playing(now: Date): Promise<string[]> {
    const intervals = schema.powerIntervals
    const rows = await this.#db
      .selectDistinct({ ownerId: schema.minecraftServers.ownerId })
      .from(intervals)
      .innerJoin(schema.minecraftServers, eq(schema.minecraftServers.id, intervals.serverId))
      .where(or(isNull(intervals.stoppedAt), gt(intervals.stoppedAt, new Date(now.getTime() - 15 * 60_000))))
    return rows.map((row) => row.ownerId)
  }
}

/** What an account's extra play this month comes to: counted, and of that, sent to be billed. */
export async function extraThisMonth(
  db: Db,
  userId: string,
  now = new Date(),
): Promise<{ countedUnits: number; reportedUnits: number }> {
  const [row] = await db
    .select()
    .from(months)
    .where(and(eq(months.userId, userId), eq(months.month, day(monthOf(now)))))
  return { countedUnits: (row?.accruedMilli ?? 0) / 1000, reportedUnits: (row?.reportedMilli ?? 0) / 1000 }
}

/**
 * A paid renewal, checked against what was sent for it: the extra play its metered line billed,
 * and the extra play Blockly sent between the subscription's order before and this one. The two
 * can differ honestly (the provider bills an event on the payment after it has processed it, which
 * can be a later one), so a difference is kept on the account's audit log, once per order, for an
 * admin to read, never acted on.
 */
export async function auditRenewal(db: Db, provider: string, order: BillingOrder): Promise<void> {
  if (order.billingReason !== 'subscription_cycle' || order.status !== 'paid' || order.userId === null) return
  const log = schema.auditLog
  const [told] = await db
    .select({ id: log.id })
    .from(log)
    .where(and(eq(log.action, 'billing.extra_billed'), sql`${log.data}->>'order' = ${order.externalOrderId}`))
  if (told !== undefined) return
  const orders = schema.billingOrders
  const [before] = await db
    .select({ at: orders.orderedAt })
    .from(orders)
    .where(
      and(
        eq(orders.provider, provider),
        eq(orders.userId, order.userId),
        order.externalSubscriptionId === null
          ? sql`true`
          : eq(orders.externalSubscriptionId, order.externalSubscriptionId),
        lt(orders.orderedAt, order.orderedAt),
      ),
    )
    .orderBy(desc(orders.orderedAt))
    .limit(1)
  const [sent] = await db
    .select({ milli: sql<string>`coalesce(sum(${reports.milli}), 0)` })
    .from(reports)
    .where(
      and(
        eq(reports.userId, order.userId),
        gte(reports.sentAt, before?.at ?? new Date(0)),
        lt(reports.sentAt, order.orderedAt),
      ),
    )
  const reportedCents = Math.round((Number(sent?.milli ?? 0) / 1000) * UNIT_CENTS)
  await db.insert(log).values({
    actor: 'system:billing',
    action: 'billing.extra_billed',
    subjectType: 'account',
    subjectId: order.userId,
    data: {
      order: order.externalOrderId,
      billedCents: order.extraCents,
      reportedCents,
      matches: Math.abs(reportedCents - order.extraCents) <= 1,
    },
  })
}
