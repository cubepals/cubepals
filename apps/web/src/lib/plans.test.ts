// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { PublicPlan } from '@blockly/contracts'
import { extraHourOf, forSale, pitchOf, planPoints, priceOf } from '../ui/plans.tsx'
import { daysSaid, hoursAgainSaid, hoursSaid } from './plans.ts'

const free: PublicPlan = {
  key: 'free',
  name: 'Free trial',
  available: true,
  monthlyPriceCents: 0,
  yearlyPriceCents: null,
  includedHours: 2,
  per: 'day',
  extraHourCents: null,
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
const core: PublicPlan = {
  ...free,
  key: 'core',
  name: 'Core',
  monthlyPriceCents: 999,
  includedHours: 40,
  per: 'month',
  extraHourCents: 25,
  totalHours: null,
  sleepsAfterMinutes: 15,
  downloads: 'history',
  sessionsKept: 14,
  restsAfterDays: 30,
  deletedAfterDays: null,
}
const plus: PublicPlan = {
  ...free,
  key: 'plus',
  name: 'Plus',
  monthlyPriceCents: 2500,
  yearlyPriceCents: 25000,
  includedHours: 120,
  per: 'month',
  extraHourCents: 25,
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
      'Plain Minecraft',
      'Go back to any of your last 3 sessions, and download your world',
    ])
  })

  test('Plus says what it adds', () => {
    expect(priceOf(plus.monthlyPriceCents)).toBe('$25 a month')
    expect(priceOf(450)).toBe('$4.50 a month')
    expect(planPoints(plus)).toEqual([
      'Up to 3 servers and 40 players',
      '120 hours of play each month, then 25¢ an hour',
      'Modpacks, mods, plugins and datapacks',
      'Go back to any of your last 14 sessions, and a weekly download',
    ])
  })

  test('no card names a server type', () => {
    for (const plan of [free, core, plus])
      expect(planPoints(plan).join(' ')).not.toMatch(/vanilla|paper|fabric|forge/i)
  })

  test('a plans answer from before the new fields still reads: no clause says undefined, and no plan looks off sale', () => {
    // What an API that predates `extraHourCents` and `available` sends.
    const { extraHourCents: _e, available: _a, ...old } = plus
    const oldPlus = old as unknown as PublicPlan
    expect(planPoints(oldPlus).join(' ')).not.toContain('undefined')
    expect(planPoints(oldPlus)[1]).toBe('120 hours of play each month')
    expect(forSale(oldPlus)).toBe(true)
    expect(extraHourOf(oldPlus)).toBeNull()
    // Only the API saying so takes a plan off sale.
    expect(forSale({ ...plus, available: false })).toBe(false)
    expect(forSale({ ...plus, available: true })).toBe(true)
  })

  test('Core is one server for a group of friends, with its hours in the details', () => {
    expect(priceOf(core.monthlyPriceCents)).toBe('$9.99 a month')
    expect(planPoints(core)).toEqual([
      '1 server, up to 5 players',
      '40 hours of play each month, then 25¢ an hour',
      'Plain Minecraft',
      'Go back to any of your last 14 sessions, and a weekly download',
    ])
  })

  test('each card leads with who it is for, and never with hours', () => {
    expect(pitchOf(free)).toBe('Try plain Minecraft with friends, no card')
    expect(pitchOf(core, true)).toBe('Plain Minecraft for you and 4 friends, Java and Bedrock together')
    expect(pitchOf(plus)).toBe('Mods, plugins and modpacks, for bigger groups')
    for (const plan of [free, core, plus]) expect(pitchOf(plan)).not.toMatch(/hour/i)
  })

  test('Core promises nothing about Bedrock until Bedrock is on', () => {
    expect(pitchOf(core)).toBe('Plain Minecraft for you and 4 friends')
    expect(pitchOf(core, false)).not.toMatch(/bedrock/i)
  })

  test('nothing a plan says is about machines, and nothing says "turn on"', () => {
    const said = [...planPoints(free), ...planPoints(core), ...planPoints(plus), pitchOf(core)].join(' ')
    for (const word of ['GB', 'RAM', 'CPU', 'unit', 'vCPU', 'machine', 'volume', 'turn on'])
      expect(said).not.toContain(word)
  })

  test('hours as people say them, and when they start again', () => {
    expect([hoursSaid(free), hoursSaid(core), hoursSaid(plus)]).toEqual([
      '20 hours in all, at most 2 a day',
      '40 hours a month',
      '120 hours a month',
    ])
    expect(hoursAgainSaid([free, core, plus])).toBe(
      'the hours start again: the free trial’s at midnight where you are, until its 20 are played; Core’s and Plus’s on the 1st',
    )
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
