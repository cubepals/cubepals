// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a day costs the owner at the provider, worked out from what the control plane recorded:
 * the price list and the arithmetic, nothing read or written. The spend watchdog
 * (`app/operations/schedules/spend.ts`) gathers the facts and acts on the answer. It is not the economics
 * report (`app/runtimes/economics.ts`), which judges runtimes against revenue: this is a guard, so
 * where it can't tell it counts high rather than low.
 *
 * Prices are Fly's list prices from 2026-10-01 in Frankfurt, the dearest region servers run in:
 * servers in iad cost less than this says, never more.
 */
import type { MemoryTier } from '../server/size.ts'

/** A running hour by size, in US cents. A size no longer sold costs what the machine it runs on does. */
export const HOUR_CENTS: Record<MemoryTier, number> = {
  // 2 GB is no longer sold; priced as the 3 GB machine, which costs a little more.
  '2g': 6.25,
  '3g': 6.25,
  '4g': 10.6,
  // 6 GB ran on the 8 GB machine (entitlements.ts).
  '6g': 21.2,
  '8g': 21.2,
}

/** A size the table doesn't know, or compute whose size nobody recorded: the dearest there is. */
export const UNKNOWN_HOUR_CENTS = Math.max(...Object.values(HOUR_CENTS))

/** A volume, a GB a month ($0.15), and a month in hours as Fly bills it. */
const VOLUME_GB_MONTH_CENTS = 15
const MONTH_HOURS = 730

const hourCents = (tier: string): number => HOUR_CENTS[tier as MemoryTier] ?? UNKNOWN_HOUR_CENTS

/** Hours of a run that fall inside `[from, to)`. An open run counts up to `to`. */
export function hoursWithin(run: { startedAt: Date; stoppedAt: Date | null }, from: Date, to: Date): number {
  const start = Math.max(run.startedAt.getTime(), from.getTime())
  const end = Math.min((run.stoppedAt ?? to).getTime(), to.getTime())
  return Math.max(0, end - start) / 3_600_000
}

export interface DayFacts {
  /** Midnight UTC that began the day, and the moment it is worked out to. */
  from: Date
  to: Date
  /** Power intervals that overlap the day, each with the size it ran at. */
  runs: ReadonlyArray<{ tier: string; startedAt: Date; stoppedAt: Date | null }>
  /** Compute the provider runs that no running server accounts for, since it was last seen to change. */
  stray: ReadonlyArray<{ tier: string | null; since: Date }>
  /** The disks held now, in GB: held all day, as far as anyone can tell from here. */
  diskGb: number
}

export interface DaySpend {
  computeCents: number
  strayCents: number
  storageCents: number
  cents: number
}

/** The day so far. Each part is rounded up to a whole cent, so the total never reads low. */
export function daySpend(facts: DayFacts): DaySpend {
  const { from, to } = facts
  const compute = facts.runs.reduce((sum, run) => sum + hoursWithin(run, from, to) * hourCents(run.tier), 0)
  const stray = facts.stray.reduce(
    (sum, s) =>
      sum +
      hoursWithin({ startedAt: s.since, stoppedAt: null }, from, to) *
        (s.tier === null ? UNKNOWN_HOUR_CENTS : hourCents(s.tier)),
    0,
  )
  const elapsed = Math.max(0, to.getTime() - from.getTime()) / 3_600_000
  const storage = (facts.diskGb * VOLUME_GB_MONTH_CENTS * elapsed) / MONTH_HOURS
  const parts = { computeCents: up(compute), strayCents: up(stray), storageCents: up(storage) }
  return { ...parts, cents: parts.computeCents + parts.strayCents + parts.storageCents }
}

/** Up to a whole cent, after floating point's dust is swept off: 5088.0000001 is 5088. */
const up = (cents: number): number => Math.ceil(Math.round(cents * 1e6) / 1e6)

/** Whether the day has passed its limit: the limit itself may be spent, a cent more may not. */
export const overLimit = (spend: DaySpend, limitCents: number): boolean => spend.cents > limitCents

/** Midnight UTC that began the day `at` is in, and its `YYYY-MM-DD`. */
export function utcDay(at: Date): { from: Date; day: string } {
  const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
  return { from, day: from.toISOString().slice(0, 10) }
}

/** `$12.34`, for logs, emails and the admin page. */
export const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`
