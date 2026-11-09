// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The commands behind a player page's buttons, and what the game's answers to them mean. */
import { describe, expect, test } from 'bun:test'
import { powerAnswer, powerSteps } from './player-powers.ts'

describe('powerSteps', () => {
  test('each command by its full name first, then the short one vanilla knows', () => {
    expect(powerSteps('Kai', { kind: 'give', item: 'diamond', count: 3 })).toEqual([
      ['minecraft:give Kai minecraft:diamond 3', 'give Kai minecraft:diamond 3'],
    ])
    expect(powerSteps('Kai', { kind: 'give', item: 'create:wrench', count: 1 })[0]?.[1]).toBe(
      'give Kai create:wrench 1',
    )
    expect(powerSteps('Kai', { kind: 'to_player', to: 'x' }, 'Ana')).toEqual([
      ['minecraft:tp Kai Ana', 'tp Kai Ana'],
    ])
    expect(powerSteps('Kai', { kind: 'levels', levels: 5 })[0]?.[1]).toBe('experience add Kai 5 levels')
    expect(powerSteps('Kai', { kind: 'clear_inventory' })[0]?.[1]).toBe('clear Kai')
    expect(powerSteps('Kai', { kind: 'heal' }).map((ways) => ways[1])).toEqual([
      'effect give Kai minecraft:instant_health 1 5 true',
      'effect give Kai minecraft:saturation 1 19 true',
    ])
  })

  test('a trip to the middle of the block named, or onto the ground there with no height', () => {
    const place = { kind: 'teleport', dimension: 'minecraft:overworld', x: 10, z: -4 } as const
    expect(powerSteps('Kai', { ...place, y: 70 })).toEqual([
      ['execute in minecraft:overworld run tp Kai 10.5 70 -3.5'],
    ])
    expect(powerSteps('Kai', { ...place, y: null })).toEqual([
      ['execute in minecraft:overworld run spreadplayers 10.5 -3.5 0 1 false Kai'],
    ])
    expect(powerSteps('Kai', { ...place, dimension: 'minecraft:the_nether', y: null })[0]?.[0]).toContain(
      ' 0 1 under 120 false Kai',
    )
  })

  test('a kick’s reason is one line, and a kick with none says none', () => {
    expect(powerSteps('Kai', { kind: 'kick', reason: ' Be\nnice ' })[0]?.[1]).toBe('kick Kai Be nice')
    expect(powerSteps('Kai', { kind: 'kick', reason: '' })[0]?.[1]).toBe('kick Kai')
  })

  test('only a player’s name reaches a command', () => {
    expect(() => powerSteps('Kai @a', { kind: 'heal' })).toThrow()
    expect(() => powerSteps('Kai', { kind: 'to_player', to: 'x' }, '@a')).toThrow()
  })
})

describe('powerAnswer', () => {
  test('reads the game’s own words', () => {
    expect(powerAnswer('Gave 3 [Diamond] to Kai')).toBe('done')
    expect(powerAnswer('No items were found on player Kai.')).toBe('done')
    expect(powerAnswer('Unknown or incomplete command, see below for error')).toBe('unknown')
    expect(powerAnswer('No player was found')).toBe('not_on')
    expect(powerAnswer("Unknown item 'minecraft:nope'")).toBe('refused')
    expect(powerAnswer("Can't give more than 6400 of [Diamond]")).toBe('refused')
    expect(powerAnswer('Could not spread 1 entity around 0, 0')).toBe('refused')
  })
})
