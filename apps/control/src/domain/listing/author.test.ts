// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { pickStyle, shownName } from './author.ts'

describe('who left a note', () => {
  test('is a first name and the first letter of the last', () => {
    expect(shownName('Davi Hernandez')).toBe('Davi H.')
    expect(shownName('Mary Ann van der berg')).toBe('Mary B.')
    expect(shownName('  ana   lópez ')).toBe('ana L.')
    expect(shownName('Zoë Øvergaard')).toBe('Zoë Ø.')
  })

  test('is the first name alone when there is no last name', () => {
    expect(shownName('Davi')).toBe('Davi')
    expect(shownName('Bartholomew-Maximilian')).toBe('Bartholomew-Maximilian')
  })

  test('is nobody when the account has no name to show', () => {
    expect(shownName('')).toBeNull()
    expect(shownName('   ')).toBeNull()
    expect(shownName(String.fromCodePoint(0x200b, 0x202e))).toBeNull()
    // An email is never shown, whatever field it was typed in.
    expect(shownName('davi@example.com')).toBeNull()
    expect(shownName('Davi davi@example.com')).toBeNull()
  })

  test('hides nothing and carries no check mark', () => {
    expect(shownName(`Da${String.fromCodePoint(0x202e)}vi Hernandez`)).toBe('Davi H.')
    expect(shownName('Davi ✅')).toBeNull()
  })
})

describe('the picture style a new writer is given', () => {
  const seeds = Array.from({ length: 200 }, (_, i) =>
    (((i + 1) * 2654435761) >>> 0).toString(16).padStart(8, '0').padEnd(32, '0'),
  )
  const styles = ['mark', 'identicon', 'pixel', 'bauhaus', 'minidenticon'] as const

  test('is the same for the same seed', () => {
    for (const seed of seeds) expect(pickStyle(seed, styles)).toBe(pickStyle(seed, styles))
  })

  test('gives every style to someone', () => {
    expect(new Set(seeds.map((seed) => pickStyle(seed, styles)))).toEqual(new Set(styles))
  })
})
