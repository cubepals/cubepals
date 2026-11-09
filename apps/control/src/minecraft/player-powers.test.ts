// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The commands behind a player page's buttons, and what the game's answers to them mean. The
 * answers are the game's own lines, from 26.3's language file, filled in as its console fills
 * them (`infra/fake/fake-minecraft/lang-26.3.json`, which the fake server answers with too).
 */
import { describe, expect, test } from 'bun:test'
import lang from '../infra/fake/fake-minecraft/lang-26.3.json' with { type: 'json' }
import { powerAnswer, powerSteps } from './player-powers.ts'

type Key = keyof typeof lang.lines

/** A line of the game's, its `%s` filled in order. */
const said = (key: Key, ...values: string[]) => {
  let i = 0
  return lang.lines[key].replace(/%s/g, () => values[i++] ?? '')
}

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

describe('powerAnswer, on the game’s own lines', () => {
  test('done', () => {
    for (const answer of [
      said('commands.give.success.single', '3', '[Diamond]', 'Kai'),
      said('commands.teleport.success.entity.single', 'Kai', 'Ana'),
      said('commands.teleport.success.location.single', 'Kai', '10.500000', '70.000000', '-3.500000'),
      said('commands.spreadplayers.success.entities', '1', '10.5', '-3.5', '0.00'),
      said('commands.effect.give.success.single', 'Instant Health', 'Kai'),
      said('commands.experience.add.levels.success.single', '5', 'Kai'),
      said('commands.clear.success.single', '12', 'Kai'),
      // Nothing to clear is an inventory already empty.
      said('clear.failed.single', 'Kai'),
      said('commands.kick.success', 'Kai', lang.lines['multiplayer.disconnect.kicked']),
      // Something stronger already on them heals or feeds them all the same.
      said('commands.effect.give.failed'),
    ])
      expect(powerAnswer(answer)).toBe('done')
  })

  test('the next way, the player gone, and the game’s refusals', () => {
    expect(powerAnswer(said('command.unknown.command'))).toBe('unknown')
    expect(powerAnswer(said('argument.entity.notfound.player'))).toBe('not_on')
    expect(powerAnswer(said('argument.entity.notfound.entity'))).toBe('not_on')
    for (const answer of [
      said('argument.item.id.invalid', 'minecraft:nope'),
      said('commands.give.failed.toomanyitems', '6400', '[Diamond]'),
      said('commands.spreadplayers.failed.entities', '1', '0', '0', '0.00'),
      said('command.unknown.argument'),
    ])
      expect(powerAnswer(answer)).toBe('refused')
  })
})
