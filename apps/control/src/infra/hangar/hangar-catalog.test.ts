/**
 * Hangar's own answers, recorded from hangar.papermc.io on 2026-10-09 (`fixtures/`). Only a
 * file's bytes are stood in for: a test jar replaces OldCombatMechanics' 9 MB one, and the
 * version that carries it publishes the test jar's size and SHA-256 instead of the real ones.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { CatalogUnavailable } from '../../app/ports/catalog.ts'
import { resolve } from '../../domain/mods/resolve.ts'
import { type HangarSchemas, hangarClient } from './client.ts'
import missing from './fixtures/project-missing.json' with { type: 'json' }
import project from './fixtures/project-oldcombatmechanics.json' with { type: 'json' }
import search from './fixtures/search-oldcombatmechanics.json' with { type: 'json' }
import release from './fixtures/version-31271.json' with { type: 'json' }
import viaBackwards from './fixtures/version-31534-viabackwards.json' with { type: 'json' }
import firstPage from './fixtures/versions-oldcombatmechanics-paper-26.2-0.json' with { type: 'json' }
import secondPage from './fixtures/versions-oldcombatmechanics-paper-26.2-25.json' with { type: 'json' }
import { HangarCatalog } from './hangar-catalog.ts'

type Version = HangarSchemas['Version']

const PAPER = { gameVersion: '26.2', loaders: ['paper', 'spigot', 'bukkit', 'datapack'] }
const JAR = new TextEncoder().encode('a stand-in for OldCombatMechanics.jar')
const sha = (algorithm: string, bytes: Uint8Array) => createHash(algorithm).update(bytes).digest('hex')

/** A recorded version whose PAPER file is the test jar, as Hangar would publish it. */
function carrying(version: Version, bytes = JAR): Version {
  const download = version.downloads?.PAPER
  return {
    ...version,
    downloads: {
      PAPER: {
        ...download,
        fileInfo: { ...download?.fileInfo, sizeBytes: bytes.length, sha256Hash: sha('sha256', bytes) },
      },
    },
  }
}

const versions = (page: { result: unknown[] }) => page.result as unknown as Version[]

interface Hangar {
  catalog: HangarCatalog
  asked: string[]
  downloads: string[]
}

/** Hangar as recorded, behind the generated client, and its CDN serving `served`. */
function hangar(options: { status?: number; served?: Uint8Array } = {}): Hangar {
  const asked: string[] = []
  const downloads: string[] = []
  const pages: Record<string, unknown> = {
    '0': { ...firstPage, result: versions(firstPage).map((v) => carrying(v)) },
    '25': { ...secondPage, result: versions(secondPage).map((v) => carrying(v)) },
  }
  const routes: Record<string, (url: URL) => unknown> = {
    '/api/v1/projects': () => search,
    '/api/v1/projects/OldCombatMechanics': () => project,
    '/api/v1/projects/2087': () => project,
    '/api/v1/projects/2087/versions': (url) => pages[url.searchParams.get('offset') ?? '0'],
    '/api/v1/versions/31271': () => carrying(release as unknown as Version),
    '/api/v1/versions/31534': () => carrying(viaBackwards as unknown as Version),
  }
  const answer = (url: URL): [number, unknown] => {
    const route = routes[url.pathname]
    if (options.status !== undefined) return [options.status, {}]
    if (route !== undefined) return [200, route(url)]
    return [404, url.pathname.startsWith('/api/v1/projects/') ? missing : {}]
  }
  const api = hangarClient('blockly-test', {
    baseUrl: 'https://hangar.test',
    maxWaitMs: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      asked.push(`${url.pathname}${url.search}`)
      const [status, body] = answer(url)
      return Response.json(body, { status })
    },
  })
  const catalog = new HangarCatalog(api, async (url) => {
    downloads.push(url)
    return new Response(options.served ?? JAR)
  })
  return { catalog, asked, downloads }
}

