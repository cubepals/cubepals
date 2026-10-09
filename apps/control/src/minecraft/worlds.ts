import { DATA_DIR } from './jars.ts'

/** World generation types the image passes to the server as `level-type`. */
export const LEVEL_TYPES = [
  'minecraft:normal',
  'minecraft:flat',
  'minecraft:large_biomes',
  'minecraft:amplified',
] as const
export type LevelType = (typeof LEVEL_TYPES)[number]

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
