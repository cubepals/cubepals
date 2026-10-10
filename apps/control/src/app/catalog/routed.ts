// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Modrinth and the catalogs beside it as one ModCatalog, so resolution, the trust cache and
 * every service keep asking one catalog. A question about an id goes to the catalog the id names
 * (`catalogOfId`): `hangar:2087` to Hangar, a bare id to Modrinth. Modpacks are Modrinth's alone.
 * Search stays Modrinth's: a second catalog's plugins arrive through templates, not the search box.
 */
import { catalogOfId } from '../../domain/mods/catalog.ts'
import type {
  CatalogFileMatch,
  CatalogHit,
  CatalogLink,
  CatalogProject,
  CatalogSearch,
  CatalogStates,
  CatalogTarget,
  CatalogVersion,
  ModCatalog,
  PackLinks,
} from '../ports/catalog.ts'

export class RoutedCatalog implements ModCatalog {
  readonly #primary: ModCatalog
  readonly #others: ReadonlyMap<string, ModCatalog>

  constructor(primary: ModCatalog, others: readonly ModCatalog[]) {
    this.#primary = primary
    this.#others = new Map(others.map((catalog) => [catalog.id, catalog]))
  }

  get id(): string {
    return this.#primary.id
  }

  /** Every catalog asked, the primary first: the trust cache keeps each one's states apart. */
  get ids(): string[] {
    return [this.#primary.id, ...this.#others.keys()]
  }

  #of(id: string): ModCatalog {
    return this.#others.get(catalogOfId(id, this.#primary.id)) ?? this.#primary
  }

  /** Ids grouped by the catalog that answers for them. */
  #split(ids: readonly string[]): Map<ModCatalog, string[]> {
    const split = new Map<ModCatalog, string[]>()
    for (const id of ids) split.set(this.#of(id), [...(split.get(this.#of(id)) ?? []), id])
    return split
  }

  projectPage(projectId: string): string {
    return this.#of(projectId).projectPage(projectId)
  }

  packLinks(
    pack: { projectId: string; versionId: string; file: string },
    target: { gameVersion: string; loader: string },
  ): PackLinks {
    return this.#primary.packLinks(pack, target)
  }

  search(search: CatalogSearch): Promise<{ hits: CatalogHit[]; total: number }> {
    return this.#primary.search(search)
  }

  project(idOrSlug: string): Promise<CatalogProject | null> {
    return this.#of(idOrSlug).project(idOrSlug)
  }

  versions(projectId: string, target: CatalogTarget): Promise<CatalogVersion[]> {
    return this.#of(projectId).versions(projectId, target)
  }

  version(versionId: string): Promise<CatalogVersion | null> {
    return this.#of(versionId).version(versionId)
  }

  async versionsByIds(versionIds: readonly string[]): Promise<ReadonlyMap<string, CatalogVersion>> {
    const found = await Promise.all(
      [...this.#split(versionIds)].map(([catalog, ids]) => catalog.versionsByIds(ids)),
    )
    return new Map(found.flatMap((versions) => [...versions]))
  }

  async states(ids: { projects: readonly string[]; versions: readonly string[] }): Promise<CatalogStates> {
    const projects = this.#split(ids.projects)
    const versions = this.#split(ids.versions)
    const catalogs = new Set([...projects.keys(), ...versions.keys()])
    const answers = await Promise.all(
      [...catalogs].map((catalog) =>
        catalog.states({ projects: projects.get(catalog) ?? [], versions: versions.get(catalog) ?? [] }),
      ),
    )
    return {
      projects: new Map(answers.flatMap((answer) => [...answer.projects])),
      versions: new Map(answers.flatMap((answer) => [...answer.versions])),
    }
  }

  searchModpacks(search: { text: string; offset: number; limit: number }): Promise<{
    hits: CatalogHit[]
    total: number
  }> {
    return this.#primary.searchModpacks(search)
  }

  modpackVersions(projectId: string): Promise<CatalogVersion[]> {
    return this.#primary.modpackVersions(projectId)
  }

  /** By SHA-512, which only Modrinth looks files up by. */
  filesByHash(sha512s: readonly string[]): Promise<ReadonlyMap<string, CatalogFileMatch>> {
    return this.#primary.filesByHash(sha512s)
  }

  async licences(
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, { name: string; licence: string | null }>> {
    const found = await Promise.all(
      [...this.#split(projectIds)].map(([catalog, ids]) => catalog.licences(ids)),
    )
    return new Map(found.flatMap((licences) => [...licences]))
  }

  linkOf(url: string): CatalogLink | null {
    for (const catalog of [this.#primary, ...this.#others.values()]) {
      const link = catalog.linkOf(url)
      if (link !== null) return link
    }
    return null
  }

  packDownloadAllowed(url: string): boolean {
    return this.#primary.packDownloadAllowed(url)
  }
}
