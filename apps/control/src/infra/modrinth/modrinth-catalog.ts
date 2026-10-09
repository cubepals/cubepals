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
  MOD_ENVIRONMENTS,
  type ModCatalog,
  type ModEnvironment,
  type PackLinks,
  type ProjectState,
  type VersionState,
} from '../../app/ports/catalog.ts'
import type { ModrinthClient, ModrinthSchemas } from './client.ts'

type Project = ModrinthSchemas['Project']
type Version = ModrinthSchemas['Version']

/**
 * Modrinth as a ModCatalog, on the client generated from Modrinth's spec. What the live API
 * showed beyond the spec is in docs/dependency-audit.md: bulk lookups leave out what they won't
 * show, which is where `absent` comes from, and a version's `environment` replaces the deprecated
 * client and server sides.
 */

/** Bulk lookups go in chunks; 100 ids make a query string of about 1,100 characters. */
const CHUNK = 100
/** Hashes go in a request's body, where more fit. */
const HASH_CHUNK = 400

/**
 * Where a Modrinth pack may download its files from, by the format's own rule
 * (support.modrinth.com "Modrinth Modpack Format", edited 2025-10-15).
 */
const PACK_DOWNLOAD_HOSTS = new Set([
  'cdn.modrinth.com',
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
])

type Result<T> = { data?: T; error?: unknown; response: Response }

export class ModrinthCatalog implements ModCatalog {
  readonly id = 'modrinth'

  projectPage(projectId: string): string {
    return `https://modrinth.com/project/${projectId}`
  }

  packLinks(
    pack: { projectId: string; versionId: string; file: string },
    target: { gameVersion: string; loader: string },
  ): PackLinks {
    // A file fetched from a page other than Modrinth's says why, so the pack's author sees where
    // its downloads came from, as modrinth.com's own do (modrinth.com/news/article/analytics-overhaul).
    const file = new URL(pack.file)
    file.searchParams.set('mr_download_reason', 'standalone')
    file.searchParams.set('mr_game_version', target.gameVersion)
    file.searchParams.set('mr_loader', target.loader)
    return {
      // By ids, which never change; the site answers with its own address for that version.
      page: `https://modrinth.com/project/${pack.projectId}/version/${pack.versionId}`,
      file: file.toString(),
      // The Modrinth App installs exactly this version from it (modrinth/code handler.rs, v0.21.5).
      app: `modrinth://version/${pack.versionId}`,
    }
  }
  readonly #api: ModrinthClient

  constructor(api: ModrinthClient) {
    this.#api = api
  }

