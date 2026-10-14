// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where Minecraft's multiplayer list breaks a server's message and where it stops: the same
 * reading of its codes, the same glyph widths (`minecraft-font.ts`) and the same line breaking as
 * the game, so the settings page draws exactly what players see and the control plane refuses
 * exactly what they wouldn't. Not for the codes' colours as words on a page: that is `motdRuns`.
 */
import { glyphAdvance } from './minecraft-font.ts'
import { MOTD_COLOURS, MOTD_DEFAULT_COLOUR, MOTD_STYLES, type MotdRun, motdForGame } from './server-list.ts'

/**
 * How wide a line of the message is, in the game's pixels. In the Java Edition 26.3 client a row
 * of the list is 305 wide (`ServerSelectionList.getRowWidth`), its content 4 less
 * (`AbstractSelectionList.Entry.getContentWidth`), and `ServerSelectionList.OnlineServerEntry`
 * splits the message at that content width less the 32 pixel icon and 2.
 */
export const MOTD_LINE_WIDTH = 305 - 4 - 32 - 2

/** How many of those lines the list draws (`OnlineServerEntry`: `Math.min(lines.size(), 2)`). */
export const MOTD_LINES = 2

/** One character as the list draws it: its look, and where it sits on its line. */
export interface MotdGlyph {
  char: string
  colour: string
  styles: MotdRun['styles']
  /** From the line's start, in the game's pixels. */
  x: number
  advance: number
}

export interface MotdLayout {
  /** What the list shows: up to two lines. */
  lines: MotdGlyph[][]
  /** What it never shows, broken into lines as the game would have gone on. */
  cut: MotdGlyph[][]
  /** How many characters that is. */
  cutCount: number
}

type Unplaced = Omit<MotdGlyph, 'x'>

/**
 * The message's characters as the game reads the text it is sent (`StringDecomposer.iterateFormatted`):
 * a section sign and the character after it are a code, read or not, and a colour clears the styles.
 */
function characters(motd: string): Unplaced[] {
  const text = [...motdForGame(motd)]
  const chars: Unplaced[] = []
  let colour = MOTD_DEFAULT_COLOUR
  let styles: MotdRun['styles'] = []
  for (let at = 0; at < text.length; at++) {
    const char = text[at] ?? ''
    if (char !== '§') {
      chars.push({ char, colour, styles, advance: glyphAdvance(char, styles.includes('bold')) })
      continue
    }
    const code = (text[++at] ?? '').toLowerCase()
    const style = MOTD_STYLES[code as keyof typeof MOTD_STYLES]
    if (MOTD_COLOURS[code] !== undefined || code === 'r') {
      colour = MOTD_COLOURS[code] ?? MOTD_DEFAULT_COLOUR
      styles = []
    } else if (style !== undefined && !styles.includes(style)) styles = [...styles, style]
  }
  return chars
}

/**
 * The characters broken into lines as `StringSplitter.splitLines` breaks them: a line ends at
 * a line break, or once it grows past the width, at its last space if it has one and before the
 * character that didn't fit if not. A space or line break it ends at is dropped.
 */
function broken(chars: Unplaced[], width: number): MotdGlyph[][] {
  const lines: MotdGlyph[][] = []
  let start = 0
  while (start < chars.length) {
    const end = lineEnd(chars, start, width)
    let x = 0
    lines.push(
      chars.slice(start, end).map((char) => {
        const placed = { ...char, x }
        x += char.advance
        return placed
      }),
    )
    const dropped = chars[end]?.char === ' ' || chars[end]?.char === '\n'
    start = end + (dropped ? 1 : 0)
  }
  return lines
}

/** Where the line from `start` ends (`StringSplitter.LineBreakFinder`). */
function lineEnd(chars: Unplaced[], start: number, width: number): number {
  let used = 0
  let lastSpace = -1
  let inked = false
  for (let at = start; at < chars.length; at++) {
    const { char, advance } = chars[at] as Unplaced
    if (char === '\n') return at
    if (char === ' ') lastSpace = at
    used += advance
    if (inked && used > width) return lastSpace === -1 ? at : lastSpace
    inked ||= advance !== 0
  }
  return chars.length
}

/** The message laid out as the list lays it out, and what it leaves off. */
export function motdLayout(motd: string): MotdLayout {
  const lines = broken(characters(motd), MOTD_LINE_WIDTH)
  const cut = lines.slice(MOTD_LINES)
  return { lines: lines.slice(0, MOTD_LINES), cut, cutCount: cut.reduce((n, line) => n + line.length, 0) }
}

/** What to tell the person whose message runs past the list. */
export const motdCutSentence = (cutCount: number): string =>
  cutCount === 1
    ? 'The last character won’t show in the server list.'
    : `The last ${cutCount} characters won’t show in the server list.`
