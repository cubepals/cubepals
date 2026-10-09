import { DATAPACK, isDatapack } from '../domain/mods/artifact.ts'
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
 * what it asks of players, in Modrinth's own terms (docs/research/mod-sides.md): `server` when
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
