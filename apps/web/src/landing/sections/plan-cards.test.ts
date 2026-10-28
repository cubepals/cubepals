// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The landing's plan cards: one to each paid plan, Core starting with the free trial. Each is one
 * surface: the plan's name and the line under it, what it costs and one quiet line under that, its
 * one button, three lines of what you get, and the hours and the rest in details that open in place.
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
  ...core,
  key: 'plus',
  name: 'Plus',
  monthlyPriceCents: 2500,
  yearlyPriceCents: 25000,
  includedHours: 120,
  maxServers: 3,
  maxPlayers: 100,
  sizes: [
    { gb: 3, maxPlayers: 5, hoursAnHour: 1 },
    { gb: 4, maxPlayers: 10, hoursAnHour: 1 },
    { gb: 8, maxPlayers: 50, hoursAnHour: 2 },
    { gb: 16, maxPlayers: 100, hoursAnHour: 4 },
  ],
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
    expect(coreCard).toContain('20 hours free No card, then $9.99 a month Start free')
    expect(plusCard).toContain('$25 a month Or $250 for a year, paid once Get Plus')
    expect(plusCard).not.toContain('Start free')
  })

  test('Core is the paper card and Plus the ink one, both in the stepped frame', () => {
    const [coreTag = '', plusTag = ''] = html.match(/<section[^>]*>/g) ?? []
    expect(coreTag).toContain('bl-frame')
    expect(coreTag).not.toContain('data-paid')
    expect(plusTag).toContain('bl-frame')
    expect(plusTag).toContain('data-paid')
  })

  test('each card opens with its picture, its name and one line under it', () => {
    expect(coreCard).toContain('> Core Plain Minecraft 20 hours free')
    expect(plusCard).toContain('> Plus Everything in Core, and more $25 a month')
    expect(coreHtml).toContain('src="/server-icons/grass.svg"')
    // No card in a card: the multiplayer list's row is gone.
    expect(html).not.toMatch(/0\/5|0\/100/)
  })

  test('one button to a card: Start free on Core, Get Plus, the lit one, on Plus', () => {
    expect(coreHtml).toMatch(
      /<a [^>]*class="bl-btn bl-btn--lg [^"]*"[^>]*href="\/servers\/new"[^>]*>Start free<\/a>/,
    )
    expect(plusHtml).toMatch(
      /<a [^>]*class="bl-btn bl-btn--lg bl-btn--lit [^"]*"[^>]*href="\/checkout\/plus\/month"[^>]*>Get Plus<\/a>/,
    )
    expect(coreHtml).not.toContain('bl-btn--lit')
    expect(coreHtml.match(/class="bl-btn /g)).toHaveLength(1)
    expect(plusHtml.match(/class="bl-btn /g)).toHaveLength(1)
    expect(coreHtml).not.toContain('/checkout/core')
  })

  test('the one quiet line: Core’s price after the trial, and Plus’s year', () => {
    expect(coreCard).not.toMatch(/Get Core|Ready to keep it/)
    expect(plusHtml).toMatch(/href="\/checkout\/plus\/year"[^>]*>Or \$250 for a year, paid once</)
  })

  test('the heading says Core starts free and Plus adds mods', () => {
    expect(html).toContain('Core starts free, and Plus adds mods')
  })

  test('each card’s face says what you get in three lines, a picture to each, with no hours', () => {
    expect(face(coreCard)).toContain('You and 4 friends Java and Bedrock together Sleeps when nobody’s on')
    expect(face(plusCard)).toContain('Up to 100 players Mods and modpacks Up to 3 servers')
    expect(coreHtml.match(/<li class="type-body"><svg/g)).toHaveLength(3)
    expect(plusHtml.match(/<li class="type-body"><svg/g)).toHaveLength(3)
    expect(face(coreCard)).not.toMatch(/hours of play/)
    expect(face(plusCard)).not.toMatch(/hours/)
  })

  test('no fact is said twice on a card’s face', () => {
    expect(face(coreCard).match(/friends/g)).toHaveLength(1)
    expect(face(coreCard).match(/Bedrock/g)).toHaveLength(1)
    expect(face(coreCard).match(/\$9\.99/g)).toHaveLength(1)
    expect(face(plusCard).match(/Core/g)).toHaveLength(1)
    expect(face(plusCard).match(/mods/gi)).toHaveLength(1)
    expect(face(plusCard).match(/\$250/g)).toHaveLength(1)
  })

  test('Bedrock is promised only where it is on', () => {
    const off = landing(false)
    expect(off).not.toContain('Bedrock')
    expect(face(cards(off)[0] ?? '')).toContain('You and 4 friends Backups, and your world to download')
    expect(off.match(/<li class="type-body"><svg/g)).toHaveLength(6)
  })

  test('the details hold the hours, the trial, the rules and the prices', () => {
    expect(coreCard).toContain('See everything in Core')
    expect(coreCard).toContain('40 hours of play each month, then 25¢ an hour')
    expect(coreCard).toContain('Starts with a free trial: 20 hours of play, at most 2 a day , no card')
    expect(coreCard).toContain('Hours count only while your server is awake, not for each player')
    expect(coreCard).toContain('A 3 GB server, for up to 5 players, on the free trial too')
    expect(coreCard).toContain('Plain Minecraft: vanilla or Paper')
    expect(coreCard).toContain('$2 each, shared by five friends')
    expect(plusCard).toContain('See everything in Plus')
    expect(plusCard).toContain('120 hours of play each month')
    expect(plusCard).toContain('Go back to any of your last 14 sessions')
    expect(plusCard).toContain(
      'Servers of 3, 4, 8 or 16 GB, sized for your group and game. 8 GB holds up to 50 players and counts two hours for each hour it runs; 16 GB holds up to 100 and counts four',
    )
    expect(plusCard).toContain('$5 each, shared by five friends')
    expect(plusCard).toContain('Plugins and datapacks work too')
    // The year is said once, under the price.
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
