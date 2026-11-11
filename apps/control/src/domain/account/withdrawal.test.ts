// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Refunds page's rule for a purchase cancelled within 14 days, each kind on each side of the
 * line and of once per person, and what a cent's doubt gives.
 */
import { describe, expect, test } from 'bun:test'
import { entitlementsFor } from './entitlements.ts'
import { FULL_REFUND_UNDER_HOURS as LINE, type Withdrawn, withdrawalAmount } from './withdrawal.ts'

const HOURS = entitlementsFor('plus').includedUnits ?? Number.NaN
const month = (playedUnits: number, earlierFull = false): Withdrawn => ({
  kind: 'time',
  paidCents: 1500,
  months: 1,
  started: true,
  playedUnits,
  includedUnits: HOURS,
  earlierFull,
})

describe('a first month cancelled within 14 days', () => {
  test('below the line, everything comes back', () => {
    expect(withdrawalAmount(month(0))).toEqual({ refundCents: 1500, rule: 'full' })
    expect(withdrawalAmount(month(LINE - 0.001))).toEqual({ refundCents: 1500, rule: 'full' })
  })

  test('at the line and past it, the hours played are paid for out of the month’s', () => {
    expect(withdrawalAmount(month(LINE))).toEqual({
      refundCents: 1500 - Math.floor((1500 * LINE) / HOURS),
      rule: 'played',
    })
    expect(withdrawalAmount(month(60))).toEqual({
      refundCents: 1500 - Math.floor((1500 * 60) / HOURS),
      rule: 'played',
    })
  })

  test('all the month’s hours played leaves nothing, and more never goes below nothing', () => {
    expect(withdrawalAmount(month(HOURS)).refundCents).toBe(0)
    expect(withdrawalAmount(month(HOURS * 3)).refundCents).toBe(0)
  })

  test('the full refund is once per person: after one, the hours played are paid for', () => {
    expect(withdrawalAmount(month(1, true))).toEqual({
      refundCents: 1500 - Math.floor(1500 / HOURS),
      rule: 'played',
    })
    expect(withdrawalAmount(month(0, true))).toEqual({ refundCents: 1500, rule: 'played' })
  })
})

describe('a year cancelled within 14 days', () => {
  const year = (playedUnits: number, started = true, earlierFull = false): Withdrawn => ({
    kind: 'time',
    paidCents: 15000,
    months: 12,
    started,
    playedUnits,
    includedUnits: HOURS,
    earlierFull,
  })

  test('below the line, everything; past it, the first month’s twelfth as a month, the rest in full', () => {
    expect(withdrawalAmount(year(LINE - 1))).toEqual({ refundCents: 15000, rule: 'full' })
    expect(withdrawalAmount(year(60))).toEqual({
      refundCents: 15000 - Math.floor((15000 * 60) / HOURS / 12),
      rule: 'played',
    })
    expect(withdrawalAmount(year(HOURS * 2)).refundCents).toBe(15000 - 1250)
  })

  test('a renewal paid ahead that hasn’t started comes back whole, whatever came before', () => {
    expect(withdrawalAmount(year(0, false, true))).toEqual({ refundCents: 15000, rule: 'unstarted' })
  })
})

describe('gifts and chip-ins', () => {
  test('a gift nobody redeemed comes back whole', () => {
    expect(withdrawalAmount({ kind: 'unredeemed', paidCents: 1500 })).toEqual({
      refundCents: 1500,
      rule: 'unredeemed',
    })
  })

  test('a chip-in gives back the share for the hours nobody played', () => {
    const chipIn = (playedMilli: number) =>
      withdrawalAmount({ kind: 'chip_in', paidCents: 500, milli: 20_000, playedMilli })
    expect(chipIn(0)).toEqual({ refundCents: 500, rule: 'unplayed' })
    expect(chipIn(5_000)).toEqual({ refundCents: 375, rule: 'unplayed' })
    expect(chipIn(20_000)).toEqual({ refundCents: 0, rule: 'unplayed' })
    // A third of a cent played is kept as nothing.
    expect(chipIn(13)).toEqual({ refundCents: 500, rule: 'unplayed' })
  })
})
