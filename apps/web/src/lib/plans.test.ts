// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { PublicPlan } from '@blockly/contracts'
import { planPoints, priceOf } from '../ui/plans.tsx'
import { daysSaid, hoursAgainSaid, hoursSaid } from './plans.ts'

const free: PublicPlan = {
  key: 'free',
  name: 'Free trial',
  monthlyPriceCents: 0,
  yearlyPriceCents: null,
  includedHours: 2,
  per: 'day',
  totalHours: 20,
  sleepsAfterMinutes: 10,
  maxServers: 1,
  maxPlayers: 5,
  mods: false,
  datapacks: false,
  downloads: 'daily',
  sessionsKept: 3,
  restsAfterDays: 14,
  deletedAfterDays: 365,
}
const plus: PublicPlan = {
  ...free,
  key: 'plus',
  name: 'Plus',
  monthlyPriceCents: 2500,
  yearlyPriceCents: 25000,
  includedHours: 120,
  per: 'month',
  totalHours: null,
  sleepsAfterMinutes: 15,
  maxServers: 3,
  maxPlayers: 40,
  mods: true,
  datapacks: true,
  downloads: 'history',
  sessionsKept: 14,
  restsAfterDays: 30,
  deletedAfterDays: null,
}

// What the pricing, landing and account pages say about a plan: what people choose on, in their
// words, and never a machine's.
describe('plans as people read them', () => {
  test('The free trial says what it is, with nothing crossed out', () => {
    expect(priceOf(free.monthlyPriceCents)).toBe('$0')
    expect(planPoints(free)).toEqual([
      '1 server, up to 5 players',
      '20 hours of play, at most 2 a day',
      'Vanilla or Paper',
      'Go back to any of your last 3 sessions, and download your world',
    ])
  })

  test('Plus says what it adds', () => {
    expect(priceOf(plus.monthlyPriceCents)).toBe('$25 a month')
    expect(priceOf(450)).toBe('$4.50 a month')
    expect(planPoints(plus)).toEqual([
      'Up to 3 servers and 40 players',
      '120 hours of play each month',
      'Modpacks, mods, plugins and datapacks',
      'Go back to any of your last 14 sessions, and a weekly download',
    ])
  })

  test('nothing a plan says is about machines, and nothing says "turn on"', () => {
    const said = [...planPoints(free), ...planPoints(plus)].join(' ')
    for (const word of ['GB', 'RAM', 'CPU', 'unit', 'vCPU', 'machine', 'volume', 'turn on'])
      expect(said).not.toContain(word)
  })

  test('hours as people say them, and when they start again', () => {
    expect([hoursSaid(free), hoursSaid(plus)]).toEqual([
      '20 hours in all, at most 2 a day',
      '120 hours a month',
    ])
    expect(hoursAgainSaid([free, plus])).toBe(
      'the hours start again: the free trial’s at midnight where you are, until its 20 are played; Plus’s on the 1st',
    )
    expect(hoursAgainSaid([])).toBe('the hours start again')
  })

  test('days as people say them', () => {
    expect([14, 30, 365, 21, 10].map(daysSaid)).toEqual([
      'two weeks',
      'a month',
      'a year',
      '3 weeks',
      '10 days',
    ])
  })
})