describe('HangarCatalog', () => {
  test('a project, found by its name, under the id Blockly gives it', async () => {
    const { catalog } = hangar()
    expect(await catalog.project('hangar:OldCombatMechanics')).toEqual({
      projectId: 'hangar:2087',
      slug: 'hangar:OldCombatMechanics',
      name: 'OldCombatMechanics',
      summary: 'Configure combat-related mechanics from 1.9 onwards',
      iconUrl: 'https://hangarcdn.papermc.io/avatars/project/2087.webp?v=1',
      environments: ['server_only'],
      downloads: 2723,
      categories: ['gameplay'],
      gameVersions: expect.arrayContaining(['26.1.2', '26.2', '26.3']),
      state: 'approved',
      licence: 'MPL 2.0',
    })
    expect(catalog.projectPage('hangar:2087')).toBe('https://hangar.papermc.io/kernitus/OldCombatMechanics')
  })

  test('a project Hangar does not show is null', async () => {
    expect(await hangar().catalog.project('hangar:999999999')).toBeNull()
  })

  test("Paper versions for a release: every page read, the newest of each channel kept, each file's SHA-512 learned", async () => {
    const { catalog, asked, downloads } = hangar()
    const found = await catalog.versions('hangar:2087', PAPER)
    expect(asked).toEqual([
      '/api/v1/projects/2087/versions?platform=PAPER&platformVersion=26.2&offset=0&limit=25',
      '/api/v1/projects/2087/versions?platform=PAPER&platformVersion=26.2&offset=25&limit=25',
    ])
    expect(found.map((v) => [v.versionId, v.versionLabel, v.channel])).toEqual([
      ['hangar:31311', '2.7.1-SNAPSHOT+e66e7a9', 'beta'],
      ['hangar:31271', '2.7.0', 'release'],
    ])
    expect(found[1]).toEqual({
      versionId: 'hangar:31271',
      projectId: 'hangar:2087',
      versionLabel: '2.7.0',
      channel: 'release',
      state: 'listed',
      environment: 'server_only',
      loaders: ['paper'],
      gameVersions: expect.arrayContaining(['26.2']),
      publishedAt: new Date('2026-10-03T12:35:15.785079Z'),
      file: {
        url: 'https://hangarcdn.papermc.io/plugins/kernitus/OldCombatMechanics/versions/2.7.0/PAPER/OldCombatMechanics.jar',
        sha512: sha('sha512', JAR),
        sizeBytes: JAR.length,
        fileName: 'OldCombatMechanics.jar',
      },
      dependencies: [],
    })
    // A file is downloaded once, however often it is asked about.
    await catalog.versions('hangar:2087', PAPER)
    await catalog.version('hangar:31271')
    expect(downloads.sort()).toEqual(found.map((v) => v.file.url).sort())
  })

  test('bytes that differ from the SHA-256 Hangar publishes are refused, and asked for again next time', async () => {
    const { catalog, downloads } = hangar({ served: new TextEncoder().encode('something else entirely') })
    await expect(catalog.version('hangar:31271')).rejects.toThrow(/served .* Hangar publishes/)
    await expect(catalog.version('hangar:31271')).rejects.toThrow(/served .* Hangar publishes/)
    expect(downloads).toHaveLength(2)
  })

  test('a server type Hangar has no plugins for asks nothing', async () => {
    const { catalog, asked } = hangar()
    expect(await catalog.versions('hangar:2087', { gameVersion: '26.2', loaders: ['fabric'] })).toEqual([])
    expect(asked).toEqual([])
  })

  test("a plugin's dependencies: Hangar projects by id, required or not", async () => {
    const { catalog } = hangar()
    const version = await catalog.version('hangar:31534')
    expect(version?.dependencies).toEqual([
      { projectId: 'hangar:112', versionId: null, kind: 'optional' },
      { projectId: 'hangar:31', versionId: null, kind: 'required' },
    ])
  })
})

