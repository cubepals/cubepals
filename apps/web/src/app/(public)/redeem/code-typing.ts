// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The gift code field's text as it is typed into: what the browser changed it to, written back the
 * way the gift email writes a code, with the caret kept after the same code character. Reading a
 * code is `@blockly/contracts`' job; this is only where the dashes and the caret go.
 */
import { codeCharacters, codeIn, formatCode, GIFT_CODE_LENGTH } from '@blockly/contracts'

/** The field's text and where its caret is. */
export interface CodeText {
  value: string
  caret: number
}

/** Where the caret goes after `count` code characters of a written code: never past a dash. */
const after = (count: number): number => (count === 0 ? 0 : count + Math.floor((count - 1) / 4))

/** Code characters, written, with the caret after the `count`th. */
const written = (characters: string, count: number): CodeText => ({
  value: formatCode(characters),
  caret: after(count),
})

/**
 * The field after the browser changed it, from `before` to `raw` with its caret at `caret`. A
 * deletion that took only a dash takes the character beyond it too, so Backspace after a dash
 * isn't undone by the dash coming back. A change that would make the code too long is refused.
 */
export function typed(
  before: CodeText,
  raw: string,
  caret: number,
  deleting?: 'backward' | 'forward',
): CodeText {
  let characters = codeCharacters(raw)
  let count = codeCharacters(raw.slice(0, caret)).length
  if (deleting && characters === codeCharacters(before.value) && raw.length < before.value.length) {
    if (deleting === 'backward' && count > 0) count -= 1
    characters = characters.slice(0, count) + characters.slice(count + 1)
  }
  // A copy, so the field is written back and its caret put back where it was.
  if (characters.length > GIFT_CODE_LENGTH) return { ...before }
  return written(characters, count)
}

/**
 * Text pasted over the field's selection, from `start` to `end`. A whole code replaces what was
 * there, and from a line of the email only the code is kept; anything else is read in where it
 * lands, as far as a code goes.
 */
export function pasted(before: CodeText, start: number, end: number, text: string): CodeText {
  const pasting = codeIn(text)
  if (pasting.length === GIFT_CODE_LENGTH) return written(pasting, GIFT_CODE_LENGTH)
  const head = codeCharacters(before.value.slice(0, start))
  const characters = (head + pasting + codeCharacters(before.value.slice(end))).slice(0, GIFT_CODE_LENGTH)
  return written(characters, Math.min(head.length + pasting.length, GIFT_CODE_LENGTH))
}

/** Which way an edit deleted, from the input event's `inputType`, if it deleted at all. */
export function deletion(inputType: string): 'backward' | 'forward' | undefined {
  if (inputType.startsWith('deleteContentBackward')) return 'backward'
  if (inputType.startsWith('deleteContentForward')) return 'forward'
  return undefined
}

/** The line under the field: how much of the code is still to come. */
export function remaining(value: string): string {
  const left = GIFT_CODE_LENGTH - codeCharacters(value).length
  if (left === GIFT_CODE_LENGTH) return `${GIFT_CODE_LENGTH} characters, from your gift email.`
  if (left === 0) return 'That’s the whole code.'
  return left === 1 ? '1 more character.' : `${left} more characters.`
}

/** What the field shows for a code that came another way, such as the gift email's link. */
export const arrived = (text: string): string => formatCode(codeIn(text).slice(0, GIFT_CODE_LENGTH))
