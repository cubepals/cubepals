// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a revision puts on the volume itself, before the image starts: the files Cubepals carries
 * for it, and the plugins whose jar goes in a folder of their own. The image has a place for
 * neither on Paper (its `PLUGINS` all land in `plugins/`, and a pack's `overrides/` only install
 * with a pack), so a short step of the entrypoint does both (docs/modpack-system.md § Carried
 * files). Not for pack servers: a pack carries its own files and the image installs them.
 *
 * A carried file replaces the one on disk at every start, the first included: what the server
 * reads is always what its revision says, a plugin finding its file there keeps it rather than
 * writing its defaults, and going back to a revision puts that revision's file back. A plugin that
 * fills in what a file leaves out (Bukkit's `copyDefaults`, as LifeStealZ does) lets a carried file
 * hold only what Cubepals changes.
 */

import type { ModArtifact, PinnedMod } from '../domain/mods/artifact.ts'
import { onLevel, placedMods } from '../domain/revision/carried.ts'
import type { ServerRevision } from '../domain/revision/revision.ts'
import { DATA_DIR, diskName } from './jars.ts'
import { type ListVariables, readList } from './step-lists.ts'

/**
 * Whether a path is one Cubepals may write: relative, plain, and none of the files Blockly keeps
 * itself (`server.properties`, the access lists, its own `.blockly-` marks). Its names hold
 * letters, digits, `.`, `_`, `+` and `-` only, so the step says it without quoting.
 */
export function placeablePath(path: string): boolean {
  const parts = path.split('/')
  return (
    parts.every((part) => /^[A-Za-z0-9._+-]+$/.test(part) && part !== '.' && part !== '..') &&
    !KEPT_BY_BLOCKLY.has(path) &&
    !path.startsWith('.blockly')
  )
}

/** Files at the server's root that Blockly writes or reads on its own account. */
const KEPT_BY_BLOCKLY: ReadonlySet<string> = new Set([
  'server.properties',
  'eula.txt',
  'whitelist.json',
  'ops.json',
  'banned-players.json',
  'banned-ips.json',
  'server-icon.png',
])

/** Where the volume remembers what this step wrote, so what a later revision drops goes too. */
const PLACED_RECORD = '.blockly-files'
const PLACED_MARK = `${DATA_DIR}/${PLACED_RECORD}`

/**
 * A line of the record that `placeablePath` refuses, as a shell `case` pattern: never a path the
 * step wrote. The record is on the volume, where the server can change it, so such a line is
 * passed over rather than removed.
 */
const UNPLACEABLE = [
  "''",
  '*[!A-Za-z0-9._+/-]*',
  '/*',
  '*/',
  '*//*',
  '.',
  '..',
  './*',
  '../*',
  '*/./*',
  '*/../*',
  '*/.',
  '*/..',
  '.blockly*',
  ...KEPT_BY_BLOCKLY,
].join('|')

/**
 * Each placed jar on one line: its path, its sha512 and its link. A start given more of them than
 * one variable holds is given them compressed (`step-lists.ts`).
 */
export const JARS_VARIABLES: ListVariables = { plain: 'BLOCKLY_JARS', compressed: 'BLOCKLY_JARS_GZ' }
/**
 * Each carried file on one line: its path and its bytes in base64, as `carriedEnv` writes them. A
 * start is given them compressed instead (`compressed`, made by `app/servers/carried-files.ts`): the
 * lines gzipped, the whole in base64. Linux takes no single variable over 128 KiB (`MAX_ARG_STRLEN`,
 * 131,072 bytes), and the Arcade's files alone, as plain lines, are more: a machine given them
 * fails before anything runs ("Argument list too long", production's Arcade, 2026-10-17). The step
 * reads either, the compressed one first.
 */
export const FILES_VARIABLES = {
  plain: 'BLOCKLY_FILES',
  compressed: 'BLOCKLY_FILES_GZ',
} as const satisfies ListVariables

/**
 * The step. Names hold no spaces or quotes (`placeablePath`), so the shell splits lines on spaces.
 * What the last start wrote and this revision doesn't is removed; a placed jar already holding
 * its bytes is kept, and any other is fetched and checked against its sha512 before it is moved
 * into place, or the start stops with what it couldn't fetch. Then every carried file is written.
 * It runs as root, so it replaces any link on the way to what it writes or removes
 * (`volume-links.ts`), and never follows one out of the volume.
 */
export const CARRIED_STEP = [
  // The files' and jars' lines, from their compressed variables, or as an earlier start gave them.
  readList('files', FILES_VARIABLES),
  readList('jars', JARS_VARIABLES),
  `placed=$(printf '%s\\n%s\\n' "$jars" "$files" | cut -d ' ' -f 1); unlinked ${PLACED_RECORD};`,
  `if [ -f ${PLACED_MARK} ]; then while read -r old; do case "$old" in ${UNPLACEABLE}) continue;; esac;`,
  `case " $(echo $placed) " in *" $old "*) ;; *) unlinked "$old"; rm -f "${DATA_DIR}/$old";; esac; done < ${PLACED_MARK}; fi;`,
  `printf '%s\\n' "$jars" | while read -r path sha url; do [ -n "$path" ] || continue; unlinked "$path"; f="${DATA_DIR}/$path";`,
  `if [ "$(sha512sum "$f" 2>/dev/null | cut -d ' ' -f 1)" != "$sha" ]; then mkdir -p "$(dirname "$f")" && rm -f "$f.part" &&`,
  `curl -fsSL --retry 3 --max-time 300 -o "$f.part" "$url" && [ "$(sha512sum "$f.part" | cut -d ' ' -f 1)" = "$sha" ] && mv -fT "$f.part" "$f"`,
  `|| { rm -f "$f.part"; echo "Cubepals could not fetch $path" >&2; exit 1; }; fi; done || exit 1;`,
  `printf '%s\\n' "$files" | while read -r path data; do [ -n "$path" ] || continue; unlinked "$path";`,
  `mkdir -p "$(dirname "${DATA_DIR}/$path")" && printf %s "$data" | base64 -d > "${DATA_DIR}/$path" || exit 1; done || exit 1;`,
  `printf '%s\\n' $placed > ${PLACED_MARK};`,
].join(' ')

/** Whether a revision places anything itself, and so starts with the step. */
export function placesFiles(revision: Pick<ServerRevision, 'files' | 'mods' | 'modpack'>): boolean {
  return revision.modpack === null && (revision.files.length > 0 || placedMods(revision.mods).length > 0)
}

/**
 * What Cubepals' own Via plugins are called on disk (`app/compat/`). Never a name the image gives
 * a jar it installs, which starts with the jar's sha512 (`diskName`): the same jar as a server's
 * own plugin before, the image would remove it as it cleans up after its own list, after this step
 * had placed it (seen 2026-10-16 with ViaVersion, taken off a server's own list for Cubepals').
 * The name is part of what a machine asleep wakes on (`servers/specs.ts`), so a new one boots once.
 */
export const COMPAT_PREFIX = 'cubepals-'
const compatName = (artifact: ModArtifact) => `${COMPAT_PREFIX}${diskName(artifact)}`

/**
 * The variables the step reads, each file as it reads on `levelName`, the world the server runs,
 * and with the Via plugins Cubepals places beside the revision's own (`compat`). With them, the
 * step runs though nothing is placed, so what an earlier start placed goes. Throws on a path
 * Cubepals may not write: every carried file and folder is Cubepals' own, so one is a mistake in a
 * template, never something to skip quietly.
 */
export function carriedEnv(
  revision: Pick<ServerRevision, 'files' | 'mods' | 'modpack'>,
  levelName: string,
  artifactUrl: (artifact: ModArtifact) => string,
  compat?: readonly PinnedMod[],
): Record<string, string> {
  if (compat === undefined && !placesFiles(revision)) return {}
  const jar = (mod: PinnedMod & { dir: string }, name: string) => ({
    path: `${mod.dir}/${name}`,
    sha512: mod.artifact.sha512,
    url: artifactUrl(mod.artifact),
  })
  const jars = [
    ...placedMods(revision.mods).map((mod) => jar(mod, diskName(mod.artifact))),
    ...placedMods(compat ?? []).map((mod) => jar(mod, compatName(mod.artifact))),
  ]
  // A path is judged as it is written, with the running world's name in it.
  const files = revision.files.map((file) => onLevel(file, levelName))
  const wrong = [...jars, ...files]
    .filter((entry) => !placeablePath(entry.path) || ('url' in entry && /\s/.test(entry.url)))
    .map((entry) => entry.path)
  if (wrong.length > 0) throw new Error(`Cubepals can't place ${wrong.join(', ')} on a server.`)
  return {
    [JARS_VARIABLES.plain]: jars.map((jar) => `${jar.path} ${jar.sha512} ${jar.url}`).join('\n'),
    [FILES_VARIABLES.plain]: files
      .map(
        (file) =>
          `${file.path} ${file.encoding === 'base64' ? file.content : Buffer.from(file.content, 'utf8').toString('base64')}`,
      )
      .join('\n'),
  }
}
