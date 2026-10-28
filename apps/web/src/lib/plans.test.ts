// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { PublicPlan } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { extraHourOf, forSale, hoursPoint, PlanCard, pitchOf, planPoints, priceOf } from '../ui/plans.tsx'
import { daysSaid, hoursAgainSaid, hoursSaid } from './plans.ts'

const free: PublicPlan = {
  key: 'free',
  name: 'Free trial',
  available: true,
  monthlyPriceCents: 0,
  yearlyPriceCents: null,
  includedHours: 20,
  per: 'once',
  extraHourCents: null,
  totalHours: 20,
  sleepsAfterMinutes: 10,
  maxServers: 1,
  maxPlayers: 5,
  sizes: [{ gb: 3, maxPlayers: 5, hoursAnHour: 1 }],
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
  sizes: [
    { gb: 3, maxPlayers: 5, hoursAnHour: 1 },
    { gb: 4, maxPlayers: 10, hoursAnHour: 1 },
    { gb: 8, maxPlayers: 40, hoursAnHour: 2 },
  ],
  mods: true,
  datapacks: true,
  downloads: 'history',
  sessionsKept: 14,
  restsAfterDays: 30,
  deletedAfterDays: null,
}

type Card = Parameters<typeof renderToStaticMarkup>[0]
/** A card as the page gets it. */
const htmlOf = (card: Card) => renderToStaticMarkup(card)
/** A card's points in order, each as the markup of its list item. */
const pointsOf = (card: Card) => htmlOf(card).split('<li').slice(1)

// What the pricing, landing and account pages say about a plan: what people choose on, in their
// words, and never a machine's.
describe('plans as people read them', () => {
  test('The free trial says what it is, with nothing crossed out', () => {
    expect(priceOf(free.monthlyPriceCents)).toBe('$0')
    expect(planPoints(free)).toEqual([
      '1 server of 3 GB, up to 5 players',
      '20 hours of play, any day you like',
      'Plain Minecraft',
      'Go back to any of your last 3 sessions, and download your world',
    ])
  })

  test('Plus says what it adds', () => {
    expect(priceOf(plus.monthlyPriceCents)).toBe('$25 a month')
    expect(priceOf(450)).toBe('$4.50 a month')
    expect(planPoints(plus)).toEqual([
      'Up to 3 servers and 40 players, 3 to 8 GB each',
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
    // What an API that predates `extraHourCents`, `available` and `sizes` sends.
    const { extraHourCents: _e, available: _a, sizes: _s, ...old } = plus
    const oldPlus = old as unknown as PublicPlan
    expect(planPoints(oldPlus).join(' ')).not.toContain('undefined')
    expect(planPoints(oldPlus)[0]).toBe('Up to 3 servers and 40 players')
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
      '1 server of 3 GB, up to 5 players',
      '40 hours of play each month, then 25¢ an hour',
      'Plain Minecraft',
      'Go back to any of your last 14 sessions, and a weekly download',
    ])
  })

  test('each card leads with who it is for, and never with hours', () => {
    expect(pitchOf(core, true)).toBe('Plain Minecraft for you and 4 friends, Java and Bedrock together')
    expect(pitchOf(plus)).toBe('Mods, plugins and modpacks, for bigger groups')
    for (const plan of [core, plus]) expect(pitchOf(plan)).not.toMatch(/hour/i)
  })

  test('Core promises nothing about Bedrock until Bedrock is on', () => {
    expect(pitchOf(core)).toBe('Plain Minecraft for you and 4 friends')
    expect(pitchOf(core, false)).not.toMatch(/bedrock/i)
  })

  test('nothing a plan says is about machines but its servers’ size, and nothing says "turn on"', () => {
    const said = [...planPoints(free), ...planPoints(core), ...planPoints(plus), pitchOf(core)].join(' ')
    for (const word of ['RAM', 'CPU', 'unit', 'vCPU', 'machine', 'volume', 'turn on'])
      expect(said).not.toContain(word)
    expect(pitchOf(core)).not.toContain('GB')
  })

  test('hours as people say them, and when they start again', () => {
    expect([hoursSaid(free), hoursSaid(core), hoursSaid(plus)]).toEqual([
      '20 hours in all, any day you like',
      '40 hours a month',
      '120 hours a month',
    ])
    // The free trial's hours come once and never start again: its end is said apart.
    expect(hoursAgainSaid([free, core, plus])).toBe('the hours start again: Core’s and Plus’s on the 1st')
    expect(hoursAgainSaid([free, plus])).toBe('the hours start again: Plus’s on the 1st')
    expect(hoursAgainSaid([])).toBe('the hours start again')
  })

  test('the account page says the free trial on Core, after its hours, as the public pages do', () => {
    const points = pointsOf(createElement(PlanCard, { plan: core, trial: free }))
    // The plans' own numbers, so the test follows whatever the plans say.
    const hours = points.findIndex((point) => point.includes(hoursPoint(core)))
    expect(hours).toBeGreaterThanOrEqual(0)
    const trial = points[hours + 1] ?? ''
    for (const part of ['Starts with a free trial: ', hoursPoint(free), ', no card'])
      expect(trial).toContain(part)
    expect(htmlOf(createElement(PlanCard, { plan: plus }))).not.toContain('free trial')
  })

  test('someone on the free trial finds it on the plan it starts', () => {
    expect(htmlOf(createElement(PlanCard, { plan: core, trial: free, current: 'trial' }))).toContain(
      'Your free trial',
    )
    const plusYours = htmlOf(createElement(PlanCard, { plan: plus, current: true }))
    expect(plusYours).toContain('Yours')
    expect(plusYours).not.toContain('Your free trial')
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
