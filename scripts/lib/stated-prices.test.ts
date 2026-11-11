// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The site check's reading of prices: each place a page states a plan's price and hours, against
 * what the offer says, and a policy that states one. Pages are fixtures in the shape the site
 * writes them, with made-up figures, and are served by a local server for the whole check.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import type { PublicOffer, PublicPlan } from '@blockly/contracts'
import { checkPrices, offeredNow, policyProblems, pricedProblems } from './stated-prices.ts'

const core = {
  key: 'core',
  name: 'Core',
  per: 'month',
  monthlyPriceCents: 1111,
  yearlyPriceCents: null,
  includedHours: 44,
} as PublicPlan
const plus = {
  ...core,
  key: 'plus',
  name: 'Plus',
  monthlyPriceCents: 2222,
  yearlyPriceCents: 22200,
  includedHours: 133,
} as PublicPlan
const TABLE = [core, plus]
const OFFER: PublicOffer[] = [
  { plan: 'core', priceCents: 777, includedHours: 55 },
  { plan: 'plus', priceCents: 1300, includedHours: 150 },
]
const offered = offeredNow(TABLE, OFFER)

/** A pricing page as the site writes it: title, previews, structured data and cards. */
function pricingPage(said: { core: [string, number]; plus: [string, number]; title?: string }) {
  const title =
    said.title ??
    `Pricing: a free trial, then Core for $${said.core[0]} a month or Plus for $${said.plus[0]} a month`
  const offer = (name: string, [price, hours]: [string, number]) =>
    `{"@type":"Offer","name":"${name}","price":"${price}","description":"Up to 3 servers. ${hours} hours of play each month, then 25¢ an hour."}`
  return `<html><head><title>${title} · Cubepals</title>
<meta property="og:title" content="${title} · Cubepals"/><meta name="twitter:title" content="${title} · Cubepals"/></head><body>
<script type="application/ld+json">{"@type":"SoftwareApplication","offers":[{"@type":"Offer","name":"Free trial","price":"0"},${offer('Core', said.core)},${offer('Plus', said.plus)}]}</script>
<section class="bl-frame" aria-label="Core" data-seen="plan_core"><p><strong>20 hours free</strong></p><p>No card, then <!-- -->$${said.core[0]}<!-- --> a month</p>
<ul><li><span class="bk-tip">${said.core[1]} hours of play each month, then 25¢ an hour</span></li></ul></section>
<section class="bl-frame" aria-label="Plus" data-paid=""><p><strong>$${said.plus[0]}</strong> a month</p>
<ul><li><span class="bk-tip">${said.plus[1]} hours of play each month, then 25¢ an hour</span></li></ul></section>
<section aria-labelledby="questions"><p>If five of you share it, that’s $1.55 each.</p></section></body></html>`
}

describe('a priced page', () => {
  test('that states the offer everywhere has nothing to say', () => {
    expect(
      pricedProblems('/pricing', pricingPage({ core: ['7.77', 55], plus: ['13', 150] }), offered),
    ).toEqual([])
  })

  test('that states the plan table’s anywhere names the page, the place and both numbers', () => {
    const page = pricingPage({ core: ['7.77', 55], plus: ['13', 150] }).replace(
      '<title>Pricing: a free trial, then Core for $7.77 a month or Plus for $13',
      '<title>Pricing: a free trial, then Core for $7.77 a month or Plus for $22.22',
    )
    expect(pricedProblems('/pricing', page, offered)).toEqual([
      '/pricing: Plus is $22.22 a month in its title, but $13 from /api/public/offer.',
    ])
    const table = pricingPage({ core: ['11.11', 44], plus: ['22.22', 133] })
    expect(pricedProblems('/pricing', table, offered)).toContain(
      '/pricing: Core has 44 hours a month in its plan cards, but 55 from /api/public/offer.',
    )
    expect(pricedProblems('/pricing', table, offered)).toContain(
      '/pricing: Plus is $22.22 a month in its structured data, but $13 from /api/public/offer.',
    )
  })

  test('the pricing page must state every plan in its cards and its structured data', () => {
    expect(pricedProblems('/pricing', '<html><title>Pricing</title></html>', offered)).toEqual([
      '/pricing: its plan cards state no price for Core.',
      '/pricing: its plan cards state no price for Plus.',
      '/pricing: its structured data state no price for Core.',
      '/pricing: its structured data state no price for Plus.',
    ])
    // The home page states them where it does.
    expect(pricedProblems('/', '<html><title>Cubepals</title></html>', offered)).toEqual([])
  })
})

describe('a policy page', () => {
  test('states no plan price and no hours a month', () => {
    const fine =
      '<p>Plus costs the price a month shown on the <a href="/pricing">Pricing</a> page. Extra hours are $0.25 each.</p>'
    expect(policyProblems('/legal/terms', fine)).toEqual([])
    expect(
      policyProblems(
        '/legal/terms',
        '<p>Plus is $22.22 a month, or $222 for a year, and has 133 hours of play a month.</p>',
      ),
    ).toEqual([
      '/legal/terms states “$22.22 a month”: a plan’s price and hours belong on the Pricing page alone.',
      '/legal/terms states “$222 for a year”: a plan’s price and hours belong on the Pricing page alone.',
      '/legal/terms states “133 hours of play a month”: a plan’s price and hours belong on the Pricing page alone.',
    ])
  })
})

describe('the whole check, against a site', () => {
  const pages: Record<string, string> = {
    '/api/public/plans': JSON.stringify(TABLE),
    '/api/public/offer': JSON.stringify(OFFER),
    '/pricing': pricingPage({ core: ['7.77', 55], plus: ['13', 150] }),
    '/': '<html><title>Cubepals</title></html>',
    '/legal/terms': '<p>Its price is on the Pricing page.</p>',
    '/legal/refunds': '<p>We keep half of what you paid.</p>',
  }
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const page = pages[new URL(request.url).pathname]
      return page === undefined ? new Response('no', { status: 404 }) : new Response(page)
    },
  })
  afterAll(() => server.stop(true))
  const origin = `http://127.0.0.1:${server.port}`

  test('passes a site that says one price, and names a policy that states one', async () => {
    const said: string[] = []
    expect(await checkPrices(origin, (line) => said.push(line))).toEqual([])
    pages['/legal/refunds'] = '<p>Plus is $22.22 a month.</p>'
    expect(await checkPrices(origin, () => {})).toEqual([
      '/legal/refunds states “$22.22 a month”: a plan’s price and hours belong on the Pricing page alone.',
    ])
  })

  test('without the offer, reads only the policies', async () => {
    const offer = pages['/api/public/offer']
    delete pages['/api/public/offer']
    try {
      const said: string[] = []
      pages['/pricing'] = pricingPage({ core: ['11.11', 44], plus: ['22.22', 133] })
      pages['/legal/refunds'] = '<p>We keep half of what you paid.</p>'
      expect(await checkPrices(origin, (line) => said.push(line))).toEqual([])
      expect(said[0]).toContain('only the policies are read')
    } finally {
      if (offer !== undefined) pages['/api/public/offer'] = offer
    }
  })
})
