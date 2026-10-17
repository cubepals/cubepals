// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the site's marked buttons, sections and questions report, on the pages anyone can read
 * (the landing page among them), on signing in and up, and in the signed-in frame:
 *
 * - `cta_pressed`: a marked button or link was pressed. `which` names it (one of `CTAS`), and
 *   `where` is the page it was on (`placeOf`).
 * - `plan_chosen`: a plan's button was pressed. `plan` is its key, `term` is `month` or `year`,
 *   and `where` the page.
 * - `guide_read`: a guide was read to its end, once a view. `slug` names the guide.
 * - `section_seen`: a marked section came into view, once a view of the page: `section`, its code
 *   (a landing beat's id, `plan_<key>` for a plan's card, `locked_<plan>` for a way to play that
 *   plan runs), and `where`.
 * - `detail_opened`: a marked question or "How it works" was opened: `which`, its code, and `where`.
 * - `browse_searched`: the directory answered a search or a filter: `results`, how many came
 *   back, `searched` whether words were typed (never the words), `tag`, `kind` and `online`.
 * - `invite_joined`: an invitation put a player on the list: `added`, false where they were on it
 *   already. `invite_join_failed`: it was refused, with the refusal's `code`.
 *
 * A button is marked where it is drawn, with `ctaMark`, `planMark`, `seenMark` or `detailMark`
 * here, which a server component can call; `presses.tsx` hears the press or sees the section and
 * sends it. Nothing is read off the page but these marks, and nothing personal is sent: PostHog
 * runs cookieless (lib/insight.tsx).
 */

import type { Said } from '../../lib/insight'

/** The events, by what they report. Their names are a contract with the analytics built on them. */
export const PUBLIC_EVENTS = {
  cta: 'cta_pressed',
  plan: 'plan_chosen',
  guide: 'guide_read',
  seen: 'section_seen',
  detail: 'detail_opened',
  browsed: 'browse_searched',
  joined: 'invite_joined',
  joinFailed: 'invite_join_failed',
} as const

/** The buttons and links a press of is reported, each by where it stands. */
const CTAS = [
  // The landing page.
  'hero_create',
  'nav_pricing',
  'nav_browse',
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
  // A server's public page or invitation, and the directory.
  'copy_join_address',
  'copy_arcade',
  'own_server',
  'browse_open',
  // Signing in and up.
  'use_email',
  'to_sign_in',
  'to_sign_up',
  'forgot_password',
  // A server of one's own: its buttons, its address and its invite.
  'server_wake',
  'server_sleep',
  'server_start',
  'server_restart',
  'copy_address',
  'copy_invite',
  'copy_page',
  'share_open',
  'first_friend_done',
  'first_mod_find',
  'first_mod_later',
  // The account's plan.
  'manage_billing',
  'renew_year',
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
  'sign-in': 'sign_in',
  'sign-up': 'sign_up',
  'forgot-password': 'forgot_password',
  account: 'account',
  checkout: 'checkout',
} as const
/** A server's own pages, by the part of their address after its id. */
const SERVER_TABS = ['settings', 'players', 'mods', 'backups', 'world', 'console'] as const
type Place =
  | (typeof PLACES)[keyof typeof PLACES]
  | 'servers'
  | 'create'
  | 'server'
  | `server_${(typeof SERVER_TABS)[number]}`
  | 'other'

/** The mark that reports a press of this button or link. */
export const ctaMark = (which: Cta) => ({ 'data-cta': which })

/** The mark that reports a plan's button: its key and term. */
export const planMark = (key: string, term: 'month' | 'year') => ({ 'data-plan': key, 'data-term': term })

/** The mark that reports a section the first time it comes into view: a code, never words. */
export const seenMark = (section: string) => ({ 'data-seen': section })

/** The mark that reports a question, or a "How it works", as it is opened. */
export const detailMark = (which: string) => ({ 'data-detail': which })

/** The page an address is, as `where` says it. */
export function placeOf(path: string): Place {
  const [, first = '', second, third] = path.split('/')
  if (first === 'servers') return serverPlaceOf(second, third)
  return Object.hasOwn(PLACES, first) ? PLACES[first as keyof typeof PLACES] : 'other'
}

/** Under /servers: the list, the create page, or a server's own page and which of its tabs. */
function serverPlaceOf(second: string | undefined, third: string | undefined): Place {
  if (second === undefined || second === '' || second === 'trash') return 'servers'
  if (second === 'new') return 'create'
  const tab = SERVER_TABS.find((one) => one === third)
  return tab === undefined ? 'server' : `server_${tab}`
}

/** An event to send and what it carries. */
type Report = { event: string; properties: Said }

/**
 * What a press of a marked element reports, from its marks: the event and its properties, or
 * null for anything unmarked or marked with what isn't listed here.
 */
export function pressOf(
  marks: { cta?: string | undefined; plan?: string | undefined; term?: string | undefined },
  path: string,
): Report | null {
  const where = placeOf(path)
  const which = CTAS.find((one) => one === marks.cta)
  if (which !== undefined) return { event: PUBLIC_EVENTS.cta, properties: { which, where } }
  const term = marks.term === 'year' ? 'year' : 'month'
  if (marks.plan !== undefined && /^[a-z0-9_]{1,32}$/.test(marks.plan))
    return { event: PUBLIC_EVENTS.plan, properties: { plan: marks.plan, term, where } }
  return null
}

/**
 * A mark's code as it is sent: an id's hyphens become underscores, and anything else that isn't
 * lowercase letters, digits and underscores is not sent at all.
 */
function markCode(mark: string | undefined): string | null {
  const code = mark?.replaceAll('-', '_')
  return code !== undefined && /^[a-z0-9_]{1,40}$/.test(code) ? code : null
}

/** What a marked section reports as it comes into view, or null for a mark that isn't a code. */
export function seenOf(section: string | undefined, path: string): Report | null {
  const code = markCode(section)
  return code === null
    ? null
    : { event: PUBLIC_EVENTS.seen, properties: { section: code, where: placeOf(path) } }
}

/** What a marked question reports as it is opened, or null for a mark that isn't a code. */
export function detailOf(which: string | undefined, path: string): Report | null {
  const code = markCode(which)
  return code === null
    ? null
    : { event: PUBLIC_EVENTS.detail, properties: { which: code, where: placeOf(path) } }
}
