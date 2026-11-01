// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { ServerSettings } from '../domain/revision/revision.ts'
import { compareVersions } from './versions.ts'

/**
 * How a running server takes a change to one of its settings:
 * - `now`: a console command changes it in the game as people play;
 * - `next_start`: only the server list shows it, and it shows from the next start, since nobody
 *   playing should be sent away for it;
 * - `restart`: the game reads it only as it starts.
 * Every start sets each one again, from the server's variables or by command (`bootCommands`),
 * so what a command changed holds.
 */
export type SettingTakes = 'now' | 'next_start' | 'restart'

/** The release that made PvP a game rule, which a running server changes; before it, a property. */
const PVP_GAME_RULE = '1.21.9'

/**
 * The release that named game rules as registry entries: `keepInventory` became `keep_inventory`.
 * Read from Mojang's own server jars: 1.21.10's classes hold only `keepInventory`; 1.21.11's
 * `GameRules` holds `keep_inventory`, and its data fixer (`GameRuleRegistryFix`) renames the old
 * name in a saved world to `minecraft:keep_inventory`, as the 1.21.11 world in `world-fixtures/`
 * shows. A console that is given the other era's name refuses it ("Incorrect argument for command").
 */
const REGISTRY_RULE_NAMES = '1.21.11'

/** The keep-inventory game rule's name on a release. */
export const keepInventoryRule = (gameVersion: string): string =>
  compareVersions(gameVersion, REGISTRY_RULE_NAMES) >= 0 ? 'keep_inventory' : 'keepInventory'

/**
 * The dimensions a game rule is set in. Paper keeps each world's game rules apart, and a console
 * `gamerule` changes only the overworld's (tried 2026-10-31 on Paper 26.2-135: the Nether and the
 * End kept theirs), so a player who died there still lost what they carried. Each is set in its
 * own; on a server that shares one set, the same rule is set three times.
 */
const DIMENSIONS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'] as const

/** The commands that set a game rule everywhere a player can be. */
export const gameRuleCommands = (rule: string, value: boolean): string[] =>
  DIMENSIONS.map((dimension) => `execute in ${dimension} run gamerule ${rule} ${value}`)

/** Whether players keep what they carry when they die: off, as Minecraft has it, unless chosen. */
const keepsInventory = (settings: Pick<ServerSettings, 'keepInventory'>): boolean =>
  settings.keepInventory ?? false

export function settingTakes(setting: keyof ServerSettings, gameVersion: string): SettingTakes {
  switch (setting) {
    case 'difficulty':
    case 'defaultGameMode':
    case 'keepInventory':
      return 'now'
    case 'pvp':
      return compareVersions(gameVersion, PVP_GAME_RULE) >= 0 ? 'now' : 'restart'
    case 'motd':
      return 'next_start'
    case 'viewDistance':
    case 'simulationDistance':
    case 'maxPlayers':
    case 'spawnProtection':
    case 'onlineMode':
    case 'otherVersions':
    case 'bedrock':
      return 'restart'
  }
}

/**
 * The console commands that bring a running server from one set of settings to the other, for
 * the settings it takes `now`. A new default game mode moves whoever is on to it as well: the
 * owner who switches their world to creative means the people in it.
 */
export function liveCommands(from: ServerSettings, to: ServerSettings, gameVersion: string): string[] {
  const commands: string[] = []
  if (from.difficulty !== to.difficulty) commands.push(`difficulty ${to.difficulty}`)
  if (from.defaultGameMode !== to.defaultGameMode)
    commands.push(`defaultgamemode ${to.defaultGameMode}`, `gamemode ${to.defaultGameMode} @a`)
  if (from.pvp !== to.pvp && settingTakes('pvp', gameVersion) === 'now')
    commands.push(...gameRuleCommands('pvp', to.pvp))
  if (keepsInventory(from) !== keepsInventory(to))
    commands.push(...gameRuleCommands(keepInventoryRule(gameVersion), keepsInventory(to)))
  return commands
}

/**
 * The commands every start runs for the settings the game keeps in its world rather than reads
 * from its properties: PvP, since it became a game rule, and keeping items on death, on or off,
 * so a new world, one brought back or one a console changed plays as the settings say. The
 * properties it still reads, the image writes from the server's variables.
 */
export function bootCommands(settings: ServerSettings, gameVersion: string): string[] {
  return [
    ...(compareVersions(gameVersion, PVP_GAME_RULE) >= 0 ? gameRuleCommands('pvp', settings.pvp) : []),
    ...gameRuleCommands(keepInventoryRule(gameVersion), keepsInventory(settings)),
  ]
}

/** Whether the game turned a command down, in vanilla's words for a command it can't run. */
export function refusedByGame(output: string): boolean {
  return /Unknown or incomplete command|Incorrect argument for command/.test(output)
}
