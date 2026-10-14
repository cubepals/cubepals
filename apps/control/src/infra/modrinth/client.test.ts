// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How the Modrinth client treats Modrinth: reads shared across creates, a rate limit waited out
 * within its bound, and a read that gives up saying what it was answered.
 */
import { describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { CatalogUnavailable } from '../../app/ports/catalog.ts'
import { type ModrinthClientOptions, type ModrinthSchemas, modrinthClient } from './client.ts'
import { ModrinthCatalog } from './modrinth-catalog.ts'
import { SharedReads } from './shared-reads.ts'

type Version = ModrinthSchemas['Version']

const version = (id: string, projectId: string, dependsOn: string[] = []): Version => ({
  id,
  project_id: projectId,
  author_id: 'a',
  name: id,
  version_number: '1.0.0',
  version_type: 'release',
  status: 'listed',
  environment: 'server_only',
  loaders: ['paper'],
  game_versions: ['26.3'],
  date_published: '2026-09-10T12:00:00Z',
  downloads: 5,
  dependencies: dependsOn.map((dependency) => ({ version_id: dependency, dependency_type: 'required' })),
  files: [
    {
      url: `https://cdn.modrinth.com/data/${projectId}/versions/${id}/${id}.jar`,
      filename: `${id}.jar`,
      hashes: { sha512: id.padEnd(128, 'a'), sha1: 'b'.repeat(40) },
      primary: true,
      size: 1000,
    },
  ],
})

const project = (id: string) => ({
  id,
  slug: id.toLowerCase(),
  title: id,
  description: '',
  categories: [],
  environment: ['server_only'],
  downloads: 1,
  game_versions: ['26.3'],
  icon_url: null,
  license: { id: 'MIT', name: '', url: null },
  loaders: ['paper'],
  status: 'approved',
})

/** An in-memory Modrinth that answers a little later, so reads asked together overlap. */
function modrinth(
  routes: (url: URL) => Response | Promise<Response>,
  options: Omit<ModrinthClientOptions, 'fetch'> = {},
) {
  const requests: string[] = []
  const logged: string[] = []
  const fetch = async (request: Request) => {
    const url = new URL(request.url)
    requests.push(`${url.pathname}${url.search}`)
    await Bun.sleep(5)
    return routes(url)
  }
  const catalog = new ModrinthCatalog(
    modrinthClient('cubepals/cubepals (test)', {
      fetch: fetch as never,
      maxWaitMs: 5,
      log: (line) => logged.push(line),
      ...options,
    }),
  )
  return { catalog, requests, logged }
}

/** A template's two plugins, one needing a library: what resolving it reads, as the mods service reads it. */
const TEMPLATE = ['BENTOBOX', 'AONEBLOCK']
async function resolveTemplate(catalog: ModrinthCatalog) {
  const target = { loaders: ['paper'], gameVersion: '26.3' }
  const fitting = await Promise.all(
    TEMPLATE.map(async (projectId) => {
      const [found, versions] = await Promise.all([
        catalog.project(projectId),
        catalog.versions(projectId, target),
      ])
      return { found, versions }
    }),
  )
  const needed = fitting.flatMap(({ versions }) =>
    versions.flatMap((v) => v.dependencies.flatMap((d) => (d.versionId === null ? [] : [d.versionId]))),
  )
  return { fitting, libraries: await catalog.versionsByIds(needed) }
}

const routes = (url: URL): Response => {
  const [, , kind, id, tail] = url.pathname.split('/')
  if (kind === 'project' && tail === 'version')
    return Response.json([version(`${id}-V1`, id ?? '', id === 'AONEBLOCK' ? ['LIBRARY-V1'] : [])])
  if (kind === 'project') return Response.json(project(id ?? ''))
  if (kind === 'versions') return Response.json([version('LIBRARY-V1', 'LIBRARY')])
  return new Response('', { status: 404 })
}

describe('the Modrinth client', () => {
  test('50 creates of one template at once make one set of Modrinth reads', async () => {
    const { catalog, requests } = modrinth(routes)
    const resolved = await Promise.all(Array.from({ length: 50 }, () => resolveTemplate(catalog)))
    // Two projects and their versions, then the library they need: five reads for all 50.
    expect(requests).toHaveLength(5)
    expect(new Set(requests).size).toBe(5)
    for (const each of resolved) {
      expect(each.fitting.map(({ found }) => found?.projectId)).toEqual(TEMPLATE)
      expect([...each.libraries.keys()]).toEqual(['LIBRARY-V1'])
    }
    // One made a moment later is answered from what the others read.
    await resolveTemplate(catalog)
    expect(requests).toHaveLength(5)
  })

  test('an answer is shared only for its lifetime', async () => {
    const { catalog, requests } = modrinth(routes, { shareMs: 20 })
    await catalog.project('BENTOBOX')
    await catalog.project('BENTOBOX')
    expect(requests).toHaveLength(1)
    await Bun.sleep(30)
    await catalog.project('BENTOBOX')
    expect(requests).toHaveLength(2)
  })

  test('an answer Modrinth says not to keep is asked for again', async () => {
    const { catalog, requests } = modrinth((url) => {
      const answer = routes(url)
      answer.headers.set('cache-control', 'no-store')
      return answer
    })
    await catalog.project('BENTOBOX')
    await catalog.project('BENTOBOX')
    expect(requests).toHaveLength(2)
  })

  test('an outage is shared by the reads waiting on it, and not kept', async () => {
    let down = true
    const { catalog, requests } = modrinth((url) => (down ? new Response('', { status: 503 }) : routes(url)))
    const reads = await Promise.allSettled(Array.from({ length: 10 }, () => catalog.project('BENTOBOX')))
    expect(
      reads.every((read) => read.status === 'rejected' && read.reason instanceof CatalogUnavailable),
    ).toBe(true)
    expect(requests).toHaveLength(3)
    down = false
    expect(await catalog.project('BENTOBOX')).toMatchObject({ projectId: 'BENTOBOX' })
    expect(requests).toHaveLength(4)
  })

  test('a 429 is waited out for as long as its Retry-After says', async () => {
    let calls = 0
    const { catalog, logged } = modrinth(
      (url) =>
        ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0.1' } }) : routes(url),
      { maxWaitMs: 1000 },
    )
    const started = performance.now()
    expect(await catalog.project('BENTOBOX')).toMatchObject({ projectId: 'BENTOBOX' })
    expect(performance.now() - started).toBeGreaterThanOrEqual(100)
    expect(calls).toBe(2)
    expect(logged).toEqual([])
  })

  test('a Retry-After longer than a create may wait gives up at once, and says why', async () => {
    let calls = 0
    const { catalog, logged } = modrinth(
      () => {
        calls++
        return new Response('', {
          status: 429,
          headers: { 'retry-after': '30', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '30' },
        })
      },
      { maxWaitMs: 1000 },
    )
    const started = performance.now()
    await expect(catalog.project('BENTOBOX')).rejects.toBeInstanceOf(CatalogUnavailable)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(calls).toBe(1)
    expect(logged).toEqual([
      'modrinth: GET /v2/project/BENTOBOX gave up after 1 try: 429 (retry-after 30, x-ratelimit-remaining 0, x-ratelimit-reset 30)',
    ])
  })

  test('a read that gives up says what Modrinth answered, and how many tries it took', async () => {
    const down = modrinth(() => new Response('', { status: 503, headers: { 'cf-ray': 'abc-ORD' } }))
    await expect(down.catalog.version('V1')).rejects.toBeInstanceOf(CatalogUnavailable)
    expect(down.logged).toEqual(['modrinth: GET /v2/version/V1 gave up after 3 tries: 503 (cf-ray abc-ORD)'])

    const unreachable = modrinth(() => {
      throw new TypeError('fetch failed')
    })
    await expect(unreachable.catalog.version('V1')).rejects.toBeInstanceOf(CatalogUnavailable)
    expect(unreachable.logged).toEqual(['modrinth: GET /v2/version/V1 gave up after 3 tries: fetch failed'])
  })
})

describe('SharedReads', () => {
  test('keeps no more bytes than it may, forgetting the oldest first', async () => {
    const shared = new SharedReads({ lifetimeMs: MINUTE_MS, maxBytes: 10 })
    let sent = 0
    const send = async () => {
      sent++
      return new Response('12345')
    }
    const read = (path: string) => shared.read(new Request(`https://api.test/${path}`), send)
    await read('a')
    await read('b')
    await read('a')
    expect(sent).toBe(2)
    // c pushes out b, the oldest since a was read again.
    await read('c')
    await read('a')
    expect(sent).toBe(3)
    expect(await (await read('b')).text()).toBe('12345')
    expect(sent).toBe(4)
  })

  test('sends anything but a GET every time', async () => {
    const shared = new SharedReads({ lifetimeMs: MINUTE_MS, maxBytes: 1000 })
    let sent = 0
    const send = async () => {
      sent++
      return Response.json({})
    }
    const lookup = () => new Request('https://api.test/version_files', { method: 'POST', body: '{}' })
    await shared.read(lookup(), send)
    await shared.read(lookup(), send)
    expect(sent).toBe(2)
  })
})
