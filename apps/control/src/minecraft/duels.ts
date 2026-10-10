// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Blockly knows about Duels by Dartanman, the plugin the Duels template plays: the files
 * Cubepals writes for it, so two friends can fight the moment they join, with nobody standing on
 * blocks to bind an arena first.
 *
 * Duels keeps its arenas and kits in its own `config.yml`, and fills in whatever that file leaves
 * out from its defaults as it starts (`copyDefaults`), so the carried file holds only these two.
 * It declares no permissions, so Bukkit leaves every one of its commands to operators; the server's
 * `permissions.yml` gives everyone the ones for playing.
 *
 * The arena sits on the stone platform a void world is made with (`worlds.ts`): vanilla's
 * `void_start_platform`, 33 by 33 blocks of stone (x -8 to 24, z -8 to 24) whose top is y -61, three
 * above the bottom of the world, with cobblestone at x 8, z 8. Falling off it is losing. A world
 * of another kind gets a room of stone in the same place as it starts (`ARENA_COMMANDS`).
 */

import type { PinnedMod } from '../domain/mods/artifact.ts'
import { type CarriedFile, RUNNING_LEVEL } from '../domain/revision/carried.ts'

/**
 * The arena and the kit, in the plugin's own shape (its `ArenaManager` and `KitManager`). Each
 * fighter starts eight blocks from an edge, sixteen apart, facing the other; the lobby, where both
 * wait out the countdown, is between them. The world named is the one the server runs, so the
 * arena moves with a fresh world, which is void like the one it leaves and has the same platform.
 *
 * The kit is iron, a bow and food: a fair fight that lasts a while. Its items are in the item format
 * of 1.20.5 and later, which the plugin reads on the 1.21.11 it runs on; the plugin's own default
 * kit is in the older one, which it warns may break.
 */
const ARENA_AND_KIT = `# Written by Cubepals at every start: the arena and the kit everyone fights with.
Kits:
  '0':
    Name: Default
    Armor:
      Helmet: '{count:1,id:"minecraft:iron_helmet"}'
      Chestplate: '{count:1,id:"minecraft:iron_chestplate"}'
      Leggings: '{count:1,id:"minecraft:iron_leggings"}'
      Boots: '{count:1,id:"minecraft:iron_boots"}'
    Inventory:
      - '{count:1,id:"minecraft:iron_sword"}'
      - '{count:1,id:"minecraft:bow"}'
      - '{count:16,id:"minecraft:arrow"}'
      - '{count:8,id:"minecraft:cooked_beef"}'
Arenas:
  '1':
    Name: Platform
    Countdown-Seconds: 10
    Spawn-One: { World: ${RUNNING_LEVEL}, X: 0.5, Y: -60.0, Z: 8.5, Yaw: -90.0, Pitch: 0.0 }
    Spawn-Two: { World: ${RUNNING_LEVEL}, X: 16.5, Y: -60.0, Z: 8.5, Yaw: 90.0, Pitch: 0.0 }
    Lobby: { World: ${RUNNING_LEVEL}, X: 8.5, Y: -60.0, Z: 8.5, Yaw: 0.0, Pitch: 0.0 }
`

/**
 * What every player may do: join and leave a duel, pick a kit, see arenas, stats and the
 * leaderboard. Making arenas and kits, and moving stats, stay with operators.
 */
const PERMISSIONS = `# Written by Cubepals at every start: the Duels commands everyone may use.
${['join', 'leave', 'help', 'listarenas', 'stats', 'top', 'kits.list', 'kits.select']
  .map((command) => `duels.${command}:\n  default: true\n`)
  .join('')}`

/** The files the Duels template carries, by their path under the server's directory. */
export const DUELS_FILES: readonly CarriedFile[] = [
  { path: 'plugins/Duels/config.yml', content: ARENA_AND_KIT },
  { path: 'permissions.yml', content: PERMISSIONS },
]

/** Duels' project on Modrinth, as a pinned plugin records it. */
const DUELS = 'pZyHIvCK'

/** Whether a server's plugins include Duels, whose arena Cubepals builds where a world lacks it. */
export const runsDuels = (mods: readonly PinnedMod[]): boolean =>
  mods.some((m) => m.source.catalog === 'modrinth' && 'projectId' in m.source && m.source.projectId === DUELS)

/** Only where the void world's platform isn't: its cobblestone, at the middle, marks it. */
const UNLESS_PLATFORM = 'execute unless block 8 -61 8 minecraft:cobblestone run'

/**
 * The arena on a world that isn't void, which an owner can make for a Duels server: in its place
 * there is ground or rock, not the platform. So, as the server starts, a room of stone is built
 * around the arena's place: the platform's floor, walls to keep out lava and caves, and a ceiling
 * of glowstone, bright enough that no monster spawns inside. Its middle is then cobblestone like
 * the platform's, so the next start finds it built. A void world finds its platform and is left
 * alone. Its chunks stay loaded, as they must be to build, and are ready when a duel teleports in.
 */
export const ARENA_COMMANDS: readonly string[] = [
  'forceload add -9 -9 25 25',
  `${UNLESS_PLATFORM} fill -9 -61 -9 25 -48 25 minecraft:stone hollow`,
  `${UNLESS_PLATFORM} fill -8 -48 -8 24 -48 24 minecraft:glowstone`,
  `${UNLESS_PLATFORM} setblock 8 -61 8 minecraft:cobblestone`,
]
