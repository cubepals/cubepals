// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The landing's plan cards: one to each paid plan, Core starting with the free trial. Each opens
 * with the plan as a server in the multiplayer list, its offer and its button; then a few lines of
 * what you get, the hours and the rest in details that open in place, and one more way to buy it.
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
    createElement(PlansSaid, {
      plans: PLANS,
      create: '/servers/new',
      getPlan: (key: string, term = 'month') => `/checkout/${key}/${term}`,
      bedrock,
    }),
  )
/** The cards one by one, as what people read: the markup's tags stripped, split at each card. */
const cards = (html: string) =>
  html
    .split('<section')
    .slice(1)
    .map((card) => card.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
/** The cards one by one, as written. */
const markup = (html: string) => html.split('<section').slice(1)
/** A card's face: what it says before its details open. */
const face = (card: string) => card.split('See everything in')[0] ?? ''

describe('the landing’s plan cards', () => {
  const html = landing(true)
  const [coreCard = '', plusCard = ''] = cards(html)
  const [coreHtml = '', plusHtml = ''] = markup(html)

  test('two cards, Core and Plus: the trial is how Core starts', () => {
    expect(cards(html)).toHaveLength(2)
    expect(html).toContain('aria-label="Core"')
    expect(html).toContain('aria-label="Plus"')
    expect(html).not.toContain('aria-label="Free trial"')
    expect(coreCard).toContain('20 hours free , no card Start free')
    expect(coreCard).toContain('Then $9.99 a month, when you want to keep playing.')
    expect(plusCard).toContain('$25 a month Get Plus')
    expect(plusCard).not.toContain('Start free')
  })

  test('Core is the paper card and Plus the ink one, both in the stepped frame', () => {
    const [coreTag = '', plusTag = ''] = html.match(/<section[^>]*>/g) ?? []
    expect(coreTag).toContain('bl-frame')
    expect(coreTag).not.toContain('data-paid')
    expect(plusTag).toContain('bl-frame')
    expect(plusTag).toContain('data-paid')
  })

  test('each card opens with the plan as a server in the list', () => {
    expect(face(coreCard)).toContain('Core 0/5 Plain Minecraft Java and Bedrock, one address')
    expect(face(plusCard)).toContain('Plus 0/100 Mods and modpacks Everything in Core, and more')
    expect(coreHtml).toContain('src="/server-icons/grass.svg"')
  })

  test('Start free is the block on Core, Get Plus the lit one, each as wide as its panel', () => {
    expect(coreHtml).toMatch(
      /<a [^>]*class="bl-btn bl-btn--lg [^"]*"[^>]*href="\/servers\/new"[^>]*>Start free<\/a>/,
    )
    expect(plusHtml).toMatch(
      /<a [^>]*class="bl-btn bl-btn--lg bl-btn--lit [^"]*"[^>]*href="\/checkout\/plus\/month"[^>]*>Get Plus<\/a>/,
    )
    expect(coreHtml).not.toContain('bl-btn--lit')
  })

  test('the foot: Core now on Core, a year on Plus', () => {
    expect(coreCard.trim()).toEndWith('Ready to keep it? Get Core now')
    expect(coreHtml).toMatch(/href="\/checkout\/core\/month"[^>]*>Get Core now</)
    expect(plusCard.trim()).toMatch(/Want a year\? \$250, paid once/)
    expect(plusHtml).toMatch(/href="\/checkout\/plus\/year"[^>]*>\$250, paid once</)
  })

  test('the heading says Core starts free and Plus adds mods', () => {
    expect(html).toContain('Core starts free, and Plus adds mods')
  })

  test('each card’s face says what you get, a picture to each line, with no hours', () => {
    expect(face(coreCard)).toContain(
      'You and 4 friends Java and Bedrock friends on one server Sleeps when nobody’s on, wakes when someone joins Backups, and your world to download',
    )
    expect(face(plusCard)).toContain(
      'Everything in Core, and mods Up to 100 players Mods, plugins, modpacks and datapacks Up to 3 servers',
    )
    expect(face(plusCard)).not.toContain('sessions')
    expect(coreHtml.match(/<li class="type-body"><svg/g)).toHaveLength(4)
    expect(plusHtml.match(/<li class="type-body"><svg/g)).toHaveLength(3)
    expect(face(coreCard)).not.toMatch(/\d+ hours of play/)
    expect(face(plusCard)).not.toMatch(/hours/)
  })

  test('Bedrock is promised only where it is on', () => {
    const off = landing(false)
    expect(off).not.toContain('Bedrock')
    expect(cards(off)[0]).toContain('Core 0/5 Plain Minecraft 20 hours free')
    expect(off.match(/<li class="type-body"><svg/g)).toHaveLength(6)
  })

  test('the details hold the hours, the trial, the rules and the prices', () => {
    expect(coreCard).toContain('See everything in Core')
    expect(coreCard).toContain('40 hours of play each month, then 25¢ an hour')
    expect(coreCard).toContain('Starts with a free trial: 20 hours of play, at most 2 a day , no card')
    expect(coreCard).toContain('Hours count only while your server is awake, not for each player')
    expect(coreCard).toContain('Plain Minecraft: vanilla or Paper')
    expect(coreCard).toContain('$2 each, shared by five friends')
    expect(plusCard).toContain('See everything in Plus')
    expect(plusCard).toContain('120 hours of play each month')
    expect(plusCard).toContain('Go back to any of your last 14 sessions')
    expect(plusCard).toContain('counts two hours for each hour it runs')
    expect(plusCard).toContain('$5 each, shared by five friends')
    // The year is said once, at the card's foot.
    expect(plusCard.match(/\$250/g)).toHaveLength(1)
    expect(plusCard).not.toMatch(/vanilla|Paper/)
    expect(html.match(/<details/g)).toHaveLength(2)
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
