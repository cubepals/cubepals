// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hangar (hangar.papermc.io), PaperMC's plugin catalog, as a ModCatalog beside Modrinth, on the
 * client generated from Hangar's spec. What its live API showed, recorded in `fixtures/` on
 * 2026-10-09:
 *
 * - Ids are numbers. Blockly writes them `hangar:<id>` (`catalogOfId`), for projects and
 *   versions alike; a project is also found by its unique name, `hangar:OldCombatMechanics`.
 * - Hangar hosts Paper, Velocity and Waterfall plugins. Blockly runs only Paper's, so every
 *   question is asked for the PAPER platform, and a version's file is its PAPER download.
 * - A file is published with its SHA-256 only. Blockly knows every jar by its SHA-512
 *   (`ModArtifact`), so a version's SHA-512 is learned once, from the bytes Hangar's CDN serves,
 *   and only after they match the SHA-256 and size Hangar publishes. The start step then checks
 *   the installed jar against it as it checks every other (`minecraft/install-check.ts`).
 * - A version whose file Hangar only links to elsewhere (`externalUrl`) has nothing Blockly can
 *   install, and is left out, as Modrinth's adapter leaves out a version without a file.
 * - Hangar has no modpacks and no lookup by SHA-512.
 */
import { createHash } from 'node:crypto'
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
import type { HangarClient, HangarSchemas } from './client.ts'

type Project = HangarSchemas['Project']
type Version = HangarSchemas['Version']

const PREFIX = 'hangar:'
const PLATFORM = 'PAPER'
/** The loader tag a Paper plugin's versions carry, as Modrinth's do (`minecraft/mods.ts`). */
const LOADER = 'paper'
/** Hangar answers 25 versions at most per page. */
const PAGE = 25
/** Where Hangar serves the files uploaded to it. */
const FILE_HOST = 'hangarcdn.papermc.io'

type Result<T> = { data?: T; error?: unknown; response: Response }

/** Fetches a file Hangar hosts. Tests pass an in-memory CDN. */
export type FetchFile = (url: string) => Promise<Response>

export class HangarCatalog implements ModCatalog {
  readonly id = 'hangar'
  readonly #api: HangarClient
  readonly #fetchFile: FetchFile
  /** Each version's file never changes once published, so its SHA-512 is learned once. */
  readonly #sha512 = new Map<string, Promise<string>>()
  /** `owner/slug` of projects read so far: a project's page on Hangar is addressed by them. */
  readonly #namespaces = new Map<string, string>()

  constructor(api: HangarClient, fetchFile: FetchFile) {
    this.#api = api
    this.#fetchFile = fetchFile
  }

  /** Hangar's pages are addressed by owner and name; one not read since starting goes to Hangar's home. */
  projectPage(projectId: string): string {
    const namespace = this.#namespaces.get(projectId)
    return namespace === undefined ? 'https://hangar.papermc.io/' : `https://hangar.papermc.io/${namespace}`
  }

  packLinks(): PackLinks {
    throw new Error('Hangar publishes no modpacks')
  }

