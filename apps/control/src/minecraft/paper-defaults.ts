// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The settings of Paper's own that Cubepals sets for how a server runs, which leave the game's
 * mechanics as they are: `CHUNKS` on every server that runs on Paper, `EXPLOSIONS` on one made as
 * Paper. All are in `config/paper-world-defaults.yml`, set at a start, before Paper reads the file.
 *
 * A server with no such file yet, at its first start on Paper, is given these settings alone: Paper
 * fills in every other setting with its own default and keeps what is written. A server that has
 * the file gets a line rewritten only while it still holds Paper's own default; any other value is
 * one somebody chose, its owner or a setup's carried file, and stays as it is, as does every other
 * line. The step runs as root, so it replaces any link on the way (`volume-links.ts`) and hands what
 * it writes to the volume's owner. A file it can't rewrite is left as it was, and the server starts.
 * Like every step before the image's start it is no part of what drift compares
 * (`withoutOwnSteps`): it reaches a server at its next start and restarts none.
 *
 * Not for a setting that changes the game (collisions, redstone, mob spawning, despawning, hoppers,
 * how far the world is shown or ticked): none is set here. On plain Minecraft run on Paper,
 * `vanilla-paper.ts` turns Paper's own changes to the game back; it owns what a plain server's
 * files first hold, and takes its chunk lines from here. Not for a setup's carried file either,
 * which is placed after this step and replaces the whole file (`carried.ts`).
 */
import { DATA_DIR } from './jars.ts'

const FILE = 'config/paper-world-defaults.yml'

/** One setting: the section it is under at the top of the file, Paper's own default, and Cubepals' value. */
interface Setting {
  section: string
  key: string
  stock: string
  value: string
}

/**
 * The settings. Names, nesting and Paper's defaults are from Paper's world configuration reference
 * (docs.papermc.io/paper/reference/world-configuration); a key an older Paper doesn't have is left
 * alone by it.
 *
 * - `max-auto-save-chunks-per-tick`: the most chunks an autosave writes in one tick. Fewer spreads
 *   the same save over more ticks, so no single tick carries it.
 *
 * Not `prevent-moving-into-unloaded-chunks`: it holds a player who moves faster than chunks load
 * at the last one loaded, which someone flying feels as being pulled back.
 */
const CHUNKS: readonly Setting[] = [
  { section: 'chunks', key: 'max-auto-save-chunks-per-tick', stock: '24', value: '8' },
]

/**
 * `optimize-explosions` keeps what the server looks up about the entities near an explosion, where
 * it would otherwise work the same out again as the explosion goes on. Only on a server made as
 * Paper: on plain Minecraft run on Paper explosions stay exactly Mojang's (`vanilla-paper.ts`).
 */
const EXPLOSIONS: readonly Setting[] = [
  { section: 'environment', key: 'optimize-explosions', stock: 'false', value: 'true' },
]

/** A setting's line as Paper writes it, one level in, holding `value`. */
const lineOf = (setting: Setting, value: string) => `  ${setting.key}: ${value}`

/** The chunk settings as lines under `chunks:`, for the file a plain server's first start writes. */
export const PAPER_CHUNK_LINES: readonly string[] = CHUNKS.map((setting) => lineOf(setting, setting.value))

/** The file holding `settings` alone, as YAML lines, each section once; none holds a single quote. */
function fileOf(settings: readonly Setting[]): string[] {
  const sections = [...new Set(settings.map((setting) => setting.section))]
  return sections.flatMap((section) => [
    `${section}:`,
    ...settings.filter((setting) => setting.section === section).map((s) => lineOf(s, s.value)),
  ])
}

/**
 * The awk program that rewrites a file Paper wrote. A line is rewritten only when it is, to the
 * byte, the key one level in with Paper's default, under its own section at the top of the file: so
 * no other key, no other value and no same name under another section can match. It ends in failure
 * where it rewrote nothing, so a file with nothing to change is never replaced.
 */
const rewriteOf = (settings: readonly Setting[]) =>
  [
    '/^[^ #]/ { s = $0 }',
    ...settings.map(
      (setting) =>
        `s == "${setting.section}:" && $0 == "${lineOf(setting, setting.stock)}" { print "${lineOf(setting, setting.value)}"; n++; next }`,
    ),
    '{ print }',
    'END { exit !n }',
  ].join(' ')

/** The volume's owner, as `chown` takes it. */
const OWNER = `"$(ls -nd ${DATA_DIR} | awk '{ print $3 ":" $4 }')"`

/**
 * The step for `settings`. The rewrite goes to a file beside the one it replaces, which is handed
 * to the volume's owner and takes its place only when awk changed a line, and is removed wherever
 * it didn't. `writesNew` is whether a server with no file is given one here.
 */
const stepOf = (settings: readonly Setting[], writesNew: boolean) =>
  [
    `unlinked ${FILE}; unlinked ${FILE}.new; p=${DATA_DIR}/${FILE}; if [ -f "$p" ]; then`,
    `awk '${rewriteOf(settings)}' "$p" > "$p.new" && chown -h ${OWNER} "$p.new" && mv -fT "$p.new" "$p"; rm -f "$p.new";`,
    ...(writesNew
      ? [
          `elif [ ! -e "$p" ]; then mkdir -p "$(dirname "$p")"`,
          `&& printf '%s\\n' ${fileOf(settings)
            .map((line) => `'${line}'`)
            .join(' ')} > "$p"`,
          `&& chown -h ${OWNER} "$(dirname "$p")" "$p";`,
        ]
      : []),
    'fi;',
  ].join(' ')

/** The step on a server made as Paper, after Paper's own (`PAPER_STEP`). */
export const PAPER_DEFAULTS_STEP = stepOf([...CHUNKS, ...EXPLOSIONS], true)

/**
 * The step on plain Minecraft run on Paper: the chunk settings alone, and only on a file already
 * there, since its first start's file is written by `VANILLA_PAPER_STEP`, with these lines in it.
 */
export const PLAIN_PAPER_DEFAULTS_STEP = stepOf(CHUNKS, false)
