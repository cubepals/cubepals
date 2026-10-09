import {
  type CatalogFileMatch,
  type CatalogHit,
  type CatalogLink,
  type CatalogProject,
  type CatalogSearch,
  type CatalogStates,
  type CatalogTarget,
  CatalogUnavailable,
  type CatalogVersion,
  type ModCatalog,
  type PackLinks,
  type ProjectState,
  type VersionState,
} from '../../app/ports/catalog.ts'

/**
 * A catalog in memory, for tests and local runs without Modrinth. It answers the way the port
 * says Modrinth does (docs/dependency-audit.md): what it won't show is missing, not an error;
 * bulk states answer every id and call the missing ones absent; versions come newest first.
 */
export class FakeCatalog implements ModCatalog {
  readonly id = 'modrinth'

  projectPage(projectId: string): string {
    return `https://catalog.test/project/${projectId}`
  }

  packLinks(pack: { projectId: string; versionId: string; file: string }): PackLinks {
    return {
      page: `https://catalog.test/project/${pack.projectId}/version/${pack.versionId}`,
      file: pack.file,
      app: `catalog-app://version/${pack.versionId}`,
    }
  }
  readonly #projects = new Map<string, CatalogProject>()
  readonly #versions = new Map<string, CatalogVersion>()
  readonly #packs = new Set<string>()
  /** sha512 → sha1 of files published with one given; others get a made-up sha1. */
  readonly #sha1 = new Map<string, string>()
  /** Hosts a pack may download from; null: any. */
  #downloadHosts: ReadonlySet<string> | null = null
  #down = false

  /** A file's sha1, for a test that checks what a built pack lists. */
  fileSha1(sha512: string, sha1: string): void {
    this.#sha1.set(sha512, sha1)
  }

  /** Holds packs to downloads from these hosts only, as Modrinth's format does. */
  allowDownloadsFrom(hosts: readonly string[] | null): void {
    this.#downloadHosts = hosts === null ? null : new Set(hosts)
  }

  publish(
    project: Omit<CatalogProject, 'state'> & { state?: ProjectState },
    versions: CatalogVersion[],
  ): void {
    this.#projects.set(project.projectId, { ...project, state: project.state ?? 'approved' })
    for (const version of versions) this.#versions.set(version.versionId, version)
  }

  /** The same, for a whole modpack: what the pack search answers with. */
  publishModpack(
    project: Omit<CatalogProject, 'state'> & { state?: ProjectState },
    versions: CatalogVersion[],
  ): void {
    this.publish(project, versions)
    this.#packs.add(project.projectId)
  }

  /** A moderator's decision, an author's clean-up: the catalog shows it differently from now on. */
  setProjectState(projectId: string, state: ProjectState): void {
    const project = this.#projects.get(projectId)
    if (project) this.#projects.set(projectId, { ...project, state })
  }

  setVersionState(versionId: string, state: VersionState): void {
    const version = this.#versions.get(versionId)
    if (version) this.#versions.set(versionId, { ...version, state })
  }

  /** Every call fails as Modrinth being unreachable would. */
  outage(down: boolean): void {
    this.#down = down
  }

  async search(search: CatalogSearch): Promise<{ hits: CatalogHit[]; total: number }> {
    this.#up()
    const text = search.text.toLowerCase()
    const hits = [...this.#projects.values()].filter(
      (p) =>
        this.#shown(p) &&
        (p.name.toLowerCase().includes(text) || p.slug.includes(text)) &&
        this.#fitting(p.projectId, search.target).length > 0,
    )
    return {
      total: hits.length,
      hits: hits.slice(search.offset, search.offset + search.limit).map(({ state: _state, ...hit }) => hit),
    }
  }

  async project(idOrSlug: string): Promise<CatalogProject | null> {
    this.#up()
    const project =
      this.#projects.get(idOrSlug) ?? [...this.#projects.values()].find((p) => p.slug === idOrSlug)
    return project && this.#shown(project) ? project : null
  }

  async versions(projectId: string, target: CatalogTarget): Promise<CatalogVersion[]> {
    this.#up()
    return this.#fitting(projectId, target)
  }

