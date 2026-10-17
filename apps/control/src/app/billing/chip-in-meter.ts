// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The meter with what friends chipped in taken out: play hours chipped in covered never counts
 * against an owner's hours, nor carries, nor is it billed as extra, so every place that measures
 * play against a plan's monthly hours reads it here (`meteredMonth`, `meteredUnitsSince`). Covered
 * play is what was drawn and kept (`chip_in_draws`, up to the owner's mark) and what is drawn now,
 * past the mark, worked out the same way (`domain/account/chip-in.ts` `draw`) without being kept,
 * so a page, the policy and the sweep agree with the next minute's draw before it is made. Draws go
 * month by month as the owner counts them (`accounts/play-month.ts`): from their midnight on the
 * 1st, once the month's hours, the plan's and what carried into it, are used.
 *
 * It is not where draws are kept (`chip-ins.ts`) or where chip-ins are paid.
 */
import { HOUR_S } from '@blockly/contracts/durations'
import { type Queryable, schema } from '@blockly/db'
import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import { draw, heldMilli, type Span, unitsWithin } from '../../domain/account/chip-in.ts'
import { type Entitlements, entitlementsFor } from '../../domain/account/entitlements.ts'
import { METER_UNITS } from '../../domain/account/meter.ts'
import { DEFAULT_TIME_ZONE, nextMonthStart } from '../../domain/account/play-day.ts'
import type { AccountStanding } from '../../domain/account/standing.ts'
import { countedFrom, loadStanding, runUnitsIn } from '../accounts/persistence.ts'
import { monthSpans, type PlayMonth, playOf } from '../accounts/play-month.ts'

const chipIns = schema.chipIns
const draws = schema.chipInDraws
const servers = schema.minecraftServers

type Spans = ReadonlyArray<{ from: Date; to: Date }>

/** What draws past an owner's mark come to: covered spans from it to `to`, and what is left then. */
export interface Pending {
  /** Every draw kept ends by here; what is drawn past it is `covered`. */
  mark: Date
  covered: Span[]
  /** Units each of the owner's servers has left chipped in at `to`. */
  left: Map<string, number>
}

/**
 * Draws past the owner's mark, up to `to`, worked out and not kept: null for an owner whose
 * servers were never chipped in to. On a plan with no monthly hours nothing is drawn, and the
 * hours wait for one.
 */
export async function pendingDraws(q: Queryable, ownerId: string, to: Date): Promise<Pending | null> {
  const paid = await q
    .select({
      serverId: chipIns.serverId,
      milli: chipIns.milli,
      netCents: chipIns.netCents,
      refundedCents: chipIns.refundedCents,
      at: chipIns.receivedAt,
    })
    .from(chipIns)
    .innerJoin(servers, eq(servers.id, chipIns.serverId))
    .where(and(eq(servers.ownerId, ownerId), lte(chipIns.receivedAt, to)))
  if (paid.length === 0) return null
  const [marked] = await q
    .select({ at: schema.chipInMarks.drawnThrough })
    .from(schema.chipInMarks)
    .where(eq(schema.chipInMarks.userId, ownerId))
  // Nothing was ever drawn: no play before the first chip-in can be covered.
  const mark = marked?.at ?? new Date(Math.min(...paid.map((row) => row.at.getTime())))
  const { left, credits } = atMark(paid, mark, await drawnUnits(q, ownerId, mark))
  const standing = await loadStanding(q, ownerId, to)
  const plan = entitlementsFor(standing.plan, standing.limitOverrides)
  const anything = credits.length > 0 || [...left.values()].some((units) => units > 0)
  if (plan.includedUnits === null || !anything || to <= mark) {
    for (const credit of credits) left.set(credit.serverId, (left.get(credit.serverId) ?? 0) + credit.units)
    return { mark, covered: [], left }
  }
  // Month by month, the owner's, since their hours start again on the 1st.
  const zone = standing.timeZone ?? DEFAULT_TIME_ZONE
  const covered: Span[] = []
  let state = left
  for (let from = mark; from < to; from = nextMonthStart(from, zone)) {
    const until = new Date(Math.min(nextMonthStart(from, zone).getTime(), to.getTime()))
    const month = await monthSpans(q, standing, plan, to, from)
    if (month === null) break
    // What the month played before `from`, and what carried into it, without what was covered.
    const spans = [...month.before, { from: month.start, to: from }]
    const played = playOf(month, await uncovered(q, ownerId, spans, mark, covered))
    const drawn = draw({
      from: from.getTime(),
      to: until.getTime(),
      metered: played.units,
      included: played.included + played.carried,
      left: state,
      credits: credits.filter((credit) => credit.at > from.getTime() && credit.at <= until.getTime()),
      runs: await runsBetween(q, ownerId, from, until),
    })
    covered.push(...drawn.covered)
    state = drawn.left
  }
  return { mark, covered, left: state }
}

/**
 * What each server had left at the mark: what was chipped in by then, less what was drawn, and the
 * chip-ins paid since, each from when it was.
 */
function atMark(
  paid: ReadonlyArray<{ serverId: string; milli: number; netCents: number; refundedCents: number; at: Date }>,
  mark: Date,
  drawn: ReadonlyMap<string, number>,
) {
  const left = new Map<string, number>()
  const credits: Array<{ serverId: string; at: number; units: number }> = []
  for (const row of paid) {
    const units = heldMilli(row) / 1000
    if (row.at <= mark) left.set(row.serverId, (left.get(row.serverId) ?? 0) + units)
    else credits.push({ serverId: row.serverId, at: row.at.getTime(), units })
  }
  // A refund past what was left takes nothing back that was played.
  for (const [serverId, used] of drawn) left.set(serverId, Math.max(0, (left.get(serverId) ?? 0) - used))
  return { left, credits }
}

/**
 * This month's play (`accounts/play-month.ts` `PlayMonth`) without what hours chipped in covered:
 * in it, and in the months whose hours carried into it. Null on a plan with no monthly hours.
 */
export async function meteredMonth(
  q: Queryable,
  standing: Pick<AccountStanding, 'userId' | 'plan' | 'timeZone' | 'timeZoneFrom' | 'timeZoneBegan'>,
  plan: Pick<Entitlements, 'includedUnits' | 'carryUnits'>,
  now: Date,
  at: Date = now,
): Promise<PlayMonth | null> {
  const month = await monthSpans(q, standing, plan, now, at)
  if (month === null) return null
  const end = new Date(Math.min(month.next.getTime(), now.getTime()))
  const spans = [...month.before, { from: month.start, to: end }]
  return playOf(month, await meteredUnitsIn(q, standing.userId, spans, now))
}

/**
 * Play since `since`, up to `to`, in meter units, without what hours chipped in covered: what a
 * plan's monthly hours are measured against, and what extra play bills.
 */
export async function meteredUnitsSince(
  q: Queryable,
  ownerId: string,
  since: Date,
  to: Date,
): Promise<number> {
  const [units] = await meteredUnitsIn(q, ownerId, [{ from: since, to }], to)
  return units ?? 0
}

/** Play in each span, in meter units, without what hours chipped in covered up to `now`. */
async function meteredUnitsIn(q: Queryable, ownerId: string, spans: Spans, now: Date): Promise<number[]> {
  const pending = await pendingDraws(q, ownerId, now)
  if (pending === null) return runUnitsIn(q, ownerId, spans)
  return uncovered(q, ownerId, spans, pending.mark, pending.covered)
}

/**
 * Play in each span, in meter units, less what hours chipped in covered there: the draws kept up to
 * `mark`, and `covered`, worked out past it.
 */
async function uncovered(
  q: Queryable,
  ownerId: string,
  spans: Spans,
  mark: Date,
  covered: readonly Span[],
): Promise<number[]> {
  const units = await runUnitsIn(q, ownerId, spans)
  const kept = await keptCoveredIn(q, ownerId, spans, mark)
  return spans.map((span, i) => {
    const from = span.from.getTime()
    const to = span.to.getTime()
    const live = covered.reduce((sum, run) => sum + unitsWithin(run, from, to), 0)
    return Math.max(0, (units[i] ?? 0) - (kept[i] ?? 0) - live)
  })
}

/**
 * The owner's servers with hours chipped in left now, and how many: where a server may still run
 * once the month's hours, and any extra allowed, are used. Empty on a plan with no monthly hours.
 */
export async function chippedInLeft(
  q: Queryable,
  ownerId: string,
  now = new Date(),
): Promise<Map<string, number>> {
  const pending = await pendingDraws(q, ownerId, now)
  if (pending === null) return new Map()
  const standing = await loadStanding(q, ownerId, now)
  if (entitlementsFor(standing.plan, standing.limitOverrides).includedUnits === null) return new Map()
  return new Map([...pending.left].filter(([, units]) => units > 0))
}

/** Units each server had drawn from what was chipped in, in every draw kept that ends by `mark`. */
async function drawnUnits(q: Queryable, ownerId: string, mark: Date): Promise<Map<string, number>> {
  const rows = await q
    .select({
      serverId: draws.serverId,
      units: sql<string>`coalesce(sum(extract(epoch from (${draws.endedAt} - ${draws.startedAt})) * ${draws.rate}), 0)`,
    })
    .from(draws)
    .where(and(eq(draws.ownerId, ownerId), lte(draws.endedAt, mark)))
    .groupBy(draws.serverId)
  return new Map(rows.map((row) => [row.serverId, Number(row.units) / HOUR_S]))
}

/** Units the draws kept, up to `mark`, covered within each span. */
async function keptCoveredIn(q: Queryable, ownerId: string, spans: Spans, mark: Date): Promise<number[]> {
  if (spans.length === 0) return []
  const bounds = sql.join(
    spans.map((span, i) => sql`(${i}::int, ${span.from}::timestamptz, ${span.to}::timestamptz)`),
    sql`, `,
  )
  const rows = await q
    .select({
      span: sql<number>`span.i`,
      units: sql<string>`sum(extract(epoch from (least(${draws.endedAt}, span.e) - greatest(${draws.startedAt}, span.s))) * ${draws.rate})`,
    })
    .from(draws)
    .innerJoin(
      sql`(values ${bounds}) as span(i, s, e)`,
      sql`${draws.endedAt} > span.s and ${draws.startedAt} < span.e`,
    )
    .where(and(eq(draws.ownerId, ownerId), lte(draws.endedAt, mark)))
    .groupBy(sql`span.i`)
  const units = spans.map(() => 0)
  for (const row of rows) units[Number(row.span)] = Number(row.units) / HOUR_S
  return units
}

/** The owner's servers' runs within `[from, to)`, clipped to it, each at its size's units an hour. */
async function runsBetween(q: Queryable, ownerId: string, from: Date, to: Date): Promise<Span[]> {
  const intervals = schema.powerIntervals
  const owned = q.select({ id: servers.id }).from(servers).where(eq(servers.ownerId, ownerId))
  const rows = await q
    .select({
      serverId: intervals.serverId,
      start: countedFrom(intervals),
      end: intervals.stoppedAt,
      tier: intervals.memoryTier,
    })
    .from(intervals)
    .where(
      and(
        inArray(intervals.serverId, owned),
        sql`${countedFrom(intervals)} < ${to}`,
        sql`coalesce(${intervals.stoppedAt}, ${to}) > ${from}`,
      ),
    )
  return rows.map((row) => ({
    serverId: row.serverId,
    start: Math.max(new Date(row.start ?? to).getTime(), from.getTime()),
    end: Math.min((row.end ?? to).getTime(), to.getTime()),
    // As `runUnitsSince` counts it: a size the meter doesn't know is one unit an hour.
    rate: METER_UNITS[row.tier as keyof typeof METER_UNITS] ?? 1,
  }))
}
