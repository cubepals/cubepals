// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a chip-in buys and which play its hours cover: the pure rules, hour by hour, without a
 * database. Paying and keeping them is `app/billing/chip-ins.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { HOUR_MS } from '@blockly/contracts/durations'
import { type DrawInput, draw, heldMilli, milliFor, unitsWithin } from './chip-in.ts'

const h = (hours: number) => hours * HOUR_MS
const run = (serverId: string, from: number, to: number, rate = 1) => ({
  serverId,
  start: h(from),
  end: h(to),
  rate,
})
const input = (patch: Partial<DrawInput>): DrawInput => ({
  from: 0,
  to: h(10),
  metered: 0,
  included: 100,
  left: new Map(),
  credits: [],
  runs: [],
  ...patch,
})
const hoursOf = (spans: ReturnType<typeof draw>['covered']) =>
  spans.map((span) => ({ serverId: span.serverId, from: span.start / HOUR_MS, to: span.end / HOUR_MS }))

describe('what a chip-in buys', () => {
  test('hours at the price of extra play, refunds taking their share back', () => {
    expect(milliFor(500)).toBe(20_000)
    expect(milliFor(700)).toBe(28_000)
    // A refund of half of what it cost before tax takes half its hours.
    expect(heldMilli({ milli: 28_000, netCents: 560, refundedCents: 280, withdrawnMilli: 0 })).toBe(14_000)
    expect(heldMilli({ milli: 20_000, netCents: 500, refundedCents: 500, withdrawnMilli: 0 })).toBe(0)
    // Cancelled with 15 hours unplayed: it holds the 5 played, and the refund for the 15 takes no more.
    expect(heldMilli({ milli: 20_000, netCents: 500, refundedCents: 0, withdrawnMilli: 15_000 })).toBe(5_000)
    expect(heldMilli({ milli: 20_000, netCents: 500, refundedCents: 375, withdrawnMilli: 15_000 })).toBe(
      5_000,
    )
  })
})

describe('which play hours chipped in cover', () => {
  test('none while the month’s included hours last', () => {
    const drawn = draw(input({ metered: 50, left: new Map([['a', 20]]), runs: [run('a', 0, 10)] }))
    expect(drawn.covered).toEqual([])
    expect(drawn.left.get('a')).toBe(20)
  })

  test('from the moment the included hours are used, on the server they were chipped in to', () => {
    const drawn = draw(input({ metered: 96, left: new Map([['a', 20]]), runs: [run('a', 0, 10)] }))
    expect(hoursOf(drawn.covered)).toEqual([{ serverId: 'a', from: 4, to: 10 }])
    expect(drawn.left.get('a')).toBeCloseTo(14)
  })

  test('only the server with hours left; another counts on, as extra', () => {
    const drawn = draw(
      input({ metered: 99, left: new Map([['a', 20]]), runs: [run('a', 0, 4), run('b', 0, 4)] }),
    )
    // Both count until the hundredth hour, half an hour in; then only `a` is covered.
    expect(hoursOf(drawn.covered)).toEqual([{ serverId: 'a', from: 0.5, to: 4 }])
  })

  test('until they run out, a large server using two an hour', () => {
    const drawn = draw(input({ metered: 100, left: new Map([['a', 3]]), runs: [run('a', 0, 10, 2)] }))
    expect(hoursOf(drawn.covered)).toEqual([{ serverId: 'a', from: 0, to: 1.5 }])
    expect(drawn.left.get('a')).toBe(0)
  })

  test('from when they were paid, never before', () => {
    const drawn = draw(
      input({ metered: 100, credits: [{ serverId: 'a', at: h(6), units: 20 }], runs: [run('a', 0, 10)] }),
    )
    expect(hoursOf(drawn.covered)).toEqual([{ serverId: 'a', from: 6, to: 10 }])
    expect(drawn.left.get('a')).toBeCloseTo(16)
  })

  test('a span is counted within a window by its rate', () => {
    expect(unitsWithin(run('a', 2, 6, 2), h(0), h(4))).toBeCloseTo(4)
    expect(unitsWithin(run('a', 2, 6, 2), h(7), h(9))).toBe(0)
  })
})