  async search(search: CatalogSearch): Promise<{ hits: CatalogHit[]; total: number }> {
    if (!search.projectTypes.includes('plugin') || !search.target.loaders.includes(LOADER))
      return { hits: [], total: 0 }
    const body = found(
      await read('searching', () =>
        this.#api.GET('/api/v1/projects', {
          params: {
            query: {
              query: search.text,
              platform: PLATFORM,
              version: search.target.gameVersion,
              offset: String(search.offset),
              limit: String(search.limit),
            },
          },
        }),
      ),
      'searching',
    )
    return { total: body.pagination?.count ?? 0, hits: (body.result ?? []).map((p) => this.#projectOf(p)) }
  }

  async project(idOrSlug: string): Promise<CatalogProject | null> {
    const shown = await this.#readProject(bare(idOrSlug))
    return shown === null ? null : this.#projectOf(shown)
  }

  /**
   * The newest fitting version on each of the project's channels, newest first: all resolution
   * ever picks from them (`domain/mods/resolve.ts`), and each one returned costs a download the
   * first time, to learn its SHA-512. An older one is still found by its id (`version`).
   */
  async versions(projectId: string, target: CatalogTarget): Promise<CatalogVersion[]> {
    if (!target.loaders.includes(LOADER)) return []
    const listed: Version[] = []
    for (let offset = 0; ; offset += PAGE) {
      const result = await read(`listing versions of ${projectId}`, () =>
        this.#api.GET('/api/v1/projects/{slugOrId}/versions', {
          params: {
            path: { slugOrId: bare(projectId) },
            query: {
              platform: PLATFORM,
              platformVersion: target.gameVersion,
              offset: String(offset),
              limit: String(PAGE),
            },
          },
        }),
      )
      if (result.response.status === 404) return []
      const page = found(result, `listing versions of ${projectId}`)
      listed.push(...(page.result ?? []))
      if ((page.result ?? []).length < PAGE || listed.length >= (page.pagination?.count ?? 0)) break
    }
    const newest = new Map<string, Version>()
    for (const version of listed.filter((v) => installable(v) !== null).sort(byNewest)) {
      const channel = channelOf(version)
      if (!newest.has(channel)) newest.set(channel, version)
    }
    return Promise.all([...newest.values()].map((version) => this.#versionOf(version)))
  }

  async version(versionId: string): Promise<CatalogVersion | null> {
    const shown = await this.#readVersion(versionId)
    return shown === null || installable(shown) === null ? null : this.#versionOf(shown)
  }

  /** Hangar has no bulk read; each id is asked for in turn, within its rate limit. */
  async versionsByIds(versionIds: readonly string[]): Promise<ReadonlyMap<string, CatalogVersion>> {
    const versions = new Map<string, CatalogVersion>()
    for (const versionId of new Set(versionIds)) {
      const version = await this.version(versionId)
      if (version !== null) versions.set(versionId, version)
    }
    return versions
  }

  async states(ids: { projects: readonly string[]; versions: readonly string[] }): Promise<CatalogStates> {
    const projects = new Map<string, ProjectState>()
    for (const projectId of new Set(ids.projects)) {
      const shown = await this.#readProject(bare(projectId))
      projects.set(projectId, shown === null ? 'absent' : projectStateOf(shown))
    }
    const versions = new Map<string, VersionState>()
    for (const versionId of new Set(ids.versions)) {
      const shown = await this.#readVersion(versionId)
      versions.set(versionId, shown?.visibility === 'public' ? 'listed' : 'absent')
    }
    return { projects, versions }
  }

  async searchModpacks(): Promise<{ hits: CatalogHit[]; total: number }> {
    return { hits: [], total: 0 }
  }

  async modpackVersions(): Promise<CatalogVersion[]> {
    return []
  }

  /** Hangar finds a file by its SHA-256 only, which nothing in Blockly holds. */
  async filesByHash(): Promise<ReadonlyMap<string, CatalogFileMatch>> {
    return new Map()
  }

  /** The licence a project names, in Hangar's words ("MPL 2.0"), not always an SPDX identifier. */
  async licences(
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, { name: string; licence: string | null }>> {
    const licences = new Map<string, { name: string; licence: string | null }>()
    for (const projectId of new Set(projectIds)) {
      const shown = await this.#readProject(bare(projectId))
      if (shown !== null)
        licences.set(projectId, { name: shown.name ?? projectId, licence: licenceOf(shown) })
    }
    return licences
  }

  /** hangar.papermc.io's own addresses: `/<owner>/<name>`, with or without a tail. */
  linkOf(url: string): CatalogLink | null {
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      return null
    }
    if (parsed.hostname.toLowerCase() !== 'hangar.papermc.io') return null
    const [owner, name] = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (!owner || !name || owner === 'api') return null
    return { kind: 'plugin', project: `${PREFIX}${name}`, version: null }
  }

  packDownloadAllowed(): boolean {
    return false
  }

  async #readProject(slugOrId: string): Promise<Project | null> {
    const result = await read(`reading project ${slugOrId}`, () =>
      this.#api.GET('/api/v1/projects/{slugOrId}', { params: { path: { slugOrId } } }),
    )
    if (result.response.status === 404) return null
    return found(result, `reading project ${slugOrId}`)
  }

  async #readVersion(versionId: string): Promise<Version | null> {
    const id = bare(versionId)
    // A version is read by its number alone; anything else is no version of Hangar's.
    if (!/^\d+$/.test(id)) return null
    const result = await read(`reading version ${versionId}`, () =>
      this.#api.GET('/api/v1/versions/{id}', { params: { path: { id } } }),
    )
    if (result.response.status === 404) return null
    return found(result, `reading version ${versionId}`)
  }

  #projectOf(project: Project): CatalogProject {
    const projectId = `${PREFIX}${project.id}`
    if (project.namespace?.owner && project.namespace.slug)
      this.#namespaces.set(projectId, `${project.namespace.owner}/${project.namespace.slug}`)
    return {
      projectId,
      slug: `${PREFIX}${project.namespace?.slug ?? project.id}`,
      name: project.name ?? projectId,
      summary: project.description ?? '',
      iconUrl: project.avatarUrl ?? null,
      // A Paper plugin runs on the server alone; players join with plain Minecraft.
      environments: ['server_only'],
      downloads: project.stats?.downloads ?? 0,
      categories: project.category === undefined ? [] : [project.category],
      gameVersions: project.supportedPlatforms?.[PLATFORM] ?? [],
      state: projectStateOf(project),
      licence: licenceOf(project),
    }
  }

  async #versionOf(version: Version): Promise<CatalogVersion> {
    const file = installable(version)
    if (file === null) throw new Error(`Hangar version ${version.id} has no file to install`)
    const versionId = `${PREFIX}${version.id}`
    let learning = this.#sha512.get(versionId)
    if (learning === undefined) {
      learning = learnSha512(this.#fetchFile, file)
      this.#sha512.set(versionId, learning)
      // A failed download is tried again next time, never remembered.
      learning.catch(() => this.#sha512.delete(versionId))
    }
    return {
      versionId,
      projectId: `${PREFIX}${version.projectId}`,
      versionLabel: version.name ?? versionId,
      channel: channelOf(version),
      state: version.visibility === 'public' ? 'listed' : 'absent',
      environment: 'server_only',
      loaders: [LOADER],
      gameVersions: version.platformDependencies?.[PLATFORM] ?? [],
      publishedAt: new Date(version.createdAt ?? 0),
      file: { url: file.url, sha512: await learning, sizeBytes: file.sizeBytes, fileName: file.fileName },
      dependencies: (version.pluginDependencies?.[PLATFORM] ?? []).map((dependency) => ({
        // One hosted elsewhere names no project Blockly can fetch; one it needs is a conflict.
        projectId: dependency.projectId === undefined ? null : `${PREFIX}${dependency.projectId}`,
        versionId: null,
        kind: dependency.required ? 'required' : 'optional',
      })),
    }
  }
}

