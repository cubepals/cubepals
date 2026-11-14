// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every public page that states a plan's price or hours states what a new subscriber is offered
 * now, from one reading (`pricedPlans`): the pricing page's title, link previews, structured data,
 * cards and questions, the landing page, and the guides. Each is made here with a control plane
 * whose offer differs from its plan table, and the table's own figures must appear nowhere. Where
 * the offer can't be read, the page states the table's, all of it.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { PublicOffer, PublicPlan } from '@blockly/contracts'
import type { Metadata } from 'next'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GUIDES } from '../app/(public)/guides'

// Nobody is signed in: the pages ask for the session through Next's headers.
mock.module('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}))
// Next's build loads the fonts; here a font is only its class names.
const font = () => ({ className: '', variable: '', style: {} })
mock.module('next/font/google', () => ({ Geologica: font, Instrument_Serif: font, Pixelify_Sans: font }))
mock.module('next/font/local', () => ({ default: font }))

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
  monthlyPriceCents: 1111,
  includedHours: 44,
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
  monthlyPriceCents: 2222,
  yearlyPriceCents: 22200,
  includedHours: 133,
  maxServers: 3,
  maxPlayers: 40,
  mods: true,
  datapacks: true,
}
/** Made-up figures, none of them the table's. */
const OFFER: PublicOffer[] = [
  { plan: 'core', priceCents: 777, includedHours: 55 },
  { plan: 'plus', priceCents: 1300, includedHours: 150 },
]

/** What the table says and the offer doesn't: none of it may be on a page. */
const TABLE_SAID = [/\$11\.11/, /\$22\.22/, /\$222\b/, /\b44 hours/, /\b133 hours/, /"11\.11"/, /"22\.22"/]
/** What the offer says instead. */
const OFFER_SAID = [/\$7\.77/, /\$13\b/, /\b55 hours/, /\b150 hours/]

/** The control plane, answering the plan table and, unless `offerDown`, the offer. */
function controlPlane(offerDown = false) {
  globalThis.fetch = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname
    if (path === '/api/public/plans') return Response.json([free, core, plus])
    if (path === '/api/public/offer')
      return offerDown ? new Response('down', { status: 503 }) : Response.json(OFFER)
    return new Response('not here', { status: 404 })
  }) as typeof fetch
}

/** A page's metadata and markup as one text, as a reader or a crawler gets it. */
const said = (metadata: Metadata, markup: string) => `${JSON.stringify(metadata)}\n${markup}`

/** An app router at the home page, as Next mounts one around a page, which never moves here. */
const ROUTER = { push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {} }

/** Markup of a server component's tree, its async parts awaited first, inside the app router. */
async function rendered(node: ReactNode): Promise<string> {
  const page = createElement('div', null, await resolved(node))
  const inPath = createElement(PathnameContext.Provider, { value: '/' }, page)
  const withQuery = createElement(SearchParamsContext.Provider, { value: new URLSearchParams() }, inPath)
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: ROUTER as never }, withQuery))
}

async function resolved(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolved))
  if (node === null || typeof node !== 'object' || !('type' in node)) return node
  const element = node as ReactElement<{ children?: ReactNode }>
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction')
    return resolved(await (element.type as (props: unknown) => Promise<ReactNode>)(element.props))
  const children = element.props.children
  if (children === undefined) return element
  return { ...element, props: { ...element.props, children: await resolved(children) } }
}

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
})

const expectOffered = (text: string, where: string) => {
  for (const table of TABLE_SAID) expect(text, `${where} states the plan table's ${table}`).not.toMatch(table)
  for (const offer of OFFER_SAID) expect(text, `${where} misses the offer's ${offer}`).toMatch(offer)
}

describe('a public page states what a new subscriber is offered now', () => {
  let pricing: typeof import('../app/(public)/pricing/page')
  let home: typeof import('../app/page')

  beforeAll(async () => {
    pricing = await import('../app/(public)/pricing/page')
    home = await import('../app/page')
  })

  test('the pricing page: its title, previews, structured data, cards and questions', async () => {
    controlPlane()
    const text = said(await pricing.generateMetadata(), await rendered(await pricing.default()))
    expectOffered(text, 'the pricing page')
    // Twelve months of Plus at the offer cost less than its year, so no year is offered.
    expect(text).not.toMatch(/for a year, paid once|a year of Plus/i)
  })

  test('the landing page: its sections and structured data', async () => {
    controlPlane()
    const searchParams = Promise.resolve({})
    expectOffered(await rendered(await home.default({ searchParams })), 'the landing page')
  })

  test('every guide: none states the plan table’s, and the cost guide states the offer', async () => {
    controlPlane()
    for (const guide of GUIDES) {
      const module = (await import(`../app/(public)/guides/${guide.slug}/page`)) as {
        default: () => Promise<ReactElement<{ children: ReactNode }>>
      }
      // The guide's own words; its frame states no price.
      const markup = await rendered((await module.default()).props.children)
      for (const table of TABLE_SAID) expect(markup, `${guide.slug} states ${table}`).not.toMatch(table)
      if (guide.slug === 'minecraft-server-cost') {
        expect(markup).toMatch(/\$13\b/)
        expect(markup).toMatch(/\b150 hours/)
      }
    }
  })

  test('where the offer can’t be read, the whole page states the plan table’s', async () => {
    controlPlane(true)
    const text = said(await pricing.generateMetadata(), await rendered(await pricing.default()))
    for (const offer of OFFER_SAID) expect(text).not.toMatch(offer)
    for (const table of [/\$11\.11/, /\$22\.22/, /"22\.22"/, /\b133 hours/]) expect(text).toMatch(table)
  })
})
