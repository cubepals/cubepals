import { describe, expect, test } from 'bun:test'
import type { PublicPlan } from '@blockly/contracts'
import { planPoints, priceOf } from '../ui/plans.tsx'
import { daysSaid } from './plans.ts'

const free: PublicPlan = {
  key: 'free',
  name: 'Free',
  monthlyPriceCents: 0,
  includedHours: 20,
  sleepsAfterMinutes: 10,
  maxServers: 1,
  maxPlayers: 5,
  mods: false,
  downloads: 'daily',
  restsAfterDays: 14,
  deletedAfterDays: 365,
}
const plus: PublicPlan = {
  ...free,
  key: 'plus',
  name: 'Plus',
  monthlyPriceCents: 1500,
  includedHours: 60,
  sleepsAfterMinutes: 15,
  maxServers: 3,
  maxPlayers: 40,
  mods: true,
  downloads: 'history',
  restsAfterDays: 30,
  deletedAfterDays: null,
}

// What the pricing, landing and account pages say about a plan: what people choose on, in their
// words, and never a machine's.
describe('plans as people read them', () => {
  test('Free says what it is, with nothing crossed out', () => {
    expect(priceOf(free.monthlyPriceCents)).toBe('$0')
    expect(planPoints(free)).toEqual([
      '1 server, up to 5 players',
      '20 hours of play each month',
      'Vanilla or Paper',
      'Daily backups and world downloads',
    ])
  })

  test('Plus says what it adds', () => {
    expect(priceOf(plus.monthlyPriceCents)).toBe('$15 a month')
    expect(priceOf(450)).toBe('$4.50 a month')
    expect(planPoints(plus)).toEqual([
      'Up to 3 servers and 40 players',
      '60 hours of play each month',
      'Modpacks, mods and plugins',
      'Weekly backups to download',
    ])
  })

  test('nothing a plan says is about machines, and nothing says "turn on"', () => {
    const said = [...planPoints(free), ...planPoints(plus)].join(' ')
    for (const word of ['GB', 'RAM', 'CPU', 'unit', 'vCPU', 'machine', 'volume', 'turn on'])
      expect(said).not.toContain(word)
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
