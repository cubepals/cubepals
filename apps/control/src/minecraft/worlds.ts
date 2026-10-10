// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worlds on the volume: the generation types Blockly makes worlds with and the variables that say
 * so, the level names it runs, and the one command that removes worlds it no longer keeps.
 */
import { DATA_DIR } from './jars.ts'

/**
 * A world of nothing but the small stone platform Minecraft puts at spawn: a base for islands and
 * arenas, which templates make; nobody picks it when creating a world. Vanilla's superflat preset
 * "The Void", run as `level-type=minecraft:flat` with the preset's own settings
 * (data/minecraft/worldgen/flat_level_generator_preset/the_void.json, the same from 1.20.1 to
 * 26.3): one layer of air over the void biome, whose one feature is that platform.
 */
export const VOID_LEVEL = 'blockly:void'

/** World generation types: the image passes each but the void to the server as `level-type`. */
export const LEVEL_TYPES = [
  'minecraft:normal',
  'minecraft:flat',
  'minecraft:large_biomes',
  'minecraft:amplified',
  VOID_LEVEL,
] as const
export type LevelType = (typeof LEVEL_TYPES)[number]

const VOID_SETTINGS = {
  biome: 'minecraft:the_void',
  features: true,
  lakes: false,
  layers: [{ block: 'minecraft:air', height: 1 }],
  structure_overrides: [],
}

/**
 * The image's variables for a world's type. Minecraft reads them only when it makes the world;
 * after that its `level.dat` says how it generates.
 */
export function levelTypeEnv(levelType: string): Record<string, string> {
  if (levelType !== VOID_LEVEL) return { LEVEL_TYPE: levelType }
  return { LEVEL_TYPE: 'minecraft:flat', GENERATOR_SETTINGS: JSON.stringify(VOID_SETTINGS) }
}

/** Level names Blockly makes (`world`, `world-2`, …); nothing else is ever put in a command. */
const LEVEL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Whether a world folder's name is one Blockly can run, and put in a command. */
export const isLevelName = (name: string): boolean => LEVEL_NAME.test(name)

/**
 * Every directory a world takes on the volume. Vanilla keeps the Nether and the End inside the
 * level directory; Paper keeps them beside it, as `<level>_nether` and `<level>_the_end`.
 */
function worldDirectories(levelName: string): string[] {
  if (!LEVEL_NAME.test(levelName)) throw new Error(`Not a level name Blockly makes: ${levelName}`)
  return [levelName, `${levelName}_nether`, `${levelName}_the_end`]
}

/** One exec that removes worlds from the volume; directories already gone are fine. */
export function pruneWorldsCommand(levelNames: readonly string[]): readonly string[] {
  const directories = levelNames.flatMap(worldDirectories)
  return ['sh', '-c', `cd ${DATA_DIR} && rm -rf -- ${directories.join(' ')}`]
}
