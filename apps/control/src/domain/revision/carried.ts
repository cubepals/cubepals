import type { PinnedMod } from '../mods/artifact.ts'

/**
 * What a revision puts on the server's disk itself, beside what the image installs: files Cubepals
 * wrote, carried the way a pack carries its `overrides/` (docs/modpack-system.md § Carried files),
 * and plugins whose jar goes in a folder of its own rather than the image's plugins folder.
 *
 * Only Cubepals writes these. Nothing here comes from an owner, and nothing here is a secret.
 */

/** A file Cubepals wrote, at its path under the server's directory, as UTF-8 text. */
export interface CarriedFile {
  /** Relative to the server's directory: `plugins/LifeStealZ/config.yml`. */
  path: string
  content: string
}

/**
 * Whether a path is one Cubepals may write: relative, plain, and none of the files Blockly
 * already keeps itself (`server.properties`, the access lists, its own `.blockly-` marks). Its
 * names hold letters, digits, `.`, `_`, `+` and `-` only, so a start step can say it without quoting.
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

/**
 * The plugins of a revision whose jar goes elsewhere than the plugins folder, by where each goes.
 * A BentoBox game mode is one: BentoBox loads it from `plugins/BentoBox/addons`.
 */
export const placedMods = <T extends Pick<PinnedMod, 'dir'>>(
  mods: readonly T[],
): Array<T & { dir: string }> => mods.filter((mod): mod is T & { dir: string } => mod.dir !== undefined)

/** The carried files that differ between two revisions, each named for the person reading. */
export function filesChanged(
  from: readonly CarriedFile[],
  to: readonly CarriedFile[],
): { added: string[]; removed: string[]; changed: string[] } {
  const before = new Map(from.map((file) => [file.path, file.content]))
  const after = new Map(to.map((file) => [file.path, file.content]))
  return {
    added: [...after.keys()].filter((path) => !before.has(path)).map(fileLabel),
    removed: [...before.keys()].filter((path) => !after.has(path)).map(fileLabel),
    changed: [...after]
      .filter(([path, content]) => before.has(path) && before.get(path) !== content)
      .map(([path]) => fileLabel(path)),
  }
}

/**
 * A carried file in a person's words: a plugin's settings by the plugin's name, which is the
 * folder it keeps them in, and any other file by its own name.
 */
export function fileLabel(path: string): string {
  const [top, folder, ...rest] = path.split('/')
  if (top === 'plugins' && folder !== undefined && rest.length > 0) return `${folder} settings`
  return path.split('/').at(-1) ?? path
}

/**
 * Whether two revisions put different things on the disk themselves: another carried file, or
 * another plugin in a folder of its own. Such a change is installed like a new pack, with the
 * snapshot back if it doesn't come up, since what a plugin made of the old files is in the world.
 */
export function movesCarried(
  from: { files?: readonly CarriedFile[]; mods?: readonly PinnedMod[] },
  to: { files?: readonly CarriedFile[]; mods?: readonly PinnedMod[] },
): boolean {
  const files = filesChanged(from.files ?? [], to.files ?? [])
  if (files.added.length + files.removed.length + files.changed.length > 0) return true
  const placed = (mods: readonly PinnedMod[] | undefined) =>
    placedMods(mods ?? [])
      .map((mod) => `${mod.dir}/${mod.artifact.sha512}`)
      .sort()
      .join()
  return placed(from.mods) !== placed(to.mods)
}
