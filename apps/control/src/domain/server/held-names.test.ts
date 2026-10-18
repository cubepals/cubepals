// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Which addresses are held back, and that everyday names with a held word inside are not. */
import { describe, expect, test } from 'bun:test'
import { HELD_FOR_CUBEPALS, holdOn, saysOfficial } from './held-names.ts'
import { checkSlug } from './slug.ts'

describe('held names', () => {
  test('names that pass for Cubepals or Mojang are brand names', () => {
    for (const slug of ['official', 'staff', 'team', 'moderator', 'minecraft', 'mojang', 'xbox', 'realms'])
      expect(holdOn(slug)).toBe('brand')
  })

  test('so are their lookalikes: dashes, numbers, digits for letters and brand words strung together', () => {
    for (const slug of [
      'cube-pals',
      'cubepal',
      'cubepals1',
      'cubepals-2',
      'cub3pals',
      'cubepa1s',
      'c-u-b-e-p-a-l-s',
      'cubepals-staff',
      'official-team',
      'mojang-staff-2',
      'm0d',
      'staff1',
    ])
      expect(holdOn(slug)).toBe('brand')
  })

  test('the words for game modes and hubs are held for Cubepals’ own servers', () => {
    expect(HELD_FOR_CUBEPALS.has('duels')).toBe(true)
    for (const slug of ['duels', 'pvp', 'smp', 'skyblock', 'lobby', 'hub', 'vanilla', 'modded'])
      expect(holdOn(slug)).toBe('cubepals')
  })

  test('a name that only contains one of them is anyone’s', () => {
    for (const slug of [
      'duels-with-friends',
      'sunset-smp',
      'pvp-arena-2',
      'minecraft-with-mates',
      'teams',
      'the-team',
      'cube-world',
      'pals',
      'staffordshire',
      'modern-city',
      'hubbub',
      'lobby-boys',
    ])
      expect(holdOn(slug)).toBeNull()
  })

  test('every held name is an address a server could otherwise have', () => {
    for (const slug of HELD_FOR_CUBEPALS) expect(checkSlug(slug).ok).toBe(true)
  })

  test('an address Cubepals keeps for its own server is kept, and one that only contains it is anyone’s', () => {
    expect(holdOn('sunset-valley')).toBe('kept')
    expect(checkSlug('sunset-valley').ok).toBe(true)
    expect(holdOn('sunset-valley-2')).toBeNull()
  })

  test('a name or description that says Cubepals, Official, Verified or Staff, however it is written', () => {
    for (const text of [
      'Cubepals',
      'cubepals smp',
      'Cube pals',
      'Cube-Pals Survival',
      'Cubepal5',
      'Cub3pals',
      'CUBEPAL',
      'C u b e p a l s',
      'Ｃｕｂｅｐａｌｓ',
      'Сubераls',
      'Cubépals',
      'Official',
      'The Official Server',
      '0ff1c1al',
      'O.f.f.i.c.i.a.l',
      'Verified SMP',
      'V3rified',
      'Staff',
      'Staff2 only',
      'Run by staff',
    ])
      expect([text, saysOfficial(text)]).toEqual([text, true])
  })

  test('words that only contain those, or sit beside them, are not them', () => {
    for (const text of [
      'Moss Hollow SMP',
      'Unofficial Skyblock',
      'Staffordshire builders',
      'Cube world',
      'Pals of the cube',
      'Officially fun',
      'Verify your builds',
      'A quiet survival world for six friends.',
    ])
      expect([text, saysOfficial(text)]).toEqual([text, false])
  })
})
