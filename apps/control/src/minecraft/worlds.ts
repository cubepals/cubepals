// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worlds on the volume: the generation types Blockly makes worlds with and the variables that say
 * so, the level names it runs, the command that removes worlds it no longer keeps, and the one
 * that copies worlds back from a copy of the volume.
 */
import { DATA_DIR } from './jars.ts'
import { starterOf } from './starter.ts'

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
 * after that its `level.dat` says how it generates. A world that starts on an archive
 * (`starter.ts`) is the void wherever the archive has nothing.
 */
export function levelTypeEnv(levelType: string): Record<string, string> {
  if (levelType !== VOID_LEVEL && starterOf(levelType) === null) return { LEVEL_TYPE: levelType }
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
export function worldDirectories(levelName: string): string[] {
  if (!LEVEL_NAME.test(levelName)) throw new Error(`Not a level name Blockly makes: ${levelName}`)
  return [levelName, `${levelName}_nether`, `${levelName}_the_end`]
}

/** One exec that removes worlds from the volume; directories already gone are fine. */
export function pruneWorldsCommand(levelNames: readonly string[]): readonly string[] {
  const directories = levelNames.flatMap(worldDirectories)
  return ['sh', '-c', `cd ${DATA_DIR} && rm -rf -- ${directories.join(' ')}`]
}

/** Where worlds being copied back are unpacked first, and, with `.done`, how the copy went. */
const BRINGING_BACK = '.blockly-worlds-back'

/**
 * One exec that starts copying `directories` back from the gzipped tarball of a volume at `url`,
 * in the background, so a big world isn't held to the time an exec may take. Each is unpacked
 * beside the volume's first, then takes the place of what is there, whole. The link and the names
 * are arguments, never part of the script. `WORLDS_BACK` reads how it went.
 */
export function bringWorldsBackCommand(url: string, directories: readonly string[]): readonly string[] {
  const script = [
    `cd ${DATA_DIR} || exit 1`,
    `t=${BRINGING_BACK}`,
    'rm -rf -- "$t" "$t.done" && mkdir -- "$t" || exit 1',
    '(',
    '  s=1',
    '  if curl -fsS "$0" | tar -xzf - -C "$t" --no-anchored -- "$@"; then',
    '    s=0',
    '    for d in "$@"; do',
    '      if [ -e "$t/$d" ]; then rm -rf -- "$d" && mv -- "$t/$d" "$d" || s=1; fi',
    '    done',
    '  fi',
    '  rm -rf -- "$t"',
    '  echo "$s" > "$t.done"',
    ') </dev/null >/dev/null 2>&1 &',
  ].join('\n')
  return ['sh', '-c', script, url, ...directories]
}

/** How the copy went: `0` done, `1` failed, nothing while it is still going. Read once. */
export const WORLDS_BACK: readonly string[] = [
  'sh',
  '-c',
  `cd ${DATA_DIR} && cat ${BRINGING_BACK}.done 2>/dev/null && rm -f ${BRINGING_BACK}.done`,
]