  async version(versionId: string): Promise<CatalogVersion | null> {
    this.#up()
    const version = this.#versions.get(versionId)
    return version && version.state !== 'absent' ? version : null
  }

  async versionsByIds(versionIds: readonly string[]): Promise<ReadonlyMap<string, CatalogVersion>> {
    this.#up()
    const found = new Map<string, CatalogVersion>()
    for (const id of versionIds) {
      const version = this.#versions.get(id)
      if (version && version.state !== 'absent') found.set(id, version)
    }
    return found
  }

  async searchModpacks(search: { text: string; offset: number; limit: number }): Promise<{
    hits: CatalogHit[]
    total: number
  }> {
    this.#up()
    const text = search.text.toLowerCase()
    const hits = [...this.#projects.values()].filter(
      (p) =>
        this.#shown(p) &&
        this.#packs.has(p.projectId) &&
        (p.name.toLowerCase().includes(text) || p.slug.includes(text)),
    )
    return {
      total: hits.length,
      hits: hits.slice(search.offset, search.offset + search.limit).map(({ state: _state, ...hit }) => hit),
    }
  }

  async modpackVersions(projectId: string): Promise<CatalogVersion[]> {
    this.#up()
    return [...this.#versions.values()]
      .filter((v) => v.projectId === projectId && v.state !== 'absent')
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
  }

  async filesByHash(sha512s: readonly string[]): Promise<ReadonlyMap<string, CatalogFileMatch>> {
    this.#up()
    const wanted = new Set(sha512s)
    const found = new Map<string, CatalogFileMatch>()
    for (const version of this.#versions.values()) {
      if (version.state === 'absent' || !wanted.has(version.file.sha512)) continue
      found.set(version.file.sha512, {
        version,
        file: {
          ...version.file,
          sha1: this.#sha1.get(version.file.sha512) ?? version.file.sha512.slice(0, 40),
        },
      })
    }
    return found
  }

  /** `https://catalog.test/<modpack|mod|project>/<id>[/version/<id>]`. */
  linkOf(url: string): CatalogLink | null {
    const match =
      /^https:\/\/catalog\.test\/(modpack|mod|plugin|project)\/([^/]+)(?:\/version\/([^/]+))?/.exec(url)
    if (!match) return null
    const kind = match[1] === 'project' ? 'other' : (match[1] as CatalogLink['kind'])
    return { kind, project: match[2] ?? '', version: match[3] ?? null }
  }

  packDownloadAllowed(url: string): boolean {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
      return this.#downloadHosts === null || this.#downloadHosts.has(parsed.hostname)
    } catch {
      return false
    }
  }

  async licences(
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, { name: string; licence: string | null }>> {
    this.#up()
    const found = new Map<string, { name: string; licence: string | null }>()
    for (const id of projectIds) {
      const project = this.#projects.get(id)
      if (project && this.#shown(project))
        found.set(id, { name: project.name, licence: project.licence ?? null })
    }
    return found
  }

  async states(ids: { projects: readonly string[]; versions: readonly string[] }): Promise<CatalogStates> {
    this.#up()
    return {
      projects: new Map(
        ids.projects.map((id) => {
          const project = this.#projects.get(id)
          return [id, project && this.#shown(project) ? project.state : 'absent']
        }),
      ),
      versions: new Map(ids.versions.map((id) => [id, this.#versions.get(id)?.state ?? 'absent'])),
    }
  }

  /** Withheld projects stay visible, as Modrinth shows them; absent ones are gone. */
  #shown(project: CatalogProject): boolean {
    return project.state !== 'absent'
  }

  #fitting(projectId: string, target: CatalogTarget): CatalogVersion[] {
    return [...this.#versions.values()]
      .filter(
        (v) =>
          v.projectId === projectId &&
          v.state !== 'absent' &&
          v.gameVersions.includes(target.gameVersion) &&
          v.loaders.some((l) => target.loaders.includes(l)),
      )
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
  }

  #up(): void {
    if (this.#down) throw new CatalogUnavailable('the fake catalog is down')
  }
}
