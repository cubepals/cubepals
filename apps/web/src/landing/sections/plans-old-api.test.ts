// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The landing's plans against a plans API from before `available` and `extraHourCents` existed,
 * which is what the site meets for the minutes the site and the API deploy apart: a paid plan
 * still has its button, and no clause says undefined.
 */
import { describe, expect, test } from 'bun:test'
import type { PublicPlan } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlansSaid } from './Plans'

const oldShape = (plan: Omit<PublicPlan, 'available' | 'extraHourCents'>) => plan as unknown as PublicPlan
const base = {
  yearlyPriceCents: null,
  sleepsAfterMinutes: 15,
  downloads: 'history' as const,
  sessionsKept: 14,
  restsAfterDays: 30,
  deletedAfterDays: null,
  datapacks: true,
  per: 'month' as const,
  totalHours: null,
}
const PLANS = [
  oldShape({
    ...base,
    key: 'free',
    name: 'Free trial',
    monthlyPriceCents: 0,
    includedHours: 2,
    per: 'day',
    totalHours: 20,
    maxServers: 1,
    maxPlayers: 5,
    mods: false,
    datapacks: false,
    downloads: 'daily',
    sessionsKept: 3,
  }),
  oldShape({
    ...base,
    key: 'plus',
    name: 'Plus',
    monthlyPriceCents: 2500,
    includedHours: 120,
    maxServers: 3,
    maxPlayers: 100,
    mods: true,
  }),
]

describe('the landing’s plans against an older plans API', () => {
  const landing = (plans: PublicPlan[]) =>
    renderToStaticMarkup(
      createElement(PlansSaid, { plans, create: '/servers/new', getPlan: () => '/checkout', bedrock: false }),
    )
  const html = landing(PLANS)

  test('a paid plan keeps its button, and only an explicit not-for-sale takes it away', () => {
    // The trial starts Plus here, so Start free is its one button.
    expect(html).toContain('Start free')
    expect(landing(PLANS.slice(1))).toContain('Get Plus')
    const alone = landing([{ ...(PLANS[1] as PublicPlan), available: false }])
    expect(alone).toContain('Not available yet')
  })

  test('no clause says undefined, and Plus names no server type', () => {
    // What people read: the markup's class names are the test runner's, with no stylesheet behind them.
    const said = html.replace(/<[^>]+>/g, ' ')
    expect(said).not.toContain('undefined')
    expect(said).not.toMatch(/vanilla|paper/i)
  })
})
