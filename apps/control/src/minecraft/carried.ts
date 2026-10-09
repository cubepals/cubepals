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

import type { ModArtifact } from '../domain/mods/artifact.ts'
import { onLevel, placedMods } from '../domain/revision/carried.ts'
import type { ServerRevision } from '../domain/revision/revision.ts'
import { DATA_DIR, diskName } from './jars.ts'

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
const PLACED_MARK = `${DATA_DIR}/.blockly-files`

/** Each placed jar on one line: its path, its sha512 and its link. */
const JARS_VARIABLE = 'BLOCKLY_JARS'
/** Each carried file on one line: its path and its bytes in base64. */
const FILES_VARIABLE = 'BLOCKLY_FILES'

/**
 * The step. Names hold no spaces or quotes (`placeablePath`), so the shell splits lines on spaces.
 * What the last start wrote and this revision doesn't is removed; a placed jar already holding
 * its bytes is kept, and any other is fetched and checked against its sha512 before it is moved
 * into place, or the start stops with what it couldn't fetch. Then every carried file is written.
 */
export const CARRIED_STEP = [
  `placed=$(printf '%s\\n%s\\n' "$${JARS_VARIABLE}" "$${FILES_VARIABLE}" | cut -d ' ' -f 1);`,
  `for old in $(cat ${PLACED_MARK} 2>/dev/null); do case " $(echo $placed) " in *" $old "*) ;; *) rm -f "${DATA_DIR}/$old";; esac; done;`,
  `printf '%s\\n' "$${JARS_VARIABLE}" | while read -r path sha url; do [ -n "$path" ] || continue; f="${DATA_DIR}/$path";`,
  `if [ "$(sha512sum "$f" 2>/dev/null | cut -d ' ' -f 1)" != "$sha" ]; then mkdir -p "$(dirname "$f")" &&`,
  `curl -fsSL --retry 3 --max-time 300 -o "$f.part" "$url" && [ "$(sha512sum "$f.part" | cut -d ' ' -f 1)" = "$sha" ] && mv "$f.part" "$f"`,
  `|| { rm -f "$f.part"; echo "Cubepals could not fetch $path" >&2; exit 1; }; fi; done || exit 1;`,
  `printf '%s\\n' "$${FILES_VARIABLE}" | while read -r path data; do [ -n "$path" ] || continue;`,
  `mkdir -p "$(dirname "${DATA_DIR}/$path")" && printf %s "$data" | base64 -d > "${DATA_DIR}/$path" || exit 1; done || exit 1;`,
  `printf '%s\\n' $placed > ${PLACED_MARK};`,
].join(' ')

/** Whether a revision places anything itself, and so starts with the step. */
export function placesFiles(revision: Pick<ServerRevision, 'files' | 'mods' | 'modpack'>): boolean {
  return revision.modpack === null && (revision.files.length > 0 || placedMods(revision.mods).length > 0)
}

/**
 * The variables the step reads, each file as it reads on `levelName`, the world the server runs.
 * Throws on a path Cubepals may not write: every carried file and folder is Cubepals' own, so one
 * is a mistake in a template, never something to skip quietly.
 */
export function carriedEnv(
  revision: Pick<ServerRevision, 'files' | 'mods' | 'modpack'>,
  levelName: string,
  artifactUrl: (artifact: ModArtifact) => string,
): Record<string, string> {
  if (!placesFiles(revision)) return {}
  const jars = placedMods(revision.mods).map((mod) => ({
    path: `${mod.dir}/${diskName(mod.artifact)}`,
    sha512: mod.artifact.sha512,
    url: artifactUrl(mod.artifact),
  }))
  const wrong = [...jars, ...revision.files]
    .filter((entry) => !placeablePath(entry.path) || ('url' in entry && /\s/.test(entry.url)))
    .map((entry) => entry.path)
  if (wrong.length > 0) throw new Error(`Cubepals can't place ${wrong.join(', ')} on a server.`)
  return {
    [JARS_VARIABLE]: jars.map((jar) => `${jar.path} ${jar.sha512} ${jar.url}`).join('\n'),
    [FILES_VARIABLE]: revision.files
      .map((file) => onLevel(file, levelName))
      .map((file) => `${file.path} ${Buffer.from(file.content, 'utf8').toString('base64')}`)
      .join('\n'),
  }
}
