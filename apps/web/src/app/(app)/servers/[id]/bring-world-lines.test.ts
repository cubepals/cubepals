// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What "Bring a world" says: the player's world by its name, and what playing it does. */

import { describe, expect, test } from 'bun:test'
import type { BroughtWorld } from '@blockly/contracts'
import { comingName, KEPT_LINE, movesLine, playLabel, serverLine, titleOf } from './bring-world-lines.ts'

const maple: BroughtWorld = { name: 'Maple Hollow', gameVersion: '1.21.11', newer: null }

describe('the world by its name while it comes in', () => {
  test('is the name its player gave, else its name in Minecraft, else none', () => {
    expect(comingName('  Our Base ', 'Maple Hollow')).toBe('Our Base')
    expect(comingName('', 'Maple Hollow')).toBe('Maple Hollow')
    expect(comingName(' ', ' ')).toBeNull()
    expect(comingName('', null)).toBeNull()
  })

  test('the title says what is happening to it', () => {
    expect(titleOf('picked', 'Maple Hollow')).toBe('Bring a world')
    expect(titleOf('coming', 'Maple Hollow')).toBe('Bringing Maple Hollow to your server')
    expect(titleOf('coming', null)).toBe('Bringing your world to your server')
    expect(titleOf('ready', 'Maple Hollow')).toBe('Maple Hollow is ready')
    expect(titleOf('refused', null)).toBe('Your world couldn’t come in')
    // A server's world is often called "world": a title that starts with it starts with a capital.
    expect(titleOf('ready', 'world')).toBe('World is ready')
    expect(titleOf('coming', 'world')).toBe('Bringing world to your server')
  })

  test('no word of it is a backup or a restore', () => {
    const said = [
      ...(['picked', 'coming', 'ready', 'refused'] as const).map((stage) => titleOf(stage, 'Maple Hollow')),
      playLabel(maple),
      serverLine('Maple Hollow', 'running'),
    ]
    for (const line of said) expect(line).not.toMatch(/backup|restor/i)
  })
})

describe('playing it', () => {
  test('is pressed by its name, with the release where the server moves up to it', () => {
    expect(playLabel(maple)).toBe('Play Maple Hollow')
    expect(playLabel({ ...maple, newer: { gameVersion: '26.3', movesServer: true } })).toBe(
      'Play Maple Hollow on 26.3',
    )
    // A server with mods moves in its settings, not here.
    expect(playLabel({ ...maple, newer: { gameVersion: '26.3', movesServer: false } })).toBe(
      'Play Maple Hollow',
    )
  })

  test('says once that moving up is for good, and only where this press does it', () => {
    expect(movesLine({ ...maple, newer: { gameVersion: '26.3', movesServer: true } }, '1.21.11')).toBe(
      'Playing it moves this server from Minecraft 1.21.11 up to 26.3, for good: a world can’t go back to an older Minecraft.',
    )
    expect(movesLine(maple, '1.21.11')).toBeNull()
    expect(movesLine({ ...maple, newer: { gameVersion: '26.3', movesServer: false } }, '1.21.11')).toBeNull()
  })

  test('says what the server does, by what it is doing now', () => {
    expect(serverLine('Maple Hollow', 'running')).toBe(
      'The server restarts into Maple Hollow. Anyone online can join again once it’s up.',
    )
    expect(serverLine('Maple Hollow', 'stopped')).toBe(
      'The server is asleep, and wakes on Maple Hollow when someone joins.',
    )
    expect(serverLine('Maple Hollow', 'failed')).toBe('The server starts on Maple Hollow.')
  })

  test('says the world it has now is kept, and where the way back is', () => {
    expect(KEPT_LINE).toBe(
      'The world the server has now is kept, and you can switch back to it from Backups.',
    )
  })
})
