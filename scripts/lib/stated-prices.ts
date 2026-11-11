// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether the live site states one price and one number of hours a month for each paid plan:
 * on the pricing page its cards, its title and link previews, and its structured data; on the home
 * page its cards and structured data; each the same as `/api/public/offer` says a new subscriber
 * is offered now. And whether the Terms and the Refunds page state a plan's price or hours a month
 * at all, which they never should: they point to the Pricing and checkout pages.
 *
 * Run by `site-check.ts` after it finds the pages up. Not whether the pages are up
 * (site-pages.ts), and not what a signed-in page says.
 */
import { type PublicOffer, type PublicPlan, withOffers } from '@blockly/contracts'
import { SECOND_MS } from '@blockly/contracts/durations'

/** A plan's price a month in cents and its hours a month, as one place states them. */
export interface Stated {
  priceCents: number | null
  hours: number | null
}

/** The pages read, by what is asked of each. */
const PRICED = ['/pricing', '/'] as const
const POLICIES = ['/legal/terms', '/legal/refunds'] as const

/** An amount as written, "$13" or "$7.77", in cents. */
const cents = (said: string) => Math.round(Number(said) * 100)

/** "$13", "$7.77": as the pages write an amount. */
const dollars = (amount: number) => `$${amount % 100 === 0 ? amount / 100 : (amount / 100).toFixed(2)}`

/**
 * A page's text as read, to look for prices in: no scripts, tags or comments, and the few entities
 * React writes. Tags are taken out until none is left, so what taking one out puts together goes
 * too, and `&amp;` is read last, so nothing is read twice. The text is only ever searched, never
 * shown.
 */
function textOf(html: string): string {
  let text = html.replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
  for (let before = ''; before !== text; ) {
    before = text
    text = text.replace(/<[^>]*>/g, '')
  }
  return text
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/** A plan's price and hours in a stretch of text: "$13 a month", "150 hours of play each month". */
function statedIn(text: string): Stated {
  const price = /\$(\d+(?:\.\d+)?) a month/.exec(text)?.[1]
  const hours = /(\d+) hours of play each month/.exec(text)?.[1]
  return { priceCents: price ? cents(price) : null, hours: hours ? Number(hours) : null }
}

/** Each plan card's price and hours, by the plan's name: a `<section aria-label="Plus">`. */
function cardsSay(html: string): Map<string, Stated> {
  const cards = new Map<string, Stated>()
  for (const [, name = '', body = ''] of html.matchAll(
    /<section[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g,
  )) {
    const stated = statedIn(textOf(body))
    if (stated.priceCents !== null) cards.set(name, stated)
  }
  return cards
}

/** The prices in the title and the link previews' titles: "Core for $7.77 a month or Plus for $13 a month". */
function titlesSay(html: string): Map<string, Stated>[] {
  const titles = [
    /<title>([^<]*)<\/title>/.exec(html)?.[1],
    /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1],
    /<meta name="twitter:title" content="([^"]*)"/.exec(html)?.[1],
  ]
  return titles.flatMap((title) => {
    if (title === undefined) return []
    const said = new Map<string, Stated>()
    for (const [, name = '', price = ''] of textOf(title).matchAll(
      /([A-Z][\w ]*?) for \$(\d+(?:\.\d+)?) a month/g,
    ))
      said.set(name, { priceCents: cents(price), hours: null })
    return said.size > 0 ? [said] : []
  })
}

/** The structured data's offers, by plan name: the price, and the hours its description gives. */
function structuredSay(html: string): Map<string, Stated> {
  const said = new Map<string, Stated>()
  for (const [, json = ''] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const schema = JSON.parse(json) as { '@graph'?: unknown[] }
    for (const node of [schema, ...(schema['@graph'] ?? [])] as { offers?: unknown }[])
      for (const offer of (node.offers ?? []) as { name: string; price: string; description?: string }[]) {
        if (cents(offer.price) === 0) continue
        said.set(offer.name, {
          priceCents: cents(offer.price),
          hours: statedIn(offer.description ?? '').hours,
        })
      }
  }
  return said
}

/** The paid plans by the month, as a new subscriber is offered them now, by name. */
export function offeredNow(
  table: readonly PublicPlan[],
  offers: readonly PublicOffer[],
): Map<string, Stated> {
  return new Map(
    withOffers(table, offers)
      .filter((plan) => plan.per === 'month' && plan.monthlyPriceCents > 0)
      .map((plan) => [plan.name, { priceCents: plan.monthlyPriceCents, hours: plan.includedHours }]),
  )
}

