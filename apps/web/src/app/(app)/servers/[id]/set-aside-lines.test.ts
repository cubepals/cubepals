// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { setAsideLine } from './set-aside-lines.ts'

describe('a file set aside for a start', () => {
  const datapack = {
    path: 'datapacks/far-end-2.zip',
    inWorld: true,
    why: 'The datapack far-end-2 has files this Minecraft can’t read.',
    at: '2026-11-18T10:00:00Z',
    back: false,
  }

  test('says what was moved, why, and that a copy is kept', () => {
    expect(setAsideLine(datapack)).toBe(
      'Cubepals set the datapack far-end-2 from its world aside, a copy kept, because it stopped the server as it started: The datapack far-end-2 has files this Minecraft can’t read.',
    )
    expect(setAsideLine({ ...datapack, path: 'mods/jei-19.19.jar', inWorld: false })).toStartWith(
      'Cubepals set jei-19.19.jar from its mods folder aside',
    )
  })

  test('once asked back, says when it goes back', () => {
    expect(setAsideLine({ ...datapack, back: true })).toBe(
      'Cubepals puts the datapack far-end-2 from its world back at the server’s next start.',
    )
  })
})
