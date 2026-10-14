// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the server list shows of a sleeping server: its owner's own message on the first line, as
 * they wrote it, and the sleeping notice on the second, in grey. The list draws two lines and
 * wraps a line too wide for it, so a message that would wrap is cut to one line first, or the
 * notice would be pushed out of sight. A server with no message of its own shows the notice alone.
 *
 * Not for deciding whether a server sleeps, or for its picture: those are the agent's.
 */

// Copied into the image beside the agent (Dockerfile): the formatting codes as the game reads them.
import { MOTD_CODE } from '../../packages/contracts/src/server-list.ts'

/**
 * How wide a line of the message may be, in the font's pixels: the multiplayer list's row, 305,
 * less the picture and its margin, 34 (ServerSelectionList in the Java Edition client).
 */
export const LIST_WIDTH = 271

/**
 * The default font's advance, in pixels, for the ASCII characters narrower than the usual 6
 * (assets/minecraft/textures/font/ascii.png: each glyph's width plus its pixel of spacing).
 */
const NARROW: Readonly<Record<string, number>> = {
  ' ': 4,
  '!': 2,
  '"': 4,
  "'": 2,
  '(': 4,
  ')': 4,
  '*': 4,
  ',': 2,
  '.': 2,
  ':': 2,
  ';': 2,
  '<': 5,
  '>': 5,
  '@': 7,
  I: 4,
  '[': 4,
  ']': 4,
  '`': 3,
  f: 5,
  i: 2,
  k: 5,
  l: 3,
  t: 4,
  '{': 4,
  '|': 2,
  '}': 4,
  '~': 7,
}

/** What any character outside ASCII is counted as: wider than most, so a line is never cut too late. */
const WIDE = 9

const advance = (char: string): number =>
  NARROW[char] ?? (char.length === 1 && char.charCodeAt(0) < 0x80 ? 6 : WIDE)

const ELLIPSIS = '…'

/** One line of `motd` that fits the list, its codes untouched; cut with an ellipsis when it wouldn't. */
export function oneLine(motd: string): string {
  const line = motd.split('\n')[0] ?? ''
  if (width(line) <= LIST_WIDTH) return line
  const room = LIST_WIDTH - WIDE
  let cut = ''
  for (const piece of pieces(line)) {
    if (!piece.code && width(cut + piece.text) > room) break
    cut += piece.text
  }
  return `${cut.trimEnd()}${ELLIPSIS}`
}

/** How wide the list draws `line`: codes take no room, and a bold character one pixel more. */
export function width(line: string): number {
  let total = 0
  let bold = false
  for (const piece of pieces(line)) {
    if (piece.code) {
      const code = piece.text[1]?.toLowerCase() ?? ''
      // A colour or a reset clears the styles before it, as the game reads them.
      if (code === 'l') bold = true
      else if (/[0-9a-fr]/.test(code)) bold = false
    } else total += advance(piece.text) + (bold ? 1 : 0)
  }
  return total
}

/** `line` as codes and the characters between them, one at a time, so a cut never splits a code. */
function* pieces(line: string): Generator<{ text: string; code: boolean }> {
  let at = 0
  for (const match of line.matchAll(MOTD_CODE)) {
    for (const char of line.slice(at, match.index)) yield { text: char, code: false }
    yield { text: match[0], code: true }
    at = match.index + match[0].length
  }
  for (const char of line.slice(at)) yield { text: char, code: false }
}

/** The list's message for a sleeping server: its own first, then `notice`; `notice` alone without one. */
export function asleepMessage(motd: string | undefined, notice: string): string {
  if (motd === undefined || motd.trim() === '') return notice
  return `${oneLine(motd)}\n§r§7${notice}`
}
