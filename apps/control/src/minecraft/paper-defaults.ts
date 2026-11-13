// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The settings of Paper's own that Cubepals gives a new server for how it runs, which leave the
 * game's mechanics as they are: `CHUNKS` on every server that runs on Paper, `EXPLOSIONS` on one
 * made as Paper. All are in `config/paper-world-defaults.yml`.
 *
 * They are a server's first values, never a change to one that has its own: the file is written
 * only where the server has none yet, at its first start on Paper, before Paper writes it. Paper
 * fills in every other setting with its own default and keeps what is written. A server that ran
 * on Paper before keeps the file it has, whatever it holds, so a value somebody set, Paper's own
 * default among them, is never written over. The step runs as root, so it replaces any link on the
 * way (`volume-links.ts`) and hands what it writes to the volume's owner. Like every step before
 * the image's start it is no part of what drift compares (`withoutOwnSteps`).
 *
 * Not for a setting that changes the game (collisions, redstone, mob spawning, despawning, hoppers,
 * how far the world is shown or ticked): none is set here. On plain Minecraft run on Paper,
 * `vanilla-paper.ts` turns Paper's own changes to the game back; it owns what a plain server's
 * file first holds, and takes its chunk line from here. Not for a setup's carried file either,
 * which is placed after this step and replaces the whole file (`carried.ts`).
 */
import { DATA_DIR } from './jars.ts'

const FILE = 'config/paper-world-defaults.yml'

/** One setting: the section it is under at the top of the file, and the value a new server is given. */
interface Setting {
  section: string
  key: string
  value: string
}

/**
 * The settings. Names and nesting are from Paper's world configuration reference
 * (docs.papermc.io/paper/reference/world-configuration), where Paper's own defaults are 24 and
 * false; a key an older Paper doesn't have is left alone by it.
 *
 * - `max-auto-save-chunks-per-tick`: the most chunks an autosave writes in one tick. Fewer spreads
 *   the same save over more ticks, so no single tick carries it.
 *
 * Not `prevent-moving-into-unloaded-chunks`: it holds a player who moves faster than chunks load
 * at the last one loaded, which someone flying feels as being pulled back.
 */
const CHUNKS: readonly Setting[] = [{ section: 'chunks', key: 'max-auto-save-chunks-per-tick', value: '8' }]

/**
 * `optimize-explosions` keeps what the server looks up about the entities near an explosion, where
 * it would otherwise work the same out again as the explosion goes on. Only on a server made as
 * Paper: on plain Minecraft run on Paper explosions stay exactly Mojang's (`vanilla-paper.ts`).
 */
const EXPLOSIONS: readonly Setting[] = [{ section: 'environment', key: 'optimize-explosions', value: 'true' }]

/** A setting's line as Paper writes it, one level in. */
const lineOf = (setting: Setting) => `  ${setting.key}: ${setting.value}`

/** The chunk setting as lines under `chunks:`, for the file a plain server's first start writes. */
export const PAPER_CHUNK_LINES: readonly string[] = CHUNKS.map(lineOf)

/** The file holding `settings` alone, as YAML lines, each section once; none holds a single quote. */
function fileOf(settings: readonly Setting[]): string[] {
  const sections = [...new Set(settings.map((setting) => setting.section))]
  return sections.flatMap((section) => [
    `${section}:`,
    ...settings.filter((setting) => setting.section === section).map(lineOf),
  ])
}

/**
 * The step on a server made as Paper, after Paper's own (`PAPER_STEP`): the file, where there is
 * none. Plain Minecraft run on Paper has no step of its own here: its first start's file is
 * written by `VANILLA_PAPER_STEP`, with the chunk line in it.
 */
export const PAPER_DEFAULTS_STEP = [
  `unlinked ${FILE}; f=${DATA_DIR}/${FILE}; if [ ! -e "$f" ]; then mkdir -p "$(dirname "$f")"`,
  `&& printf '%s\\n' ${fileOf([...CHUNKS, ...EXPLOSIONS])
    .map((line) => `'${line}'`)
    .join(' ')} > "$f"`,
  `&& chown -h "$(ls -nd ${DATA_DIR} | awk '{ print $3 ":" $4 }')" "$(dirname "$f")" "$f"; fi;`,
].join(' ')