interface HangarFile {
  url: string
  sha256: string
  sizeBytes: number
  fileName: string
}

/** The PAPER file Hangar hosts itself, with what it publishes about it; null when there is none. */
function installable(version: Version): HangarFile | null {
  const download = version.downloads?.[PLATFORM]
  const info = download?.fileInfo
  if (!download?.downloadUrl || !info?.sha256Hash || info.sizeBytes === undefined || !info.name) return null
  let url: URL
  try {
    url = new URL(download.downloadUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== FILE_HOST) return null
  return {
    url: url.toString(),
    sha256: info.sha256Hash.toLowerCase(),
    sizeBytes: info.sizeBytes,
    fileName: info.name,
  }
}

/**
 * The file's SHA-512, from its bytes as Hangar serves them, once they match the size and SHA-256
 * Hangar publishes. Bytes that don't are refused, never pinned.
 */
async function learnSha512(fetchFile: FetchFile, file: HangarFile): Promise<string> {
  let response: Response
  try {
    response = await fetchFile(file.url)
  } catch (error) {
    throw new CatalogUnavailable(`downloading ${file.url}: ${(error as Error).message}`, 'Hangar')
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new CatalogUnavailable(`downloading ${file.url}: Hangar answered ${response.status}`, 'Hangar')
  }
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > file.sizeBytes) break
    sha256.update(chunk)
    sha512.update(chunk)
  }
  const got = sha256.digest('hex')
  if (size !== file.sizeBytes || got !== file.sha256)
    throw new Error(
      `Hangar: ${file.url} served ${size} bytes with SHA-256 ${got}; Hangar publishes ${file.sizeBytes} bytes with ${file.sha256}`,
    )
  return sha512.digest('hex')
}

/** A request that couldn't be made, or that Hangar couldn't serve, is the catalog being unavailable. */
async function read<T>(what: string, call: () => Promise<Result<T>>): Promise<Result<T>> {
  let result: Result<T>
  try {
    result = await call()
  } catch (error) {
    throw new CatalogUnavailable(`${what}: ${(error as Error).message}`, 'Hangar')
  }
  const status = result.response.status
  if (status === 408 || status === 429 || status >= 500)
    throw new CatalogUnavailable(`${what}: Hangar answered ${status}`, 'Hangar')
  return result
}

/** Anything else that isn't a success is a request we got wrong, not an outage. */
function found<T>(result: Result<T>, what: string): T {
  if (!result.response.ok || result.data === undefined)
    throw new Error(
      `Hangar: ${what} failed with ${result.response.status}: ${JSON.stringify(result.error ?? null)}`,
    )
  return result.data
}

/** The id Hangar knows: Blockly's, without the catalog's name. */
const bare = (id: string): string => (id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id)

/** Anonymous reads see public projects only; one reachable by link alone is unlisted. */
function projectStateOf(project: Project): ProjectState {
  if (project.visibility !== undefined && project.visibility !== 'public') return 'absent'
  return project.settings?.unlisted ? 'unlisted' : 'approved'
}

/** Hangar marks a channel of builds that may break as unstable; every other is a release channel. */
const channelOf = (version: Version): CatalogVersion['channel'] =>
  version.channel?.flags?.includes('UNSTABLE') ? 'beta' : 'release'

function licenceOf(project: Project): string | null {
  const licence = project.settings?.license
  if (licence?.type === 'Unspecified') return null
  return licence?.name?.trim() || null
}

const byNewest = (a: Version, b: Version): number =>
  new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
