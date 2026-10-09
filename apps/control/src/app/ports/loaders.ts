/**
 * Where each server type publishes its builds (§4: a revision pins its loader build, so it boots
 * the same way every time rather than on whatever is newest that day). Vanilla has no build of
 * its own; the others are named here as plain data.
 */
const BUILT_LOADERS = ['paper', 'fabric', 'quilt', 'neoforge', 'forge'] as const
export type BuiltLoader = (typeof BUILT_LOADERS)[number]

export interface LoaderBuilds {
  /**
   * The build a new revision pins for this game version: the newest the server type calls
   * stable (Forge's recommended one), or null when it has published none for that version.
   */
  current(loader: BuiltLoader, gameVersion: string): Promise<string | null>
}

/** A server type's build list couldn't be read, so nothing could be pinned. */
export class LoaderBuildsUnavailable extends Error {
  constructor(loader: BuiltLoader, cause: string) {
    super(`${loader} build list unavailable: ${cause}`)
    this.name = 'LoaderBuildsUnavailable'
  }
}
