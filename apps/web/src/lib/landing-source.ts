// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where someone came from, as the first page they landed on in this tab says: the link's own
 * source (`./source.ts`) when it has one, otherwise the website that sent them, by its host
 * (google.com, reddit.com). Cubepals' own addresses are never a source, and nothing at all, as
 * when an address is typed, leaves it empty. It is held only in the page's memory, which lasts
 * across the site's own links within the tab; no cookie or browser storage carries it. Sign-up
 * puts it on the address the account's first page opens at, which keeps it (`withLanding`).
 */
import { OWN_DOMAIN } from '@blockly/contracts'
import { type LinkSource, sourceOf, withSource } from './source'

/** The search engines whose visitors arrive `organic`; every other website sends a `referral`. */
const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|yandex|baidu|ecosia|qwant|startpage)\.[a-z.]+$/

/** The parts of a host that say nothing about the website: `www.google.com` is google.com. */
const PREFIX = /^(www|m)\./

function ours(host: string, here: string): boolean {
  return host === here || host === OWN_DOMAIN || host.endsWith(`.${OWN_DOMAIN}`)
}

/** The website a referrer names, as a source; null for none, Cubepals' own, or one not on the web. */
function referrerSource(referrer: string, here: string): LinkSource | null {
  let url: URL
  try {
    url = new URL(referrer)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  if (ours(host, here.toLowerCase())) return null
  const site = host.replace(PREFIX, '')
  const medium = SEARCH.test(site) || site === 'search.brave.com' ? 'organic' : 'referral'
  // Read as a link's source is, so a host too long or odd to be one is left out.
  return sourceOf({ ref: site, utm_medium: medium })
}

/**
 * The parameter sign-in puts on the page a Google or GitHub round trip comes back to with an
 * error. That page's referrer is the provider, never where the visit came from.
 */
export const BACK_FROM = 'via'

/**
 * Where a visit came from: the address's own source first, then the website that sent it, unless
 * the page is one a sign-in provider sent back (`BACK_FROM`), which carries its source on itself.
 */
export function landingSource(landing: {
  search: string
  referrer: string
  host: string
}): LinkSource | null {
  const params = Object.fromEntries(new URLSearchParams(landing.search))
  const linked = sourceOf(params)
  if (linked !== null || BACK_FROM in params) return linked
  return referrerSource(landing.referrer, landing.host)
}

/** The first landing in this tab: undefined until it is noted, null when it had no source. */
let landed: LinkSource | null | undefined

/** Notes where this tab's first page came from; later pages leave it as it was. */
export function noteLanding(landing: { search: string; referrer: string; host: string }): void {
  if (landed === undefined) landed = landingSource(landing)
}

/** A path in the app with this tab's first landing carried on it, unless it carries a source already. */
export function withLanding(path: string): string {
  if (new URL(path, 'http://blockly.invalid').searchParams.has('ref')) return path
  return withSource(path, landed ?? null)
}

/** Forgets the noted landing, for tests that begin a new tab. */
export function forgetLanding(): void {
  landed = undefined
}
