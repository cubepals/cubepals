// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a running server takes each setting, and the commands that set what the world keeps: game
 * rules in every dimension, by each release's own names, read from worlds Mojang's servers saved.
 */
import { describe, expect, test } from 'bun:test'
import { defaultSettings } from '../domain/revision/revision.ts'
import { LibraryFileFormats } from '../infra/formats/file-formats.ts'
import {
  bootCommands,
  gameRuleCommands,
  keepInventoryRule,
  liveCommands,
  refusedByGame,
  settingTakes,
} from './settings.ts'

/** A rule set in each dimension, as Paper keeps one for each. */
const everywhere = (rule: string, value: boolean) => [
  `execute in minecraft:overworld run gamerule ${rule} ${value}`,
  `execute in minecraft:the_nether run gamerule ${rule} ${value}`,
  `execute in minecraft:the_end run gamerule ${rule} ${value}`,
]

describe('settings a running server takes', () => {
  const before = defaultSettings({ name: 'Home', gameMode: 'survival', maxPlayers: 10 })

  test('difficulty and game mode change as people play; what the game reads as it starts restarts it', () => {
    for (const version of ['1.20.1', '1.21.8', '26.3']) {
      expect(settingTakes('difficulty', version)).toBe('now')
      expect(settingTakes('defaultGameMode', version)).toBe('now')
      expect(settingTakes('motd', version)).toBe('next_start')
      for (const setting of [
        'viewDistance',
        'simulationDistance',
        'maxPlayers',
        'spawnProtection',
        'onlineMode',
        'otherVersions',
        'bedrock',
      ] as const)
        expect(settingTakes(setting, version)).toBe('restart')
    }
  })

  test('PvP changes as people play from the release that made it a game rule', () => {
    expect(settingTakes('pvp', '1.21.8')).toBe('restart')
    expect(settingTakes('pvp', '1.21.9')).toBe('now')
    expect(settingTakes('pvp', '26.3')).toBe('now')
    expect(liveCommands(before, { ...before, pvp: false }, '26.3')).toEqual(everywhere('pvp', false))
    expect(liveCommands(before, { ...before, pvp: false }, '1.21.8')).toEqual([])
  })

  test('a game rule is set in every dimension, since Paper keeps each one’s apart', () => {
    expect(gameRuleCommands('pvp', true)).toEqual(everywhere('pvp', true))
  })

  test('keeping items on death changes as people play, by the rule’s name on the release', () => {
    for (const version of ['1.20.1', '1.21.10', '26.3'])
      expect(settingTakes('keepInventory', version)).toBe('now')
    const keeping = { ...before, keepInventory: true }
    expect(liveCommands(before, keeping, '26.2')).toEqual(everywhere('keep_inventory', true))
    expect(liveCommands(keeping, before, '1.21.10')).toEqual(everywhere('keepInventory', false))
    // Never chosen is off, as Minecraft has it: choosing off changes nothing.
    expect(liveCommands(before, { ...before, keepInventory: false }, '26.2')).toEqual([])
  })

  test('every start sets the rules the world keeps, kept items on or off', () => {
    expect(bootCommands(before, '26.2')).toEqual([
      ...everywhere('pvp', true),
      ...everywhere('keep_inventory', false),
    ])
    expect(bootCommands({ ...before, keepInventory: true, pvp: false }, '1.21.9')).toEqual([
      ...everywhere('pvp', false),
      ...everywhere('keepInventory', true),
    ])
    // PvP is still a property there, which the image writes.
    expect(bootCommands({ ...before, keepInventory: true }, '1.21.8')).toEqual(
      everywhere('keepInventory', true),
    )
  })

  test('the rule’s name is the one each release’s own saved world gives it', async () => {
    const formats = new LibraryFileFormats()
    const decoded = async (path: string) =>
      (await formats.decodeNbt(
        new Uint8Array(await Bun.file(`${import.meta.dir}/${path}`).arrayBuffer()),
      )) as Record<string, Record<string, Record<string, unknown>>>
    // Files Mojang's own servers wrote: 1.21.10 and 26.2 in `rule-fixtures/`, 1.21.11 an imported world's.
    const older = await decoded('rule-fixtures/1.21.10/level.dat')
    expect(older.Data?.Version).toMatchObject({ Name: '1.21.10' })
    expect(Object.keys(older.Data?.GameRules ?? {})).toContain(keepInventoryRule('1.21.10'))
    const renamed = await decoded('world-fixtures/vanilla-1.21.11/world/level.dat')
    expect(renamed.Data?.Version).toMatchObject({ Name: '1.21.11' })
    expect(Object.keys(renamed.Data?.game_rules ?? {})).toContain(`minecraft:${keepInventoryRule('1.21.11')}`)
    const own = await decoded('rule-fixtures/26.2/game_rules.dat')
    expect(Object.keys(own.data ?? {})).toContain(`minecraft:${keepInventoryRule('26.2')}`)
    expect(keepInventoryRule('1.21.10')).toBe('keepInventory')
    expect(keepInventoryRule('1.21.11')).toBe('keep_inventory')
  })

  test('a new default game mode moves whoever is on to it', () => {
    expect(
      liveCommands(
        before,
        { ...before, defaultGameMode: 'creative', difficulty: 'hard', motd: 'Hi' },
        '26.3',
      ),
    ).toEqual(['difficulty hard', 'defaultgamemode creative', 'gamemode creative @a'])
    expect(liveCommands(before, before, '26.3')).toEqual([])
  })

  test('a command the game turned down is told from one it ran', () => {
    expect(refusedByGame('Unknown or incomplete command, see below for error')).toBe(true)
    expect(refusedByGame('Incorrect argument for command')).toBe(true)
    expect(refusedByGame('The difficulty has been set to Hard')).toBe(false)
    expect(refusedByGame('No player was found')).toBe(false)
  })
})
