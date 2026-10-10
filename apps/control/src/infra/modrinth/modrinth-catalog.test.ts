// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { CatalogUnavailable } from '../../app/ports/catalog.ts'
import { type ModrinthSchemas, modrinthClient } from './client.ts'
import { ModrinthCatalog } from './modrinth-catalog.ts'

type Project = ModrinthSchemas['Project']
type Version = ModrinthSchemas['Version']
type Hit = ModrinthSchemas['ProjectResult']

const SHA512 = 'a'.repeat(128)

// Shaped like what the live API returned on 2026-09-19, typed by Modrinth's own spec.
const project = (patch: Partial<Project> = {}): Project => ({
  id: 'gvQqBUqZ',
  slug: 'lithium',
  title: 'Lithium',
  description: 'No-compromises game logic optimization mod.',
  body: '',
  body_url: null,
  categories: ['optimization'],
  additional_categories: [],
  client_side: 'optional',
  server_side: 'optional',
  environment: ['client_or_server_prefers_both'],
  downloads: 1000,
  followers: 10,
  gallery: [],
  game_versions: ['26.3'],
  icon_url: 'https://cdn.modrinth.com/data/gvQqBUqZ/icon.png',
  license: { id: 'LGPL-3.0-only', name: '', url: null },
  loaders: ['fabric'],
  monetization_status: 'monetized',
  project_type: 'mod',
  published: '2021-01-03T00:00:00Z',
  status: 'approved',
  team: 't',
  thread_id: 't',
  updated: '2026-09-01T00:00:00Z',
  versions: [],
  ...patch,
})

const version = (patch: Partial<Version> = {}): Version => ({
  id: 'VERSION1',
  project_id: 'gvQqBUqZ',
  author_id: 'a',
  name: 'Lithium 0.26.1',
  version_number: 'mc26.3-0.26.1-fabric',
  version_type: 'release',
  status: 'listed',
  environment: 'client_or_server_prefers_both',
  loaders: ['fabric'],
  game_versions: ['26.3'],
  date_published: '2026-09-10T12:00:00Z',
  downloads: 5,
  dependencies: [],
  files: [
    {
      url: 'https://cdn.modrinth.com/data/gvQqBUqZ/versions/VERSION1/lithium-fabric-0.26.1+mc26.3.jar',
      filename: 'lithium-fabric-0.26.1+mc26.3.jar',
      hashes: { sha512: SHA512, sha1: 'b'.repeat(40) },
      primary: true,
      size: 915429,
    },
  ],
  ...patch,
})

const hit = (patch: Partial<Hit> = {}): Hit => ({
  project_id: 'gvQqBUqZ',
  slug: 'lithium',
  title: 'Lithium',
  description: 'No-compromises game logic optimization mod.',
  author: 'jellysquid3',
  categories: ['fabric', 'optimization'],
  display_categories: [],
  client_side: 'optional',
  server_side: 'optional',
  environment: ['client_or_server_prefers_both'],
  all_project_types: ['mod'],
  project_type: 'mod',
  date_created: '2021-01-03T00:00:00Z',
  date_modified: '2026-09-10T00:00:00Z',
  disclosure_types: [],
  downloads: 1000,
  follows: 10,
  gallery: [],
  icon_url: '',
  latest_version: 'VERSION1',
  license: 'LGPL-3.0-only',
  versions: ['26.3'],
  ...patch,
})

/** An in-memory Modrinth that records what it was asked. */
function modrinth(routes: (url: URL) => Response | Promise<Response>) {
  const requests: Request[] = []
  const fetch = async (request: Request) => {
    requests.push(request)
    return routes(new URL(request.url))
  }
  const catalog = new ModrinthCatalog(
    modrinthClient('cubepals/cubepals (test)', { fetch: fetch as never, maxWaitMs: 5 }),
  )
  return { catalog, requests }
}

const ids = (url: URL) => JSON.parse(url.searchParams.get('ids') ?? '[]') as string[]

