/**
 * A mod catalog (Modrinth, and Hangar beside it through `catalog/routed.ts`), seen only as far as Blockly uses one: search while authoring, exact
 * versions for resolution, and bulk states for the trust cache (docs/architecture.md §15.3).
 * Which loaders and kinds of project a server accepts is Minecraft knowledge; it arrives here as
 * plain strings. The data it returns is the domain's (`domain/mods/catalog.ts`), which resolution
 * works on.
 */
import type {
  CatalogHit,
  CatalogProject,
  CatalogSearch,
  CatalogStates,
  CatalogTarget,
  CatalogVersion,
} from '../../domain/mods/catalog.ts'

export {
  type CatalogHit,
  type CatalogProject,
  type CatalogSearch,
  type CatalogStates,
  type CatalogTarget,
  type CatalogVersion,
  MOD_ENVIRONMENTS,
  type ModEnvironment,
  type ProjectState,
  type VersionState,
} from '../../domain/mods/catalog.ts'

/** A published file found by its bytes: the version it belongs to, and that file of it. */
export interface CatalogFileMatch {
  version: CatalogVersion
  file: { url: string; sha1: string; sha512: string; sizeBytes: number; fileName: string }
}

/** What a link someone pasted points at on a catalog: a project, and a version where it names one. */
export interface CatalogLink {
  kind: 'modpack' | 'mod' | 'plugin' | 'other'
  /** The project's id or slug, as the link has it. */
  project: string
  /** The version's id or its number, as the link has it; null when the link names none. */
  version: string | null
}

export interface PackLinks {
  page: string
  file: string
  app: string | null
}

export interface ModCatalog {
  /** Stored as a mod source's catalog. */
  readonly id: string
  /**
   * Every catalog it answers for, its own first, where it answers for others too by the name
   * their ids carry (`catalogOfId`).
   */
  readonly ids?: readonly string[]
  /** Where people read about a project, on the catalog's own site. */
  projectPage(projectId: string): string
  /**
   * How a player gets one exact version of a pack from the catalog itself: that version's page,
   * its file, carrying what the catalog asks a download it didn't start to say about itself, and
   * a link that installs it in the catalog's own launcher, where it has one.
   */
  packLinks(
    pack: { projectId: string; versionId: string; file: string },
    target: { gameVersion: string; loader: string },
  ): PackLinks
  search(search: CatalogSearch): Promise<{ hits: CatalogHit[]; total: number }>
  /** By id or slug; null when the catalog doesn't show it. */
  project(idOrSlug: string): Promise<CatalogProject | null>
  /** The project's versions that fit the target, newest first. */
  versions(projectId: string, target: CatalogTarget): Promise<CatalogVersion[]>
  version(versionId: string): Promise<CatalogVersion | null>
  /** Many versions by id at once; ids the catalog doesn't show are left out. */
  versionsByIds(versionIds: readonly string[]): Promise<ReadonlyMap<string, CatalogVersion>>
  /** Many states at once. Every id asked about is answered; ids the catalog leaves out are absent. */
  states(ids: { projects: readonly string[]; versions: readonly string[] }): Promise<CatalogStates>
  /**
   * Modpacks by name. Nothing narrows them: a pack brings its own Minecraft version and its own
   * loader, so which ones Blockly can run is decided from the versions, not asked of the catalog.
   */
  searchModpacks(search: { text: string; offset: number; limit: number }): Promise<{
    hits: CatalogHit[]
    total: number
  }>
  /** A modpack's versions, newest first, each saying what it runs on. */
  modpackVersions(projectId: string): Promise<CatalogVersion[]>
  /**
   * Files by their sha512: the ones this catalog publishes, each with its version, which says
   * where it runs (docs/modpack-system.md § Sides). Files it doesn't publish are left out.
   */
  filesByHash(sha512s: readonly string[]): Promise<ReadonlyMap<string, CatalogFileMatch>>
  /**
   * Many projects' names and declared licences at once, for reviewing a curated pack
   * (docs/modpack-templates.md § Licences). Projects the catalog doesn't show are left out.
   */
  licences(
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, { name: string; licence: string | null }>>
  /** What a link points at on this catalog, or null when it isn't one of this catalog's. */
  linkOf(url: string): CatalogLink | null
  /**
   * Whether a pack may download a file from `url`, by the rule this catalog holds its own packs
   * to. An uploaded pack never passed the catalog's checks, so it is held to the same rule.
   */
  packDownloadAllowed(url: string): boolean
}

/** The catalog couldn't answer. Authoring stops with nothing written; refreshes keep what they know. */
export class CatalogUnavailable extends Error {
  /** The catalog's name, as players know it. */
  readonly catalog: string

  constructor(detail: string, catalog = 'Modrinth') {
    super(`The mod catalog is unavailable: ${detail}`)
    this.catalog = catalog
    this.name = 'CatalogUnavailable'
  }
}
