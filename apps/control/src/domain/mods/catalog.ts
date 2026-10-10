// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a mod catalog says about projects and versions, neutral to which catalog it is
 * (docs/architecture.md §15.5). Resolution works on these; the catalog port returns them.
 */

/**
 * Which catalog an id belongs to. Modrinth's ids are bare; a second catalog's carry its name
 * before them (`hangar:2087`), so one set of mods can hold both and every id still says where it
 * came from. Modrinth's ids and slugs never hold a colon.
 */
export function catalogOfId(id: string, primary: string): string {
  const at = id.indexOf(':')
  return at > 0 ? id.slice(0, at) : primary
}

export type ProjectState = 'approved' | 'archived' | 'unlisted' | 'withheld' | 'absent'
export type VersionState = 'listed' | 'archived' | 'unlisted' | 'absent'

/**
 * Where a version runs, as its authors declare it. Modrinth's vocabulary, which replaced its
 * separate client and server sides; what it means for a server is decided in `minecraft/`.
 */
export const MOD_ENVIRONMENTS = [
  'client_and_server',
  'client_only',
  'client_only_server_optional',
  'singleplayer_only',
  'server_only',
  'server_only_client_optional',
  'dedicated_server_only',
  'client_or_server',
  'client_or_server_prefers_both',
  'unknown',
] as const
export type ModEnvironment = (typeof MOD_ENVIRONMENTS)[number]

/** What fits one server. */
export interface CatalogTarget {
  loaders: readonly string[]
  gameVersion: string
}

export interface CatalogSearch {
  text: string
  target: CatalogTarget
  /** Mods for a modded server, plugins for a plugin server. */
  projectTypes: readonly string[]
  offset: number
  limit: number
}

export interface CatalogHit {
  projectId: string
  slug: string
  name: string
  summary: string
  iconUrl: string | null
  /** Across the project's versions. */
  environments: ModEnvironment[]
  downloads: number
  /**
   * The catalogue's own tags. What they mean is the catalogue's business; what Blockly reads out
   * of them is in `minecraft/packs.ts`. Absent where a catalogue has none.
   */
  categories?: readonly string[]
  /** The Minecraft releases it supports, where a catalogue says so with the rest of the listing. */
  gameVersions?: readonly string[]
}

export interface CatalogProject extends CatalogHit {
  state: ProjectState
  /**
   * The licence its publisher declares, as an SPDX identifier or expression, where the catalog says
   * (docs/modpack-templates.md § Licences); null when it declares none.
   */
  licence?: string | null
}

export interface CatalogFile {
  /** Permanent and public. */
  url: string
  sha512: string
  sizeBytes: number
  fileName: string
}

export interface CatalogDependency {
  /** Either can be missing: a dependency may name a project, a version, or both. */
  projectId: string | null
  versionId: string | null
  kind: 'required' | 'optional' | 'incompatible' | 'embedded'
}

export interface CatalogVersion {
  versionId: string
  projectId: string
  versionLabel: string
  channel: 'release' | 'beta' | 'alpha'
  state: VersionState
  environment: ModEnvironment
  loaders: string[]
  gameVersions: string[]
  publishedAt: Date
  file: CatalogFile
  dependencies: CatalogDependency[]
}

export interface CatalogStates {
  projects: ReadonlyMap<string, ProjectState>
  versions: ReadonlyMap<string, VersionState>
}
