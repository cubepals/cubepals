// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A gift code's shape, and how a typed one is read: the one place the control plane, which checks
 * a code, and the redeem page, which helps someone type it, both read it from. A code is sixteen
 * characters of Crockford's base 32, written in four groups of four with dashes. Read the way the
 * spec says a person types it: any case, dashes and spaces ignored, O as 0 and I or L as 1. Making
 * and hashing a code stay with the control plane (`gift-codes.ts`), which has `node:crypto`.
 */

/** Crockford's base 32: the digits and the letters, less I, L, O and U. */
export const GIFT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const GIFT_CODE_LENGTH = 16
const GROUP = 4

/** Typed text in capitals, with the letters that read as digits made digits. */
const capitals = (typed: string): string => typed.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')

/** A code as typed, read as the code it is; null when it can't be one. */
export function readCode(typed: string): string | null {
  const code = capitals(typed).replace(/[\s-]/g, '')
  if (code.length !== GIFT_CODE_LENGTH || [...code].some((ch) => !GIFT_CODE_ALPHABET.includes(ch)))
    return null
  return code
}

/** Every character of typed text that can be in a code, read as one; the rest dropped. */
export const codeCharacters = (typed: string): string =>
  [...capitals(typed)].filter((ch) => GIFT_CODE_ALPHABET.includes(ch)).join('')

/** One group's characters, once typed text is in capitals: the alphabet, with no U. */
const CHAR = '[0-9A-HJKMNP-TV-Z]'
const APART = (pattern: string) => new RegExp(`(?<![0-9A-Z])${pattern}(?![0-9A-Z])`)
const GROUPS = GIFT_CODE_LENGTH / GROUP
/** A whole code standing apart from any other word, as the email writes it or run together. */
const WRITTEN = APART(`${CHAR}{${GROUP}}(?:-?${CHAR}{${GROUP}}){${GROUPS - 1}}`)
/**
 * Groups of four split by spaces. Words can be too (`gift code 7KQ2 …`), and the code ends the
 * line, so a code is the last four groups of a run.
 */
const SPACED = APART(`${CHAR}{${GROUP}}(?: ${CHAR}{${GROUP}}){${GROUPS - 1},}`)

/**
 * The code in some text, as its characters: a whole code if the text holds one, as a line pasted
 * from the gift email does, so its other words aren't read as part of it; otherwise every code
 * character in the text.
 */
export function codeIn(text: string): string {
  const read = capitals(text)
  const whole = read.match(WRITTEN)?.[0] ?? read.match(SPACED)?.[0].split(' ').slice(-GROUPS).join('')
  return codeCharacters(whole ?? read)
}

/** Code characters as the gift email writes them, a dash after every four: `7KQ2-ABCD-E`. */
export const formatCode = (characters: string): string =>
  characters.match(new RegExp(`.{1,${GROUP}}`, 'g'))?.join('-') ?? ''
