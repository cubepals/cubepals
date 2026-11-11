// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The little markup a policy's sentences use, read into pieces a page renders: `[words](/path)`
 * for a link, `**words**` for the few that must stand out, `{token}` for what the operator
 * file says (who runs the service, how to reach them), and `{§id}` for another section of the
 * same policy, by its id, which the page says as "section 4". Nothing else is markup, so a
 * sentence reads the same in the source as on the page.
 */

/** The operator's details a sentence can name. */
export const TOKENS = [
  'brand',
  'domain',
  'playDomain',
  'name',
  'country',
  'law',
  'emailProvider',
  'emailProviderWhere',
  'support',
  'privacy',
  'legal',
] as const
export type Token = (typeof TOKENS)[number]

export type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'token'; token: Token }
  | { kind: 'section'; id: string }

const PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\{([A-Za-z]+)\}|\{§([a-z][a-z0-9-]*)\}/g

/**
 * What a `{§id}` says: "section" and the section's place in its policy, counted from 1, among
 * the policy's section ids in order. An id the policy doesn't have is a mistake, never a guess.
 */
export function sectionCalled(ids: readonly string[], id: string): string {
  const at = ids.indexOf(id)
  if (at < 0) throw new Error(`No section “${id}” to refer to`)
  return `section ${at + 1}`
}

/** A sentence in pieces. A `{word}` that isn't a token stays as the text it is. */
export function piecesOf(sentence: string): Piece[] {
  const pieces: Piece[] = []
  let at = 0
  const text = (until: number) => {
    if (until > at) pieces.push({ kind: 'text', text: sentence.slice(at, until) })
  }
  for (const match of sentence.matchAll(PATTERN)) {
    const [whole, linkText, href, strong, token, section] = match
    const start = match.index
    if (token !== undefined && !(TOKENS as readonly string[]).includes(token)) continue
    text(start)
    if (linkText !== undefined && href !== undefined) pieces.push({ kind: 'link', text: linkText, href })
    else if (strong !== undefined) pieces.push({ kind: 'strong', text: strong })
    else if (section !== undefined) pieces.push({ kind: 'section', id: section })
    else pieces.push({ kind: 'token', token: token as Token })
    at = start + whole.length
  }
  text(sentence.length)
  return pieces
}

/**
 * A sentence as plain text, for a page's title or description: links keep their words, tokens
 * become what `say` makes of them, and a section is said among `ids`, its policy's.
 */
export function plainOf(
  sentence: string,
  say: (token: Token) => string,
  ids: readonly string[] = [],
): string {
  return piecesOf(sentence)
    .map((piece) => {
      if (piece.kind === 'token') return say(piece.token)
      if (piece.kind === 'section') return sectionCalled(ids, piece.id)
      return piece.text
    })
    .join('')
}
