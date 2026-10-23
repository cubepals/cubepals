// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The landing's plan cards: one to each paid plan, Core starting with the free trial, a few lines
 * of what you get on each, and the hours and the rest in details that open in place.
 */
import { describe, expect, test } from 'bun:test'
import type { PublicPlan } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlansSaid } from './Plans'

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
  ...core,
  key: 'plus',
  name: 'Plus',
  monthlyPriceCents: 2500,
  yearlyPriceCents: 25000,
  includedHours: 120,
  maxServers: 3,
  maxPlayers: 100,
  mods: true,
  datapacks: true,
}
const PLANS = [free, core, plus]

const landing = (bedrock: boolean) =>
  renderToStaticMarkup(
    createElement(PlansSaid, { plans: PLANS, create: '/servers/new', getPlan: () => '/checkout', bedrock }),
  )
/** The cards one by one, as what people read: the markup's tags stripped, split at each card. */
const cards = (html: string) =>
  html
    .split('<section')
    .slice(1)
    .map((card) => card.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
/** A card's face: what it says before its details open. */
const face = (card: string) => card.replace(/See everything in .*?(Start free|Get Plus)/, '$1')

describe('the landing’s plan cards', () => {
  const html = landing(true)
  const [coreCard = '', plusCard = ''] = cards(html)

  test('two cards, Core and Plus: the trial is how Core starts', () => {
    expect(cards(html)).toHaveLength(2)
    expect(html).toContain('aria-label="Core"')
    expect(html).toContain('aria-label="Plus"')
    expect(html).not.toContain('aria-label="Free trial"')
    expect(coreCard).toContain('$9.99 a month')
    expect(coreCard).toMatch(/Start free 20 hours free, no card Get Core/)
    expect(plusCard).toContain('Get Plus')
    expect(plusCard).not.toContain('Start free')
  })

  test('Core is the light card and Plus the dark one', () => {
    const [coreTag = '', plusTag = ''] = html.match(/<section[^>]*>/g) ?? []
    expect(coreTag).not.toContain('bl-frame--solid')
    expect(plusTag).toContain('bl-frame--solid')
  })

  test('the heading says Core starts free and Plus adds mods', () => {
    expect(html).toContain('Core starts free, and Plus adds mods')
  })

  test('each card’s face says what you get, with no hours', () => {
    for (const line of [
      'You and 4 friends',
      'Java and Bedrock friends on one server',
      'Sleeps when nobody’s on, wakes when someone joins',
      'Backups, and your world to download',
    ])
      expect(face(coreCard)).toContain(line)
    for (const line of [
      'Up to 100 players',
      'Up to 3 servers',
      'Mods, plugins, modpacks and datapacks',
      'Go back to any of your last 14 sessions',
    ])
      expect(face(plusCard)).toContain(line)
    expect(face(coreCard)).not.toMatch(/\d+ hours of play/)
    expect(face(plusCard)).not.toMatch(/hours/)
  })

  test('Core promises Bedrock friends only where Bedrock is on', () => {
    expect(landing(false)).not.toContain('Bedrock')
  })

  test('the details hold the hours, the trial, the rules and the prices', () => {
    expect(coreCard).toContain('See everything in Core')
    expect(coreCard).toContain('40 hours of play each month, then 25¢ an hour')
    expect(coreCard).toContain('Starts with a free trial: 20 hours of play, at most 2 a day , no card')
    expect(coreCard).toContain('Hours count only while your server is awake, not for each player')
    expect(coreCard).toContain('$2 each, shared by five friends')
    expect(plusCard).toContain('See everything in Plus')
    expect(plusCard).toContain('120 hours of play each month')
    expect(plusCard).toContain('counts two hours for each hour it runs')
    expect(plusCard).toContain('Or $250 for a year, paid once')
    expect(plusCard).toContain('$5 each, shared by five friends')
    expect(html.match(/<details/g)).toHaveLength(2)
    // Plain Minecraft is said once, on the card's face.
    expect(coreCard.match(/Plain Minecraft/g)).toHaveLength(1)
    // The hours keep their dashed-line explainer.
    expect(html).toContain('bk-tip')
  })

  test('under the cards, only the way to the full pricing', () => {
    const under = html
      .slice(html.lastIndexOf('</section>'))
      .replace(/<[^>]+>/g, ' ')
      .trim()
    expect(under).toBe('Full pricing')
  })

  test('no card says what no plan is', () => {
    expect(html).not.toMatch(/unlimited|always on|no limits|any device/i)
  })
})
