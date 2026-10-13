// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the pages anyone can read report, the landing page among them:
 *
 * - `cta_pressed`: a marked button or link was pressed. `which` names it (one of `CTAS`), and
 *   `where` is the page it was on (one of `PLACES`).
 * - `plan_chosen`: a plan's button was pressed. `plan` is its key, `term` is `month` or `year`,
 *   and `where` the page.
 * - `guide_read`: a guide was read to its end, once a view. `slug` names the guide.
 *
 * A button is marked where it is drawn, with `ctaMark` or `planMark` here, which a server component can
 * call; `presses.tsx` hears the press and sends it. Nothing is read off the page but these marks,
 * and nothing personal is sent: PostHog runs cookieless (lib/insight.tsx).
 */

import type { Said } from '../../lib/insight'

/** The events, by what they report. Their names are a contract with the analytics built on them. */
export const PUBLIC_EVENTS = {
  cta: 'cta_pressed',
  plan: 'plan_chosen',
  guide: 'guide_read',
} as const

/** The buttons and links a press of is reported, each by where it stands. */
const CTAS = [
  // The landing page.
  'hero_create',
  'nav_pricing',
  'nav_sign_in',
  'follow_create',
  'to_price',
  'plans_create',
  'last_create',
  // The frame of the other public pages.
  'header_browse',
  'header_pricing',
  'header_guides',
  'header_sign_in',
  // Pricing, a guide's end and a server's page.
  'pricing_create',
  'guide_create',
  'copy_server',
] as const
export type Cta = (typeof CTAS)[number]

/** The pages a press is said to be on, by the first part of their address. */
const PLACES = {
  '': 'landing',
  pricing: 'pricing',
  guides: 'guide',
  browse: 'browse',
  server: 'server_page',
  join: 'invite',
} as const
type Place = (typeof PLACES)[keyof typeof PLACES] | 'other'

/** The mark that reports a press of this button or link. */
export const ctaMark = (which: Cta) => ({ 'data-cta': which })

/** The mark that reports a plan's button: its key and term. */
export const planMark = (key: string, term: 'month' | 'year') => ({ 'data-plan': key, 'data-term': term })

/** The page an address is, as `where` says it. */
export function placeOf(path: string): Place {
  const first = path.split('/')[1] ?? ''
  return Object.hasOwn(PLACES, first) ? PLACES[first as keyof typeof PLACES] : 'other'
}

/**
 * What a press of a marked element reports, from its marks: the event and its properties, or
 * null for anything unmarked or marked with what isn't listed here.
 */
export function pressOf(
  marks: { cta?: string | undefined; plan?: string | undefined; term?: string | undefined },
  path: string,
): { event: string; properties: Said } | null {
  const where = placeOf(path)
  const which = CTAS.find((one) => one === marks.cta)
  if (which !== undefined) return { event: PUBLIC_EVENTS.cta, properties: { which, where } }
  const term = marks.term === 'year' ? 'year' : 'month'
  if (marks.plan !== undefined && /^[a-z0-9_]{1,32}$/.test(marks.plan))
    return { event: PUBLIC_EVENTS.plan, properties: { plan: marks.plan, term, where } }
  return null
}
