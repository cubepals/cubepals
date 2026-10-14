// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Short hints about the server message's `&` codes, for mistakes the game takes without a word
 * and players then see: an `&` that isn't a code, a style with nothing after it, and a colour
 * that ends a style the person probably meant to keep. One hint for each kind, only while the
 * mistake is in the text; they never stop a save. Not for what the list cuts: that is `motdLayout`.
 */
import { MOTD_CODE, MOTD_COLOURS, motdText } from '@blockly/contracts'
import { COLOUR_NAMES } from './message-codes'

/** The styles as a player would say them. */
const STYLE_NAMES: Record<string, string> = {
  k: 'obfuscated',
  l: 'bold',
  m: 'strikethrough',
  n: 'underline',
  o: 'italic',
}

const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1)
const listed = (words: string[]) =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

/** An `&` before a character that makes no code, a space aside: "Tom & Jerry" means the ampersand. */
const NOT_A_CODE = /&([^\s0-9a-fk-or])/iu

export function messageHints(motd: string): string[] {
  const hints: string[] = []
  const stray = NOT_A_CODE.exec(motd)
  if (stray !== null) hints.push(`“${stray[0]}” isn’t a code, so players see it as typed.`)
  const codes = [...motd.matchAll(MOTD_CODE)].map((match) => ({
    code: (match[1] ?? '').toLowerCase(),
    at: match.index,
    end: match.index + match[0].length,
  }))
  const empty = emptyStyle(motd, codes)
  if (empty !== null) hints.push(empty)
  const ended = endedStyle(motd, codes)
  if (ended !== null) hints.push(ended)
  return hints
}

type Code = { code: string; at: number; end: number }

/** A style that no character comes after before a colour or reset clears it, or the message ends. */
function emptyStyle(motd: string, codes: Code[]): string | null {
  for (const [i, { code, end }] of codes.entries()) {
    const name = STYLE_NAMES[code]
    if (name === undefined) continue
    const clear = codes.slice(i + 1).find((next) => next.code in MOTD_COLOURS || next.code === 'r')
    if (motdText(motd.slice(end, clear?.at ?? motd.length)).length > 0) continue
    return clear === undefined
      ? `${capital(name)} (&${code}) at the end has nothing to style.`
      : `${capital(name)} (&${code}) ends at the code after it. Put it after the colour.`
  }
  return null
}

/**
 * A colour that clears styles some text already had, without writing them again straight after:
 * the game clears styles on every colour. Starting the same colour again is how a style is
 * ended on purpose, so that is left alone.
 */
function endedStyle(motd: string, codes: Code[]): string | null {
  let colour: string | null = null
  // The styles on, and of those, the ones some character has been drawn with.
  let styles: string[] = []
  let drawn: string[] = []
  let at = 0
  for (const [i, { code, at: start, end }] of codes.entries()) {
    if (motdText(motd.slice(at, start)).length > 0) drawn = styles
    at = end
    const lost =
      code in MOTD_COLOURS && code !== colour ? drawn.filter((style) => !keeps(codes, i, style)) : []
    if (lost.length > 0) return ends(code, lost)
    if (code in MOTD_COLOURS || code === 'r') {
      colour = code === 'r' ? null : code
      styles = []
      drawn = []
    } else styles = [...new Set([...styles, code])]
  }
  return null
}

const ends = (colour: string, lost: string[]) =>
  `${COLOUR_NAMES[colour]} (&${colour}) ends ${listed(lost.map((style) => STYLE_NAMES[style] ?? style))}. To keep it, write ${lost.map((style) => `&${style}`).join('')} after &${colour}.`

/** Whether a style is written again straight after the code at `i`, as the style bar keeps one. */
function keeps(codes: Code[], i: number, style: string): boolean {
  for (let next = i + 1; codes[next]?.at === codes[next - 1]?.end; next++)
    if (codes[next]?.code === style) return true
  return false
}
