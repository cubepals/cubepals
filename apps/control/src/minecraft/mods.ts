// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { DATAPACK, isDatapack, type PinnedMod } from '../domain/mods/artifact.ts'
import type { Loader } from '../domain/revision/revision.ts'

/**
 * Which catalog versions a server can run: Minecraft knowledge the catalog port receives as plain
 * strings (docs/architecture.md §7, §15.5).
 */

/**
 * The catalog loader tags a server type loads jars for. Quilt loads Fabric mods, not the other way
 * round; Paper runs plugins written for Bukkit and Spigot.
 */
const JAR_LOADERS: Record<Loader, readonly string[]> = {
  vanilla: [],
  fabric: ['fabric'],
  quilt: ['quilt', 'fabric'],
  neoforge: ['neoforge'],
  forge: ['forge'],
  paper: ['paper', 'spigot', 'bukkit'],
}

/** The catalog loader tags a server type runs: its jars', and datapacks, which every one reads. */
export const catalogLoadersFor = (loader: Loader): readonly string[] => [...JAR_LOADERS[loader], DATAPACK]

/** Whether a pin goes into the world's `datapacks` folder on this server type, not among its jars. */
export const installsAsDatapack = (mod: { loaders: readonly string[] }, loader: Loader): boolean =>
  isDatapack(mod, JAR_LOADERS[loader])

/**
 * The server type a modpack needs, from the loader it declares. A pack names exactly one, and
 * only the mod loaders publish packs: a Paper server runs plugins, not a pack.
 */
export function loaderOfPack(tags: readonly string[]): Loader | null {
  const packLoaders: readonly Loader[] = ['fabric', 'quilt', 'neoforge', 'forge']
  return packLoaders.find((loader) => tags.includes(loader)) ?? null
}

/**
 * Mods for a mod loader, plugins for Paper, then datapacks for every server type: plain Minecraft
 * runs only those.
 */
export function projectTypesFor(loader: Loader): readonly ('mod' | 'plugin' | 'datapack')[] {
  if (loader === 'vanilla') return [DATAPACK]
  return [loader === 'paper' ? 'plugin' : 'mod', DATAPACK]
}

/**
 * Whether a version runs on a dedicated server, from the environment its authors declare, and
 * what it asks of players, in Modrinth's own terms: `server` when
 * plain Minecraft gets all of it, `both` when a player's game must have it to join, `optional`
 * when it runs without them and only adds to a player's game that has it too (voice chat to
 * talk, a minimap, Lithium's own speed-ups). Null for what only runs in a player's game or a
 * single-player world. `unknown` is what versions from before environments say; most of those
 * are mods both sides load, so they are treated as such rather than refused.
 */
export function serverEnvironment(environment: string): 'server' | 'optional' | 'both' | null {
  switch (environment) {
    case 'server_only':
    case 'dedicated_server_only':
    case 'client_or_server':
      return 'server'
    case 'server_only_client_optional':
    case 'client_or_server_prefers_both':
    case 'client_only_server_optional':
      return 'optional'
    case 'client_and_server':
    case 'unknown':
      return 'both'
    default:
      return null
  }
}

/** Fabric API, by its id in each catalog. */
const FABRIC_API: Readonly<Record<string, string>> = { modrinth: 'P7dR8mSH' }

/**
 * Where the mods a Fabric mod's own metadata requires come from on a Fabric server: every
 * `fabric-…` module, such as `fabric-api-base`, comes in Fabric API, which Modrinth often doesn't
 * list as a dependency at all. Fabric Loader and Fabric's language adapters are their own projects.
 * Undefined for any other server type: Quilt answers Fabric's modules with its own.
 */
export function fabricModProvider(
  loader: Loader,
  catalog: string,
): ((modId: string) => string | null) | undefined {
  if (loader !== 'fabric') return undefined
  const api = FABRIC_API[catalog] ?? null
  return (modId) =>
    modId === 'fabric' ||
    (modId.startsWith('fabric-') && modId !== 'fabric-loader' && !modId.startsWith('fabric-language-'))
      ? api
      : null
}

/**
 * ViaVersion on Modrinth (GPL-3.0-or-later): a Paper plugin that lets players on newer Minecraft
 * join a server on an older release. Its builds run on every release Cubepals offers Paper on.
 */
export const VIAVERSION = 'P1OZGk5p'
/** ViaBackwards on Modrinth (GPL-3.0-only): ViaVersion's addon for players on older Minecraft. */
export const VIABACKWARDS = 'NpvuJQoq'
/** ViaRewind on Modrinth (GPL-3.0-or-later): ViaBackwards' addon for players on 1.8 and 1.7. */
export const VIAREWIND = 'TbHIxhx5'

/** The Via plugins' names, by their Modrinth projects: the same plugin from Hangar or an upload. */
const VIA_NAMES: Readonly<Record<string, string>> = {
  [VIAVERSION]: 'viaversion',
  [VIABACKWARDS]: 'viabackwards',
  [VIAREWIND]: 'viarewind',
}

/** Whether `mods` hold the Via plugin that is Modrinth's `projectId`, from wherever it came. */
export const runsPlugin = (mods: readonly PinnedMod[], projectId: string): boolean =>
  mods.some(
    (mod) =>
      ('projectId' in mod.source && mod.source.projectId === projectId) ||
      mod.name.toLowerCase() === VIA_NAMES[projectId],
  )

/** Whether a server's plugins let players on newer Minecraft than it runs join it. */
export const joinsNewer = (mods: readonly PinnedMod[]): boolean => runsPlugin(mods, VIAVERSION)
