// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Friends chipping in to a server: what a chip-in buys, and which play the hours cover. Pure. A
 * chip-in buys hours at the price of extra play (`meter.ts`), kept on the server until played. They
 * cover the server's play once its owner's hours for the month (the plan's, and what carried) are
 * used, before any extra play the owner would pay for, so a month's hours last longer and nothing
 * the friends paid for is spent while the owner's own hours would have done. It is not where they
 * are paid or capped (`app/billing/chip-ins.ts`) or read (`app/billing/chip-in-meter.ts`).
 */
import { HOUR_MS } from '@blockly/contracts/durations'
import { UNIT_CENTS } from './meter.ts'

/** The hours a chip-in of `cents` buys, in thousandths, rounded down: $5 is 20 hours. */
export const milliFor = (cents: number): number => Math.floor((cents * 1000) / UNIT_CENTS)

/**
 * What a chip-in still holds once part of it was refunded: the same share of its hours as of what
 * it cost before tax, which is how the provider counts a refund. One its payer cancelled holds no
 * more than was played by then (`withdrawnMilli` taken off), and the refund that follows takes
 * nothing more unless it is for more than that.
 */
export const heldMilli = (chipIn: {
  milli: number
  netCents: number
  refundedCents: number
  withdrawnMilli: number
}): number => {
  const refunded =
    chipIn.netCents <= 0
      ? 0
      : Math.max(0, Math.floor((chipIn.milli * (chipIn.netCents - chipIn.refundedCents)) / chipIn.netCents))
  return Math.max(0, Math.min(refunded, chipIn.milli - chipIn.withdrawnMilli))
}

/** A server running, from `start` to `end` (ms), counting `rate` units an hour; or play covered. */
export interface Span {
  serverId: string
  start: number
  end: number
  rate: number
}

export interface DrawInput {
  /** The time to draw over, within one of the owner's months. */
  from: number
  to: number
  /** What the owner's play already counted against the month's included hours before `from`. */
  metered: number
  /** The owner's hours for the month, in units: the plan's, and what carried into it. */
  included: number
  /** What each server has left chipped in at `from`, in units. */
  left: ReadonlyMap<string, number>
  /** Chip-ins paid after `from`: each server's hours grow by `units` at `at`. */
  credits: ReadonlyArray<{ serverId: string; at: number; units: number }>
  /** The owner's servers running in the window. */
  runs: readonly Span[]
}

/** What draws covered, and what each server has left at `to`. */
export interface Drawn {
  covered: Span[]
  left: Map<string, number>
}

const EPSILON = 1e-9

/**
 * Which play in the window hours chipped in cover. Play counts against the included hours, all
 * servers together, until they are used; from that moment each server with hours left covers its
 * own play, at its own rate, until they run out, and the rest counts as before (as extra, where
 * the owner allows it). Hours chipped in cover play from when they were paid, never before.
 */
export function draw(input: DrawInput): Drawn {
  const state: State = { metered: input.metered, left: new Map(input.left), covered: [] }
  const credits = [...input.credits].sort((a, b) => a.at - b.at)
  const times = cutsOf(input)
  for (let i = 0; i + 1 < times.length; i++) {
    const from = times[i] as number
    const to = times[i + 1] as number
    pay(state, credits, from)
    const active = input.runs.filter((run) => run.start <= from && run.end >= to)
    for (let t = from; t < to; ) t = step(state, active, input.included, t, to)
  }
  pay(state, credits, input.to)
  return { covered: state.covered, left: state.left }
}

/** Adds the chip-ins paid by `at` to what their servers have left, taking them off `credits`. */
function pay(state: State, credits: DrawInput['credits'][number][], at: number): void {
  while ((credits[0]?.at ?? Number.POSITIVE_INFINITY) <= at) {
    const credit = credits.shift() as DrawInput['credits'][number]
    state.left.set(credit.serverId, (state.left.get(credit.serverId) ?? 0) + credit.units)
  }
}

/** What a draw carries from one moment to the next. */
interface State {
  metered: number
  left: Map<string, number>
  covered: Span[]
}

/** Every moment who runs, or what is chipped in, changes: a run starting or ending, a chip-in paid. */
function cutsOf(input: DrawInput): number[] {
  const inside = (at: number) => at > input.from && at < input.to
  const cuts = new Set([input.from, input.to])
  for (const run of input.runs) for (const at of [run.start, run.end]) if (inside(at)) cuts.add(at)
  for (const credit of input.credits) if (inside(credit.at)) cuts.add(credit.at)
  return [...cuts].sort((a, b) => a - b)
}

/**
 * From `t` to the next moment who draws changes, no later than `to`: the included hours being
 * used, or a server drawing running out. Answers that moment.
 */
function step(state: State, active: readonly Span[], included: number, t: number, to: number): number {
  const past = state.metered >= included - EPSILON
  const drawing = past ? active.filter((run) => (state.left.get(run.serverId) ?? 0) > EPSILON) : []
  const counting = active.filter((run) => !drawing.includes(run)).reduce((sum, run) => sum + run.rate, 0)
  const used =
    !past && counting > 0 ? t + ((included - state.metered) / counting) * HOUR_MS : Number.POSITIVE_INFINITY
  const runsOut = drawing.map((run) => t + ((state.left.get(run.serverId) ?? 0) / run.rate) * HOUR_MS)
  // A step too small for the clock to tell apart still moves on.
  const next = Math.max(Math.min(to, used, ...runsOut), Math.min(to, t + 1))
  const hours = (next - t) / HOUR_MS
  state.metered = next >= used ? included : state.metered + counting * hours
  for (const run of drawing) {
    const rest = (state.left.get(run.serverId) ?? 0) - run.rate * hours
    state.left.set(run.serverId, rest > EPSILON ? rest : 0)
    extend(state.covered, { serverId: run.serverId, start: t, end: next, rate: run.rate })
  }
  return next
}

/** Adds a span, joined to the one before it where it carries straight on from it. */
function extend(spans: Span[], span: Span): void {
  const last = spans.findLast((s) => s.serverId === span.serverId)
  if (last !== undefined && last.end === span.start && last.rate === span.rate) last.end = span.end
  else spans.push(span)
}

/** The units a span covers within `[from, to)`. */
export const unitsWithin = (span: Span, from: number, to: number): number =>
  Math.max(0, Math.min(span.end, to) - Math.max(span.start, from)) * (span.rate / HOUR_MS)