  async search(search: CatalogSearch): Promise<{ hits: CatalogHit[]; total: number }> {
    // Each inner list is an OR; the lists AND together.
    const facets = [
      search.projectTypes.map((type) => `project_type:${type}`),
      search.target.loaders.map((loader) => `categories:${loader}`),
      [`versions:${search.target.gameVersion}`],
    ]
    const body = found(
      await read('searching', () =>
        this.#api.GET('/search', {
          params: {
            query: {
              query: search.text,
              facets: JSON.stringify(facets),
              offset: search.offset,
              limit: search.limit,
            },
          },
        }),
      ),
      'searching',
    )
    return {
      total: body.total_hits,
      hits: body.hits.map((hit) => ({
        projectId: hit.project_id,
        slug: hit.slug ?? hit.project_id,
        name: hit.title,
        summary: hit.description,
        iconUrl: hit.icon_url || null,
        environments: hit.environment.map(environmentOf),
        downloads: hit.downloads,
      })),
    }
  }

  async project(idOrSlug: string): Promise<CatalogProject | null> {
    const result = await read(`reading project ${idOrSlug}`, () =>
      this.#api.GET('/project/{id|slug}', { params: { path: { 'id|slug': idOrSlug } } }),
    )
    return result.response.status === 404 ? null : projectOf(found(result, `reading project ${idOrSlug}`))
  }

  async versions(projectId: string, target: CatalogTarget): Promise<CatalogVersion[]> {
    const result = await read(`listing versions of ${projectId}`, () =>
      this.#api.GET('/project/{id|slug}/version', {
        params: {
          path: { 'id|slug': projectId },
          query: {
            loaders: JSON.stringify(target.loaders),
            game_versions: JSON.stringify([target.gameVersion]),
            include_changelog: false,
          },
        },
      }),
    )
    if (result.response.status === 404) return []
    return found(result, `listing versions of ${projectId}`).flatMap(versionOf)
  }

  async version(versionId: string): Promise<CatalogVersion | null> {
    const result = await read(`reading version ${versionId}`, () =>
      this.#api.GET('/version/{id}', { params: { path: { id: versionId } } }),
    )
    if (result.response.status === 404) return null
    return versionOf(found(result, `reading version ${versionId}`))[0] ?? null
  }

  async searchModpacks(search: { text: string; offset: number; limit: number }): Promise<{
    hits: CatalogHit[]
    total: number
  }> {
    const body = found(
      await read('searching modpacks', () =>
        this.#api.GET('/search', {
          params: {
            query: {
              query: search.text,
              facets: JSON.stringify([['project_type:modpack']]),
              offset: search.offset,
              limit: search.limit,
            },
          },
        }),
      ),
      'searching modpacks',
    )
    return {
      total: body.total_hits,
      hits: body.hits.map((hit) => ({
        projectId: hit.project_id,
        slug: hit.slug ?? hit.project_id,
        name: hit.title,
        summary: hit.description,
        iconUrl: hit.icon_url || null,
        environments: hit.environment.map(environmentOf),
        downloads: hit.downloads,
        categories: hit.categories ?? [],
        gameVersions: hit.versions ?? [],
      })),
    }
  }

  async modpackVersions(projectId: string): Promise<CatalogVersion[]> {
    const result = await read(`listing modpack versions of ${projectId}`, () =>
      this.#api.GET('/project/{id|slug}/version', {
        params: { path: { 'id|slug': projectId }, query: { include_changelog: false } },
      }),
    )
    if (result.response.status === 404) return []
    return found(result, `listing modpack versions of ${projectId}`)
      .flatMap(versionOf)
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
  }

  async filesByHash(sha512s: readonly string[]): Promise<ReadonlyMap<string, CatalogFileMatch>> {
    const matches = new Map<string, CatalogFileMatch>()
    // One request answered 309 of Better MC 4's jars at once (2026-09-26); chunks keep a body small.
    for (const chunk of chunks([...new Set(sha512s.map((hash) => hash.toLowerCase()))], HASH_CHUNK)) {
      const shown = found(
        await read('finding files by hash', () =>
          this.#api.POST('/version_files', { body: { hashes: chunk, algorithm: 'sha512' } }),
        ),
        'finding files by hash',
      )
      for (const [hash, version] of Object.entries(shown)) {
        const file = version.files.find((candidate) => candidate.hashes.sha512 === hash)
        const [catalogVersion] = versionOf(version)
        if (!file?.url || !file.hashes.sha1 || catalogVersion === undefined) continue
        matches.set(hash, {
          version: catalogVersion,
          file: {
            url: file.url,
            sha1: file.hashes.sha1,
            sha512: hash,
            sizeBytes: file.size,
            fileName: file.filename,
          },
        })
      }
    }
    return matches
  }

  /**
   * modrinth.com's own addresses, as people copy them (checked 2026-09-26): `/<type>/<slug>`,
   * `/<type>/<slug>/version/<id or number>` with or without a tail (`/versions`, `/changelog`),
   * `/project/<id>`, and a file's link on the CDN, whose path holds both ids.
   */
  linkOf(url: string): CatalogLink | null {
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      return null
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (host === 'cdn.modrinth.com') {
      const [data, project, versions, version] = parts
      if (data !== 'data' || !project || versions !== 'versions' || !version) return null
      return { kind: parts.at(-1)?.endsWith('.mrpack') ? 'modpack' : 'other', project, version }
    }
    if (host !== 'modrinth.com') return null
    const [type = '', project, tail, version] = parts
    if (!project) return null
    const kinds: Record<string, CatalogLink['kind']> = { modpack: 'modpack', mod: 'mod', plugin: 'plugin' }
    const kind = kinds[type] ?? (type === 'project' ? 'other' : null)
    if (kind === null)
      return type === 'datapack' || type === 'resourcepack' || type === 'shader' || type === 'server'
        ? { kind: 'other', project, version: null }
        : null
    return { kind, project, version: tail === 'version' && version ? version : null }
  }

  packDownloadAllowed(url: string): boolean {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'https:' && PACK_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())
    } catch {
      return false
    }
  }

  async versionsByIds(versionIds: readonly string[]): Promise<ReadonlyMap<string, CatalogVersion>> {
    const versions = new Map<string, CatalogVersion>()
    for (const chunk of chunks([...new Set(versionIds)])) {
      const shown = found(
        await read('reading versions', () =>
          this.#api.GET('/versions', { params: { query: { ids: JSON.stringify(chunk) } } }),
        ),
        'reading versions',
      )
      for (const version of shown.flatMap(versionOf)) versions.set(version.versionId, version)
    }
    return versions
  }

  async licences(
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, { name: string; licence: string | null }>> {
    const licences = new Map<string, { name: string; licence: string | null }>()
    for (const chunk of chunks([...new Set(projectIds)])) {
      const shown = found(
        await read('reading project licences', () =>
          this.#api.GET('/projects', { params: { query: { ids: JSON.stringify(chunk) } } }),
        ),
        'reading project licences',
      )
      for (const project of shown)
        licences.set(project.id, { name: project.title, licence: licenceOf(project) })
    }
    return licences
  }

  async states(ids: { projects: readonly string[]; versions: readonly string[] }): Promise<CatalogStates> {
    const projects = new Map<string, ProjectState>(ids.projects.map((id) => [id, 'absent']))
    for (const chunk of chunks([...projects.keys()])) {
      const shown = found(
        await read('reading project states', () =>
          this.#api.GET('/projects', { params: { query: { ids: JSON.stringify(chunk) } } }),
        ),
        'reading project states',
      )
      for (const project of shown)
        if (projects.has(project.id)) projects.set(project.id, projectStateOf(project.status))
    }
    const versions = new Map<string, VersionState>(ids.versions.map((id) => [id, 'absent']))
    for (const chunk of chunks([...versions.keys()])) {
      const shown = found(
        await read('reading version states', () =>
          this.#api.GET('/versions', { params: { query: { ids: JSON.stringify(chunk) } } }),
        ),
        'reading version states',
      )
      for (const version of shown)
        if (versions.has(version.id)) versions.set(version.id, versionStateOf(version.status))
    }
    return { projects, versions }
  }
}

