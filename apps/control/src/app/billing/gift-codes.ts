// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gift codes: made at random, read the way a person types them, and kept only as a hash. A code is
 * sixteen characters of Crockford's base 32 (80 bits), in four groups, with no letter that reads
 * as another: O is 0 and I or L is 1 when typed, and dashes, spaces and case don't matter. How a
 * code is read and written is in `@blockly/contracts`, which the redeem page reads it with too.
 */
import { createHash, randomBytes } from 'node:crypto'
import { formatCode, GIFT_CODE_ALPHABET, GIFT_CODE_LENGTH, readCode } from '@blockly/contracts'

export { readCode }

/** A new code, as it is emailed: `7KQ2-…`. */
export function newCode(): string {
  const bytes = randomBytes(GIFT_CODE_LENGTH)
  // 256 is a multiple of 32, so each byte's low five bits are uniform.
  return formatCode([...bytes].map((byte) => GIFT_CODE_ALPHABET[byte % 32]).join(''))
}

/** What is kept of a code: its SHA-256. A code has 80 random bits, so no slower hash is needed. */
export function codeHash(code: string): string {
  return createHash('sha256')
    .update(readCode(code) ?? code)
    .digest('hex')
}

/** The end of a code, to tell a buyer's codes apart. */
export const codeHint = (code: string): string => (readCode(code) ?? code).slice(-4)
