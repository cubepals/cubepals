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

export function settingTakes(setting: keyof ServerSettings, gameVersion: string): SettingTakes {
  switch (setting) {
    case 'difficulty':
    case 'defaultGameMode':
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
    commands.push(`gamerule pvp ${to.pvp}`)
  return commands
}

/**
 * The commands every start runs for the settings the game keeps in its world rather than reads
 * from its properties: PvP, since it became a game rule. The properties it still reads, the
 * image writes from the server's variables.
 */
export function bootCommands(settings: ServerSettings, gameVersion: string): string[] {
  return compareVersions(gameVersion, PVP_GAME_RULE) >= 0 ? [`gamerule pvp ${settings.pvp}`] : []
}

/** Whether the game turned a command down, in vanilla's words for a command it can't run. */
export function refusedByGame(output: string): boolean {
  return /Unknown or incomplete command|Incorrect argument for command/.test(output)
}