/** A request that couldn't be made, or that Modrinth couldn't serve, is the catalog being unavailable. */
async function read<T>(what: string, call: () => Promise<Result<T>>): Promise<Result<T>> {
  let result: Result<T>
  try {
    result = await call()
  } catch (error) {
    throw new CatalogUnavailable(`${what}: ${(error as Error).message}`)
  }
  const status = result.response.status
  // 408: Modrinth's edge gave up waiting on its own backend, which is an outage like a 5xx.
  if (status === 408 || status === 429 || status >= 500)
    throw new CatalogUnavailable(`${what}: Modrinth answered ${status}`)
  return result
}

/** Anything else that isn't a success is a request we got wrong, not an outage. */
function found<T>(result: Result<T>, what: string): T {
  if (!result.response.ok || result.data === undefined)
    throw new Error(
      `Modrinth: ${what} failed with ${result.response.status}: ${JSON.stringify(result.error ?? null)}`,
    )
  return result.data
}

function projectOf(project: Project): CatalogProject {
  return {
    projectId: project.id,
    slug: project.slug ?? project.id,
    name: project.title,
    summary: project.description,
    iconUrl: project.icon_url ?? null,
    environments: project.environment.map(environmentOf),
    downloads: project.downloads,
    // A search hit's tags are all of these at once; a project keeps them apart. Read as a hit's,
    // so a pack found by its link knows its loader and its size as one found by its name does.
    categories: [
      ...(project.categories ?? []),
      ...(project.additional_categories ?? []),
      ...(project.loaders ?? []),
    ],
    gameVersions: project.game_versions ?? [],
    state: projectStateOf(project.status),
    licence: licenceOf(project),
  }
}

/** The SPDX identifier a project declares; Modrinth keeps an empty one for none. */
const licenceOf = (project: Project): string | null => project.license.id?.trim() || null

/** Empty for a version with nothing to install: no primary file with a sha512 and a URL. */
function versionOf(version: Version): CatalogVersion[] {
  const file = version.files.find((candidate) => candidate.primary) ?? version.files[0]
  if (!file?.hashes.sha512 || !file.url) return []
  return [
    {
      versionId: version.id,
      projectId: version.project_id,
      versionLabel: version.version_number ?? version.name ?? version.id,
      channel: version.version_type ?? 'release',
      state: versionStateOf(version.status),
      environment: environmentOf(version.environment),
      loaders: version.loaders ?? [],
      gameVersions: version.game_versions ?? [],
      publishedAt: new Date(version.date_published),
      file: { url: file.url, sha512: file.hashes.sha512, sizeBytes: file.size, fileName: file.filename },
      dependencies: (version.dependencies ?? []).map((dependency) => ({
        projectId: dependency.project_id ?? null,
        versionId: dependency.version_id ?? null,
        kind: dependency.dependency_type,
      })),
    },
  ]
}

/**
 * The public API shows only what anyone may see, so rejected, draft, private and processing
 * projects never come back; anything that does and isn't publicly visible counts as absent.
 */
function projectStateOf(status: string | undefined): ProjectState {
  return status === 'approved' || status === 'archived' || status === 'unlisted' || status === 'withheld'
    ? status
    : 'absent'
}

function versionStateOf(status: string | undefined): VersionState {
  return status === 'listed' || status === 'archived' || status === 'unlisted' ? status : 'absent'
}

const environmentOf = (value: string | undefined): ModEnvironment =>
  MOD_ENVIRONMENTS.find((known) => known === value) ?? 'unknown'

function* chunks<T>(items: T[], size = CHUNK): Iterable<T[]> {
  for (let at = 0; at < items.length; at += size) yield items.slice(at, at + size)
}
