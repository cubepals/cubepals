import { describe, expect, test } from 'bun:test'
import { LoaderBuildsUnavailable } from '../../app/ports/loaders.ts'
import { UpstreamLoaderBuilds } from './loader-builds.ts'

// Shaped like what each service answered on 2026-09-19, trimmed to the fields read.
const ANSWERS: Record<string, { status: number; body: unknown }> = {
  'meta.fabricmc.net/v2/versions/loader/1.21.8': {
    status: 200,
    body: [
      { loader: { version: '0.19.6-beta.1', stable: false } },
      { loader: { version: '0.19.5', stable: true } },
      { loader: { version: '0.19.4', stable: false } },
    ],
  },
  'meta.fabricmc.net/v2/versions/loader/9.9.9': { status: 400, body: [] },
  // Quilt's list for a version isn't in release order, and its newest loaders are betas.
  'meta.quiltmc.org/v3/versions/loader/1.21.8': {
    status: 200,
    body: ['0.20.0-beta.9', '0.29.2', '0.31.0-beta.4', '0.30.1', '0.30.1-beta.4'].map((version) => ({
      loader: { version },
    })),
  },
  'meta.quiltmc.org/v3/versions/loader/26.3': { status: 404, body: { code: 'not_found' } },
  'fill.papermc.io/v3/projects/paper/versions/1.21.8/builds': {
    status: 200,
    body: [
      { id: 61, channel: 'BETA' },
      { id: 60, channel: 'STABLE' },
      { id: 59, channel: 'STABLE' },
    ],
  },
  'fill.papermc.io/v3/projects/paper/versions/26.3/builds': {
    status: 200,
    body: [{ id: 24, channel: 'ALPHA' }],
  },
  'files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json': {
    status: 200,
    body: {
      homepage: 'https://files.minecraftforge.net/net/minecraftforge/forge/',
      promos: { '1.21.8-latest': '58.1.22', '1.21.8-recommended': '58.1.0', '26.3-latest': '66.0.0' },
    },
  },
  'maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge': {
    status: 200,
    body: {
      isSnapshot: false,
      versions: [
        '0.25w14craftmine.3-beta',
        '21.8.52',
        '21.8.54',
        '21.10.62-beta',
        '21.10.64',
        '26.1.2.109',
        '26.2.0.88',
        '26.3.0.6-beta',
      ],
    },
  },
}

function fakeFetch(answers = ANSWERS) {
  const asked: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    asked.push(`${url.host}${url.pathname}`)
    expect(new Headers(init?.headers).get('user-agent')).toContain('blockly')
    const answer = answers[`${url.host}${url.pathname}`]
    if (!answer) return new Response('not here', { status: 599 })
    return Response.json(answer.body, { status: answer.status })
  }) as typeof globalThis.fetch
  return { fetch, asked }
}

describe('UpstreamLoaderBuilds', () => {
  test('pins what each server type calls its current build for a game version', async () => {
    const builds = new UpstreamLoaderBuilds({ fetch: fakeFetch().fetch })
    expect(await builds.current('fabric', '1.21.8')).toBe('0.19.5')
    expect(await builds.current('quilt', '1.21.8')).toBe('0.30.1')
    expect(await builds.current('paper', '1.21.8')).toBe('60')
    expect(await builds.current('forge', '1.21.8')).toBe('58.1.0')
    expect(await builds.current('neoforge', '1.21.8')).toBe('21.8.54')
    expect(await builds.current('neoforge', '1.21.10')).toBe('21.10.64')
    expect(await builds.current('neoforge', '26.1.2')).toBe('26.1.2.109')
    expect(await builds.current('neoforge', '26.2')).toBe('26.2.0.88')
  })

  test('a version with no stable build pins nothing', async () => {
    const builds = new UpstreamLoaderBuilds({ fetch: fakeFetch().fetch })
    expect(await builds.current('fabric', '9.9.9')).toBeNull()
    expect(await builds.current('quilt', '26.3')).toBeNull()
    expect(await builds.current('paper', '26.3')).toBeNull()
    // Forge's latest isn't recommended, and NeoForge's only builds are betas.
    expect(await builds.current('forge', '26.3')).toBeNull()
    expect(await builds.current('neoforge', '26.3')).toBeNull()
  })

  test('a service that is down, or answers in a new shape, pins nothing and says which', async () => {
    const down = new UpstreamLoaderBuilds({
      fetch: fakeFetch({
        'meta.fabricmc.net/v2/versions/loader/1.21.8': { status: 503, body: {} },
        'fill.papermc.io/v3/projects/paper/versions/1.21.8/builds': { status: 200, body: { builds: [] } },
      }).fetch,
    })
    await expect(down.current('fabric', '1.21.8')).rejects.toBeInstanceOf(LoaderBuildsUnavailable)
    await expect(down.current('paper', '1.21.8')).rejects.toThrow('paper build list unavailable')
    const unreachable = new UpstreamLoaderBuilds({
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    await expect(unreachable.current('forge', '1.21.8')).rejects.toThrow(
      'forge build list unavailable: fetch failed',
    )
  })

  test('a list is read once for a while', async () => {
    const { fetch, asked } = fakeFetch()
    const builds = new UpstreamLoaderBuilds({ fetch })
    await builds.current('forge', '1.21.8')
    await builds.current('forge', '1.21.10')
    await builds.current('paper', '26.3')
    await builds.current('paper', '26.3')
    expect(asked).toEqual([
      'files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
      'fill.papermc.io/v3/projects/paper/versions/26.3/builds',
    ])
  })
})