describe('HangarCatalog states, search and links', () => {
  test('states: every id answered, what Hangar does not show absent', async () => {
    const { catalog } = hangar()
    const states = await catalog.states({
      projects: ['hangar:2087', 'hangar:999999999'],
      versions: ['hangar:31271', 'hangar:404404', 'hangar:not-a-number'],
    })
    expect([...states.projects]).toEqual([
      ['hangar:2087', 'approved'],
      ['hangar:999999999', 'absent'],
    ])
    expect([...states.versions]).toEqual([
      ['hangar:31271', 'listed'],
      ['hangar:404404', 'absent'],
      ['hangar:not-a-number', 'absent'],
    ])
  })

  test('search: plugins for a Paper release, under Blockly ids', async () => {
    const { catalog, asked } = hangar()
    const found = await catalog.search({
      text: 'OldCombatMechanics',
      target: PAPER,
      projectTypes: ['plugin'],
      offset: 0,
      limit: 10,
    })
    expect(asked).toEqual([
      '/api/v1/projects?query=OldCombatMechanics&platform=PAPER&version=26.2&offset=0&limit=10',
    ])
    expect(found.total).toBe(search.pagination.count)
    expect(found.hits[0]?.projectId).toBe('hangar:2087')
  })

  test('Hangar failing is the catalog being unavailable, named as Hangar', async () => {
    const error = await hangar({ status: 503 })
      .catalog.project('hangar:2087')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CatalogUnavailable)
    expect((error as CatalogUnavailable).catalog).toBe('Hangar')
  })

  test("links to Hangar's own pages", () => {
    const { catalog } = hangar()
    expect(catalog.linkOf('https://hangar.papermc.io/kernitus/OldCombatMechanics/versions')).toEqual({
      kind: 'plugin',
      project: 'hangar:OldCombatMechanics',
      version: null,
    })
    expect(catalog.linkOf('https://modrinth.com/plugin/lifestealz')).toBeNull()
  })
})

describe('HangarCatalog with the resolver', () => {
  test('resolves OldCombatMechanics from Hangar beside a Modrinth plugin, each pinned to its own catalog', async () => {
    const { catalog } = hangar()
    const ocm = await catalog.project('hangar:2087')
    const fitting = await catalog.versions('hangar:2087', PAPER)
    const lifesteal = {
      ...(ocm as NonNullable<typeof ocm>),
      projectId: 'l8Uv7FzS',
      slug: 'lifestealz',
      name: 'LifeStealZ',
    }
    const lifestealVersion = { ...(fitting[1] as NonNullable<(typeof fitting)[1]>), projectId: 'l8Uv7FzS' }
    const result = resolve(
      {
        catalog: 'modrinth',
        target: PAPER,
        wanted: [{ projectId: 'hangar:2087' }, { projectId: 'l8Uv7FzS' }],
        current: [],
        upgrade: new Set(),
        environment: () => 'server',
      },
      {
        projects: new Map([
          ['hangar:2087', ocm],
          ['l8Uv7FzS', lifesteal],
        ]),
        fitting: new Map([
          ['hangar:2087', fitting],
          ['l8Uv7FzS', [{ ...lifestealVersion, versionId: 'LS1' }]],
        ]),
        versions: new Map(),
      },
    )
    if (result.kind !== 'resolved') throw new Error(JSON.stringify(result))
    expect(result.mods.map((m) => [m.name, m.source, m.artifact.ref])).toEqual([
      ['LifeStealZ', { catalog: 'modrinth', projectId: 'l8Uv7FzS', versionId: 'LS1' }, expect.anything()],
      [
        'OldCombatMechanics',
        { catalog: 'hangar', projectId: 'hangar:2087', versionId: 'hangar:31271' },
        {
          kind: 'remote',
          url: 'https://hangarcdn.papermc.io/plugins/kernitus/OldCombatMechanics/versions/2.7.0/PAPER/OldCombatMechanics.jar',
        },
      ],
    ])
  })
})
