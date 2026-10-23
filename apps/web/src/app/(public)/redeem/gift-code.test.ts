// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How `@blockly/contracts` reads and writes a gift code, which the control plane checks a code
 * with and this page helps someone type one with.
 */
import { describe, expect, test } from 'bun:test'
import { codeCharacters, codeIn, formatCode, readCode } from '@blockly/contracts'

describe('a gift code, read the way a person types it', () => {
  test('case, spaces and dashes don’t matter, and O, I and L read as the digits they look like', () => {
    expect(readCode('7kq2-abcd-efgh-jkmn')).toBe('7KQ2ABCDEFGHJKMN')
    expect(readCode(' 7KQ2 ABCD EFGH JKMN ')).toBe('7KQ2ABCDEFGHJKMN')
    expect(readCode('OOOO-IIII-LLLL-oil0')).toBe('0000111111110110')
  })

  test('a code too short, too long or with a letter no code has isn’t one', () => {
    expect(readCode('7KQ2-ABCD-EFGH-JKM')).toBeNull()
    expect(readCode('7KQ2-ABCD-EFGH-JKMNP')).toBeNull()
    expect(readCode('7KQ2-ABCD-EFGH-JKMU')).toBeNull()
    expect(readCode('7KQ2_ABCD_EFGH_JKMN')).toBeNull()
  })

  test('typing keeps only what can be in a code', () => {
    expect(codeCharacters('7kq2-a b!c?d')).toBe('7KQ2ABCD')
    expect(codeCharacters('uuu')).toBe('')
    expect(codeCharacters('ffffffffffff')).toBe('FFFFFFFFFFFF')
  })

  test('a line pasted from the email gives just its code', () => {
    expect(codeIn('Here’s your gift code: 7KQ2-ABCD-EFGH-JKMN. Redeem it on Cubepals.')).toBe(
      '7KQ2ABCDEFGHJKMN',
    )
    expect(codeIn('Your gift code 7kq2 abcd efgh jkmn')).toBe('7KQ2ABCDEFGHJKMN')
    expect(codeIn('cubepals.com/redeem?code=7KQ2ABCDEFGHJKMN')).toBe('7KQ2ABCDEFGHJKMN')
    expect(codeIn('7KQ2-ABCD')).toBe('7KQ2ABCD')
  })

  test('it is written with a dash after every four characters, and none at the end', () => {
    expect(formatCode('')).toBe('')
    expect(formatCode('7KQ2')).toBe('7KQ2')
    expect(formatCode('7KQ2A')).toBe('7KQ2-A')
    expect(formatCode('7KQ2ABCDEFGHJKMN')).toBe('7KQ2-ABCD-EFGH-JKMN')
  })
})
