/**
 * Durable references only. A revision must be reproducible months later, so nothing that
 * expires (a presigned URL) is ever part of it.
 */
type ArtifactRef =
  /** A permanent public URL issued by a catalog. */
  | { kind: 'remote'; url: string }
  /** A content-addressed object in the archive store. */
  | { kind: 'stored'; key: string }

export interface ModArtifact {
  ref: ArtifactRef
  /** The identity of the bytes. */
  sha512: string
  sizeBytes: number
  /** As published. */
  fileName: string
}

type ModSource =
  | { catalog: string; projectId: string; versionId: string }
  | { catalog: 'upload'; uploadId: string }

/** Frozen facts about a mod at resolution time. Catalog status and trust are not here. */
export interface PinnedMod {
  source: ModSource
  name: string
  versionLabel: string
  artifact: ModArtifact
  /**
   * What it asks of players: nothing (`server`), to be in their game too to join (`both`), or
   * nothing needed but more when their game has it too (`optional`), as its authors declare.
   */
  environment: 'server' | 'optional' | 'both'
  loaders: string[]
  gameVersions: string[]
  origin: 'user' | 'dependency'
  requiredBy: string[]
  /**
   * The folder its jar goes in, under the server's directory, where that isn't the loader's own:
   * `plugins/BentoBox/addons` for a BentoBox game mode. Absent for every other mod.
   */
  dir?: string
}

/**
 * The loader tag a catalog gives a datapack. A datapack runs inside a world, on every server type
 * alike, so no loader loads it and it is never a reason to install one.
 */
export const DATAPACK = 'datapack'

/**
 * Whether a pin goes into the world as a datapack rather than among the server's mods or plugins:
 * it is one, and the server loads none of its loaders as a jar (`jarLoaders`, none for plain
 * Minecraft). A version published for both runs as the mod where the server can load it.
 */
export const isDatapack = (
  mod: { loaders: readonly string[] },
  jarLoaders: readonly string[] = [],
): boolean => mod.loaders.includes(DATAPACK) && !mod.loaders.some((loader) => jarLoaders.includes(loader))

/**
 * The mods players install to play on a server. Plain Minecraft joins unless one of them has to
 * be in a player's game too; then everyone installs the loader anyway, and the ones that only add
 * to a game that has them — voice chat to talk, a minimap — come along. A mod players can do
 * without is never the reason to install a loader.
 */
export function forPlayers<T extends Pick<PinnedMod, 'environment'>>(mods: readonly T[]): T[] {
  if (!mods.some((mod) => mod.environment === 'both')) return []
  return mods.filter((mod) => mod.environment !== 'server')
}
