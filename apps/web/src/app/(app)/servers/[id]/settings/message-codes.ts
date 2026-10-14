// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the style bar under the server message does to the text: it writes `&` codes into it, the
 * same codes a person could type, so the text stays the one truth. A code goes around the
 * selection, with the codes after it that put the rest of the message back as it was; with nothing
 * selected, it goes at the caret and holds from there on. Not for drawing the message: that is
 * `motdRuns`, in the contracts.
 */
import { MOTD_CODE, MOTD_COLOURS, MOTD_STYLES } from '@blockly/contracts'

/** How the list draws one place in the message: its colour's code, or null for its grey, and its styles' codes. */
interface Look {
  colour: string | null
  styles: string[]
}

const PLAIN: Look = { colour: null, styles: [] }

/** Styles in one order, so the same look is always written the same way. */
const STYLE_ORDER = Object.keys(MOTD_STYLES)

/** The visible characters of a stretch of message, each with its look, and the look after it. */
function walk(motd: string, from: Look): { chars: Array<{ text: string; look: Look }>; end: Look } {
  const chars: Array<{ text: string; look: Look }> = []
  let look = from
  let at = 0
  const visible = (text: string) => {
    for (const char of text) chars.push({ text: char, look })
  }
  for (const match of motd.matchAll(MOTD_CODE)) {
    visible(motd.slice(at, match.index))
    at = match.index + match[0].length
    // As the game reads it: a colour clears the styles before it.
    const code = (match[1] ?? '').toLowerCase()
    look = changed(code in MOTD_COLOURS ? PLAIN : look, code, true)
  }
  visible(motd.slice(at))
  return { chars, end: look }
}

/** A look with one code applied as the game applies it, except that a colour keeps the styles. */
function changed(look: Look, code: string, on: boolean): Look {
  if (code in MOTD_COLOURS) return { colour: code, styles: look.styles }
  if (!STYLE_ORDER.includes(code)) return PLAIN
  const styles = on ? [...new Set([...look.styles, code])] : look.styles.filter((style) => style !== code)
  return { colour: look.colour, styles: STYLE_ORDER.filter((style) => styles.includes(style)) }
}

/**
 * The codes that take the list from one look to another. Styles only add up: dropping one means
 * starting over from a colour, which clears them, or from `&r` back to the list's grey.
 */
function codesBetween(from: Look, to: Look): string {
  const added = to.styles.filter((style) => !from.styles.includes(style))
  if (from.colour === to.colour && from.styles.every((style) => to.styles.includes(style)))
    return added.map((style) => `&${style}`).join('')
  return [to.colour ?? 'r', ...to.styles].map((code) => `&${code}`).join('')
}

/** Moves an edge that falls between a code's two characters to one side of the code. */
function snapped(motd: string, at: number, side: 'before' | 'after'): number {
  for (const match of motd.matchAll(MOTD_CODE))
    if (match.index < at && at < match.index + match[0].length)
      return side === 'before' ? match.index : at + 1
  return at
}

/** Where the codes that run up to a place begin: the place itself when a character comes before it. */
function codesOpen(motd: string, at: number): number {
  let open = at
  for (const match of [...motd.slice(0, at).matchAll(MOTD_CODE)].reverse()) {
    if (match.index + match[0].length !== open) break
    open = match.index
  }
  return open
}

/** Whether a stretch opens with a code that sets its whole look, so nothing before it carries over. */
const opensFresh = (motd: string): boolean => {
  const first = [...motd.matchAll(MOTD_CODE)][0]
  const code = (first?.[1] ?? '').toLowerCase()
  return first?.index === 0 && (code in MOTD_COLOURS || code === 'r')
}

/** The codes every visible character of the selection has, or the caret's look: what the bar shows as pressed. */
export function pressedCodes(motd: string, start: number, end: number): string[] {
  const from = snapped(motd, start, 'before')
  const to = snapped(motd, end, 'after')
  const before = walk(motd.slice(0, from), PLAIN).end
  const { chars } = walk(motd.slice(from, to), before)
  const looks = chars.length === 0 ? [before] : chars.map((char) => char.look)
  const colour = looks.every((look) => look.colour === looks[0]?.colour) ? looks[0]?.colour : null
  const styles = STYLE_ORDER.filter((style) => looks.every((look) => look.styles.includes(style)))
  return colour ? [colour, ...styles] : styles
}

/**
 * The message with a code applied to the selection from `start` to `end`, and the selection
 * after it: the same words, with their new codes inside. A colour colours, `r` clears, and a
 * style the whole selection already has comes off it.
 */
export function withCode(
  motd: string,
  start: number,
  end: number,
  code: string,
): { motd: string; start: number; end: number } {
  // Codes just before the selection only ever touched it, so they are rewritten with it.
  const from = codesOpen(motd, snapped(motd, start, 'before'))
  const to = snapped(motd, end, 'after')
  const before = walk(motd.slice(0, from), PLAIN).end
  const { chars, end: after } = walk(motd.slice(from, to), before)
  if (chars.length === 0) {
    // At the caret too, so pressing bold twice leaves the text as it was.
    const open = codesOpen(motd, to)
    const ahead = walk(motd.slice(0, open), PLAIN).end
    const here = walk(motd.slice(open, to), ahead).end
    const codes = codesBetween(ahead, changed(here, code, !here.styles.includes(code)))
    const caret = open + codes.length
    return { motd: motd.slice(0, open) + codes + motd.slice(to), start: caret, end: caret }
  }
  const on = !chars.every((char) => char.look.styles.includes(code))
  let look = before
  let styled = ''
  for (const char of chars) {
    const next = changed(char.look, code, on)
    styled += codesBetween(look, next) + char.text
    look = next
  }
  const rest = motd.slice(to)
  const restored = rest.length === 0 || opensFresh(rest) ? '' : codesBetween(look, after)
  return { motd: motd.slice(0, from) + styled + restored + rest, start: from, end: from + styled.length }
}