/** What a page states, against what the offer says: a line for each place that differs. */
function differences(page: string, where: string, said: Map<string, Stated>, offered: Map<string, Stated>) {
  const lines: string[] = []
  for (const [name, stated] of said) {
    const now = offered.get(name)
    if (now === undefined) continue
    if (stated.priceCents !== null && stated.priceCents !== now.priceCents)
      lines.push(
        `${page}: ${name} is ${dollars(stated.priceCents)} a month in ${where}, but ${dollars(now.priceCents ?? 0)} from /api/public/offer.`,
      )
    if (stated.hours !== null && now.hours !== null && stated.hours !== now.hours)
      lines.push(
        `${page}: ${name} has ${stated.hours} hours a month in ${where}, but ${now.hours} from /api/public/offer.`,
      )
  }
  return lines
}

/** Each place a priced page states the plans, against the offer, and that the pricing page states them at all. */
export function pricedProblems(page: string, html: string, offered: Map<string, Stated>): string[] {
  const places: [string, Map<string, Stated>][] = [
    ['its plan cards', cardsSay(html)],
    ['its structured data', structuredSay(html)],
    ...titlesSay(html).map((said, i): [string, Map<string, Stated>] => [
      ['its title', 'its link preview', 'its link preview'][i] ?? 'its title',
      said,
    ]),
  ]
  const lines = places.flatMap(([where, said]) => differences(page, where, said, offered))
  if (page === '/pricing' && offered.size > 0)
    for (const [where, said] of places.slice(0, 2))
      for (const name of offered.keys())
        if (!said.has(name)) lines.push(`${page}: ${where} state no price for ${name}.`)
  return lines
}

/**
 * A plan price or hours a month a policy page states, which it never should: an amount by the
 * month or the year, or a number of hours a month. Other amounts are the policies' own (an extra
 * hour, a chip-in), so a plan's price that happens to equal one is no problem.
 */
export function policyProblems(page: string, html: string): string[] {
  const lines: string[] = []
  for (const [found] of textOf(html).matchAll(
    /\$\d+(?:\.\d+)? (?:(?:a|each|per|every) (?:month|year)|for a year)|\d+ hours(?: of play)? (?:a|each|every|per) month/g,
  ))
    lines.push(`${page} states “${found}”: a plan’s price and hours belong on the Pricing page alone.`)
  return lines
}

/** One page or endpoint asked once, past the edge's kept copy; null when it doesn't answer. */
async function read(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { 'cache-control': 'no-cache', 'user-agent': 'cubepals-site-guard' },
      signal: AbortSignal.timeout(20 * SECOND_MS),
    })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
}

/** A JSON list from the site, or null when it doesn't answer one. */
async function readList(url: string): Promise<unknown[] | null> {
  const body = await read(url)
  try {
    const list: unknown = body === null ? null : JSON.parse(body)
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

/**
 * The live site's prices checked once: a line for each problem, empty when it says one price.
 * Without the offer or the plan table, there is nothing to hold the priced pages to, and only the
 * policies are read.
 */
export async function checkPrices(origin: string, say: (line: string) => void): Promise<string[]> {
  const [table, offers] = await Promise.all(
    ['/api/public/plans', '/api/public/offer'].map((path) => readList(new URL(path, origin).href)),
  )
  const offered =
    table && offers ? offeredNow(table as PublicPlan[], offers as PublicOffer[]) : new Map<string, Stated>()
  if (offered.size === 0)
    say('Prices: the plan table or the offer didn’t answer, so only the policies are read.')
  // A query of its own, so each page is made now rather than answered from the edge's copy.
  const fresh = `?site-check=${Date.now()}`
  const lines: string[] = []
  for (const page of [...PRICED, ...POLICIES]) {
    const policy = (POLICIES as readonly string[]).includes(page)
    if (!policy && offered.size === 0) continue
    const html = await read(new URL(`${page}${fresh}`, origin).href)
    if (html === null) lines.push(`${page} didn’t answer, so its prices weren’t read.`)
    else lines.push(...(policy ? policyProblems(page, html) : pricedProblems(page, html, offered)))
  }
  if (lines.length === 0)
    say('Prices: every page states what /api/public/offer says, and no policy states one.')
  return lines
}
