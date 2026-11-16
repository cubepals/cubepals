// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a player's game has to match to play a server, as its routes carry it: the pack it plays,
 * or its mods with the versions it runs. The edge tells it to a player whose game left as it
 * joined (`apps/edge/left-at-once.ts`), which is what a game does with a mod older or newer than
 * the server's. The mods the server's last change of mods moved come first, with when that was:
 * a game that played before it has those to update. Which mods a game can carry, and in what order
 * after those, is `inPlayersGames`, the rule the server's page lists them by
 * (`sharing/queries.ts`): every jar, whatever its authors say it asks of players; never a plugin or
 * a datapack, so a server that runs only those asks nothing.
 *
 * Not for which games the server takes (`clients.ts`).
 */
import type { EdgeRoute } from '@blockly/contracts/edge'
import { type PinnedMod, runsPlugins } from '../../domain/mods/artifact.ts'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import type { Loader } from '../../domain/revision/revision.ts'
import { CARRIED_FIRST, inPlayersGames } from '../../minecraft/mods.ts'

/**
 * Of one of a server's revisions, what its players' games have to match: each pin's name, version
 * and the exact file it is (a catalog's version, or an upload), cut to a few characters each as
 * they are read (`inputs.ts`), so no owner's names can make a read of the routes large.
 */
export interface RevisionMods {
  loader: Loader
  mods: (Pick<PinnedMod, 'name' | 'versionLabel' | 'environment' | 'loaders'> & { file: string })[]
  modpack: Pick<PinnedModpack, 'name' | 'versionLabel' | 'versionId' | 'environment'> | null
  createdAt: Date
}

/** The most a route lists: the edge shows these and says how many more. */
export const MOST_LISTED = 8

const fileOf = (mod: { file: string }): string => mod.file

/** Of `revision`, what goes in a player's game: its pack, or the jars it loads; null for neither. */
function carried(revision: RevisionMods): { pack: string } | { jars: RevisionMods['mods'] } | null {
  if (runsPlugins(revision.loader)) return null
  if (revision.modpack !== null)
    return revision.modpack.environment === 'server' ? null : { pack: revision.modpack.versionId }
  const jars = inPlayersGames(revision.mods, revision.loader)
  return jars.length === 0 ? null : { jars }
}

/** The files of what goes in a player's game, to tell one change of them from another. */
function filesOf(revision: RevisionMods): Set<string> {
  const what = carried(revision)
  if (what === null) return new Set()
  return 'pack' in what ? new Set([`pack:${what.pack}`]) : new Set(what.jars.map(fileOf))
}

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((file) => b.has(file))

/**
 * What a player's game has to match to play `history[0]`, the revision a route goes by, from it
 * and the server's revisions before it, newest first: the last change of what goes in a game is
 * the newest revision that differs from the one after it. Undefined where players need nothing.
 */
export function playersMods(history: readonly RevisionMods[]): EdgeRoute['mods'] {
  const [now, ...before] = history
  const what = now === undefined ? null : carried(now)
  if (now === undefined || what === null) return undefined
  const files = filesOf(now)
  let since = now
  let previous: Set<string> | null = null
  for (const revision of before) {
    const theirs = filesOf(revision)
    if (!same(theirs, files)) {
      previous = theirs
      break
    }
    since = revision
  }
  const changedAt = previous === null ? {} : { changedAt: since.createdAt.toISOString() }
  const moved = (file: string) => previous !== null && !previous.has(file)
  if ('pack' in what) {
    const pack = now.modpack
    if (pack === null) return undefined
    const changed = moved(`pack:${what.pack}`) ? { changed: true as const } : {}
    return { list: [{ name: pack.name, version: pack.versionLabel, ...changed }], ...changedAt, pack: true }
  }
  const rank = (mod: RevisionMods['mods'][number]) =>
    moved(fileOf(mod)) ? -1 : CARRIED_FIRST.indexOf(mod.environment)
  const ordered = [...what.jars].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  )
  const list = ordered.slice(0, MOST_LISTED).map((mod) => ({
    name: mod.name,
    version: mod.versionLabel,
    ...(moved(fileOf(mod)) ? { changed: true as const } : {}),
  }))
  const more = ordered.length - list.length
  return { list, ...(more > 0 ? { more } : {}), ...changedAt }
}