describe('ModrinthCatalog', () => {
  test('search ORs within a facet and ANDs across them, and names itself', async () => {
    const { catalog, requests } = modrinth(() =>
      Response.json({ hits: [hit()], offset: 0, limit: 10, total_hits: 1 }),
    )
    const page = await catalog.search({
      text: 'lithium',
      target: { loaders: ['quilt', 'fabric'], gameVersion: '26.3' },
      projectTypes: ['mod'],
      offset: 20,
      limit: 10,
    })
    const url = new URL(requests[0]?.url ?? '')
    expect(url.pathname).toBe('/v2/search')
    expect(url.searchParams.get('query')).toBe('lithium')
    expect(JSON.parse(url.searchParams.get('facets') ?? '')).toEqual([
      ['project_type:mod'],
      ['categories:quilt', 'categories:fabric'],
      ['versions:26.3'],
    ])
    expect(url.searchParams.get('offset')).toBe('20')
    expect(requests[0]?.headers.get('user-agent')).toBe('cubepals/cubepals (test)')
    expect(page).toEqual({
      total: 1,
      hits: [
        {
          projectId: 'gvQqBUqZ',
          slug: 'lithium',
          name: 'Lithium',
          summary: 'No-compromises game logic optimization mod.',
          iconUrl: null,
          environments: ['client_or_server_prefers_both'],
          downloads: 1000,
        },
      ],
    })
  })

  test('a project is read about on Modrinth’s own site', () => {
    const { catalog, requests } = modrinth(() => Response.json({}))
    expect(catalog.projectPage('gvQqBUqZ')).toBe('https://modrinth.com/project/gvQqBUqZ')
    expect(requests).toEqual([])
  })

  test('a pack version is got from Modrinth itself: its page, its file, and the Modrinth App', () => {
    const { catalog, requests } = modrinth(() => Response.json({}))
    // The file as Modrinth names it, with a space and a plus it keeps encoded.
    const file =
      'https://cdn.modrinth.com/data/1ocGzRHv/versions/Bu8RKHri/Vanilla%20Perfected%201.0.0%2B26.3.mrpack'
    expect(
      catalog.packLinks(
        { projectId: '1ocGzRHv', versionId: 'Bu8RKHri', file },
        { gameVersion: '26.2', loader: 'fabric' },
      ),
    ).toEqual({
      page: 'https://modrinth.com/project/1ocGzRHv/version/Bu8RKHri',
      // Said to be a download of its own, so the pack's author sees where it came from.
      file: `${file}?mr_download_reason=standalone&mr_game_version=26.2&mr_loader=fabric`,
      app: 'modrinth://version/Bu8RKHri',
    })
    expect(requests).toEqual([])
  })

  test('a project by slug, with its state; one the catalog does not show is null', async () => {
    const { catalog } = modrinth((url) =>
      url.pathname === '/v2/project/lithium'
        ? Response.json(project({ status: 'archived' }))
        : new Response('', { status: 404 }),
    )
    expect(await catalog.project('lithium')).toMatchObject({
      projectId: 'gvQqBUqZ',
      state: 'archived',
      licence: 'LGPL-3.0-only',
      // Its releases and loader, as a search hit carries them: a pasted link is judged by these.
      categories: ['optimization', 'fabric'],
      gameVersions: ['26.3'],
    })
    expect(await catalog.project('gone')).toBeNull()
  })

  test("a project's versions for one target: primary file, dependencies, and nothing uninstallable", async () => {
    const withDependency = version({
      dependencies: [
        { project_id: 'P7dR8mSH', version_id: null, file_name: null, dependency_type: 'required' },
      ],
      files: [
        {
          url: 'https://cdn.modrinth.com/sources.jar',
          filename: 'x-sources.jar',
          hashes: { sha512: 'c'.repeat(128) },
          primary: false,
          size: 1,
        },
        {
          url: 'https://cdn.modrinth.com/x.jar',
          filename: 'x.jar',
          hashes: { sha512: SHA512 },
          primary: true,
          size: 42,
        },
      ],
    })
    const noHash = version({
      id: 'NOHASH00',
      files: [
        { url: 'https://cdn.modrinth.com/y.jar', filename: 'y.jar', hashes: {}, primary: true, size: 1 },
      ],
    })
    const { catalog, requests } = modrinth(() => Response.json([withDependency, noHash]))
    const versions = await catalog.versions('gvQqBUqZ', { loaders: ['fabric', 'quilt'], gameVersion: '26.3' })
    const url = new URL(requests[0]?.url ?? '')
    expect(url.pathname).toBe('/v2/project/gvQqBUqZ/version')
    expect(JSON.parse(url.searchParams.get('loaders') ?? '')).toEqual(['fabric', 'quilt'])
    expect(JSON.parse(url.searchParams.get('game_versions') ?? '')).toEqual(['26.3'])
    expect(url.searchParams.get('include_changelog')).toBe('false')
    expect(versions).toEqual([
      {
        versionId: 'VERSION1',
        projectId: 'gvQqBUqZ',
        versionLabel: 'mc26.3-0.26.1-fabric',
        channel: 'release',
        state: 'listed',
        environment: 'client_or_server_prefers_both',
        loaders: ['fabric'],
        gameVersions: ['26.3'],
        publishedAt: new Date('2026-09-10T12:00:00Z'),
        file: { url: 'https://cdn.modrinth.com/x.jar', sha512: SHA512, sizeBytes: 42, fileName: 'x.jar' },
        dependencies: [{ projectId: 'P7dR8mSH', versionId: null, kind: 'required' }],
      },
    ])
  })

  test('one version; a missing one is null', async () => {
    const { catalog } = modrinth((url) =>
      url.pathname === '/v2/version/VERSION1' ? Response.json(version()) : new Response('', { status: 404 }),
    )
    expect((await catalog.version('VERSION1'))?.file.sha512).toBe(SHA512)
    expect(await catalog.version('MISSING0')).toBeNull()
  })

  test('many versions at once, in chunks; ones the catalog leaves out are missing', async () => {
    const versionIds = Array.from({ length: 120 }, (_, i) => `V${String(i).padStart(7, '0')}`)
    const { catalog, requests } = modrinth((url) =>
      Response.json(
        ids(url)
          .filter((id) => id !== 'V0000007')
          .map((id) => version({ id })),
      ),
    )
    const found = await catalog.versionsByIds([...versionIds, 'V0000000'])
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(['/v2/versions', '/v2/versions'])
    expect(found.size).toBe(119)
    expect(found.has('V0000007')).toBe(false)
    expect(found.get('V0000119')?.file.sha512).toBe(SHA512)
  })

  test('states answer every id, in chunks of 100, and what the catalog leaves out is absent', async () => {
    const projectIds = Array.from({ length: 150 }, (_, i) => `P${String(i).padStart(7, '0')}`)
    const { catalog, requests } = modrinth((url) => {
      if (url.pathname === '/v2/projects')
        return Response.json(
          ids(url)
            .filter((id) => id !== 'P0000000')
            .map((id) =>
              project({
                id,
                status: id === 'P0000001' ? 'withheld' : id === 'P0000002' ? 'rejected' : 'approved',
              }),
            ),
        )
      return Response.json(
        ids(url)
          .filter((id) => id !== 'V2')
          .map((id) => version({ id, status: id === 'V1' ? 'unlisted' : 'listed' })),
      )
    })
    const states = await catalog.states({ projects: projectIds, versions: ['V1', 'V2'] })
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/v2/projects',
      '/v2/projects',
      '/v2/versions',
    ])
    expect(ids(new URL(requests[0]?.url ?? ''))).toHaveLength(100)
    expect(states.projects.size).toBe(150)
    expect(states.projects.get('P0000000')).toBe('absent')
    expect(states.projects.get('P0000001')).toBe('withheld')
    // The public API shouldn't show a rejected project; if it does, it isn't trusted.
    expect(states.projects.get('P0000002')).toBe('absent')
    expect(states.projects.get('P0000149')).toBe('approved')
    expect(states.versions).toEqual(
      new Map([
        ['V1', 'unlisted'],
        ['V2', 'absent'],
      ]),
    )
  })

  test('licences come by project in chunks, as SPDX identifiers; none declared is null, unshown left out', async () => {
    const projectIds = Array.from({ length: 120 }, (_, i) => `P${String(i).padStart(7, '0')}`)
    const { catalog, requests } = modrinth((url) =>
      Response.json(
        ids(url)
          .filter((id) => id !== 'P0000000')
          .map((id) =>
            project({
              id,
              title: `Project ${id}`,
              license:
                id === 'P0000001'
                  ? { id: 'LicenseRef-All-Rights-Reserved', name: '', url: null }
                  : id === 'P0000002'
                    ? { id: '', name: '', url: null }
                    : { id: 'MIT', name: 'MIT License', url: null },
            }),
          ),
      ),
    )
    const licences = await catalog.licences(projectIds)
    expect(requests).toHaveLength(2)
    expect(licences.has('P0000000')).toBe(false)
    expect(licences.get('P0000001')).toEqual({
      name: 'Project P0000001',
      licence: 'LicenseRef-All-Rights-Reserved',
    })
    expect(licences.get('P0000002')?.licence).toBeNull()
    expect(licences.get('P0000119')?.licence).toBe('MIT')
  })

  test('a rate limit waits for its window and tries again', async () => {
    let calls = 0
    const { catalog } = modrinth(() =>
      ++calls === 1
        ? new Response('', { status: 429, headers: { 'x-ratelimit-reset': '0' } })
        : Response.json(project()),
    )
    expect(await catalog.project('lithium')).toMatchObject({ slug: 'lithium' })
    expect(calls).toBe(2)
  })

  test('an outage is CatalogUnavailable, after three tries', async () => {
    let calls = 0
    const down = modrinth(() => {
      calls++
      return new Response('', { status: 503 })
    })
    await expect(down.catalog.project('lithium')).rejects.toBeInstanceOf(CatalogUnavailable)
    expect(calls).toBe(3)
    const unreachable = modrinth(() => {
      throw new TypeError('fetch failed')
    })
    await expect(
      unreachable.catalog.search({
        text: '',
        target: { loaders: ['fabric'], gameVersion: '26.3' },
        projectTypes: ['mod'],
        offset: 0,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(CatalogUnavailable)
  })

  test('looking files up by hash is a read, and tried again like one', async () => {
    let calls = 0
    const { catalog } = modrinth(() => (++calls < 3 ? new Response('', { status: 502 }) : Response.json({})))
    expect((await catalog.filesByHash(['a'.repeat(128)])).size).toBe(0)
    expect(calls).toBe(3)
  })

  test('a request Modrinth refuses as malformed is a bug, not an outage', async () => {
    const { catalog } = modrinth(() =>
      Response.json({ error: 'invalid_input', description: 'bad facets' }, { status: 400 }),
    )
    const refused = catalog.project('lithium')
    await expect(refused).rejects.toThrow(/400/)
    await expect(refused).rejects.not.toBeInstanceOf(CatalogUnavailable)
  })
})
