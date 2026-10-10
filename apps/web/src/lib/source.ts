// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where someone came from, as the link that brought them said: `utm_source` or `ref`, and the
 * rest of a campaign's tags (`utm_medium`, `utm_campaign`, `utm_content`, `utm_term`). They ride
 * on the addresses someone follows into sign-up and are kept once on the account; no cookie
 * carries them. A tag that isn't a short plain word is left out rather than kept as typed.
 */
export interface LinkSource {
  source: string
  medium: string | null
  campaign: string | null
  content: string | null
  term: string | null
}

type Params = Record<string, string | string[] | undefined>

/** The tags past the source, by the name each has on the app's own addresses. */
const TAGS = ['medium', 'campaign', 'content', 'term'] as const

const SOURCE = /^[a-z0-9][a-z0-9_.-]{0,39}$/
const TAG = /^[a-z0-9][a-z0-9_.+-]{0,79}$/

function word(params: Params, name: string, shape: RegExp): string | null {
  const value = params[name]
  const said = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase()
  return said !== undefined && shape.test(said) ? said : null
}

/** The link's source and tags; null when it named no source, which every campaign link does. */
export function sourceOf(params: Params): LinkSource | null {
  const source = word(params, 'utm_source', SOURCE) ?? word(params, 'ref', SOURCE)
  if (source === null) return null
  const tags = Object.fromEntries(TAGS.map((tag) => [tag, word(params, `utm_${tag}`, TAG)]))
  return { source, ...(tags as Omit<LinkSource, 'source'>) }
}

/** The address parameters a source rides on in the app: `ref`, and each tag it has. */
export const SOURCE_PARAMS = ['ref', ...TAGS.map((tag) => `utm_${tag}`)] as const

/** A path in the app with the source carried on it, when there is one. */
export function withSource(path: string, source: LinkSource | null): string {
  if (source === null) return path
  const url = new URL(path, 'http://blockly.invalid')
  url.searchParams.set('ref', source.source)
  for (const tag of TAGS) {
    const value = source[tag]
    if (value !== null) url.searchParams.set(`utm_${tag}`, value)
  }
  return `${url.pathname}${url.search}`
}
