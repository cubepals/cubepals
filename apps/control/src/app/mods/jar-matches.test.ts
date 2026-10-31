// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world's jars matched to Modrinth, through the real adapter on Modrinth's own answers, recorded
 * from api.modrinth.com on 2026-10-31 (`infra/modrinth/fixtures/`): `POST /v2/version_files` for
 * Tree Harvester's and Sodium's Fabric 26.3 jars and one no catalog has, and `GET /v2/versions` for
 * Ore Harvester's. Jars aren't kept in the repository, so each stands in by the digests Modrinth
 * gives its file. Ore Harvester's source is `.pw.toml` as Prism writes one for a mod it installed
 * (`Packwiz.cpp`, `V1::updateModIndex`), in `minecraft/instance-fixtures/prism-fabric-26.3/`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LibraryFileFormats } from '../../infra/formats/file-formats.ts'
import { modrinthClient } from '../../infra/modrinth/client.ts'
import versionFiles from '../../infra/modrinth/fixtures/version-files-life.json' with { type: 'json' }
import oreHarvester from '../../infra/modrinth/fixtures/versions-ore-harvester.json' with { type: 'json' }
import { ModrinthCatalog } from '../../infra/modrinth/modrinth-catalog.ts'
import { packwizMod } from '../../minecraft/pack-manifests.ts'
import { type BroughtJar, matchJars } from './jar-matches.ts'

const INSTANCE = join(import.meta.dir, '../../minecraft/instance-fixtures/prism-fabric-26.3')
const formats = new LibraryFileFormats()
const source = (name: string) =>
  packwizMod(formats.decode('toml', readFileSync(join(INSTANCE, 'minecraft/mods/.index', name), 'utf8')))

/** A jar standing in by the digests Modrinth published for it. */
const published = (fileName: string, sha512: string, sha1: string, name: string): BroughtJar => ({
  fileName,
  sha512,
  sha1,
  metadata: {
    format: 'fabric.mod.json',
    id: name.toLowerCase().replace(/ /g, ''),
    name,
    version: '1',
    loaders: ['fabric'],
    environment: 'both',
    gameVersions: [],
  },
})

const TREE_HARVESTER = published(
  'treeharvester-26.3.0-10.4.jar',
  '523b970b45e45be136972824a42e9e481327f88919d40175c641d5f682d9ad88a0eb1998ebcd229b2c06c03fbbb439f4b843246ea073cc3595f6c5af3e289c10',
  '426184686275b01079c95169dd31832c7f73dd33',
  'Tree Harvester',
)
const ORE_HARVESTER = published(
  'oreharvester-26.3.0-2.1.jar',
  'ca9028a338333c258456a767816949df4a9e97e25f9815a9db9fef5fdb33b9d51e0344b0a502edf1b7a781345844bd9ce7e8878ed081b3a8b5867fbe43e1c495',
  '8184e75569e1e0d23bdde10af497636f12c38084',
  'Ore Harvester',
)
const SODIUM = published(
  'sodium-fabric-0.9.3-beta.1+mc26.3.jar',
  '884a1ef0ce0e69d565d41a1359070a8d4f8589a086b565540defdb4741985053077dfd0f2a56898ce60510720a9f95dd8ba220a9a6340b6e0cf5cb12352e2419',
  '1e6aec741b4134258ba1d7d458bae96a2e8e187e',
  'Sodium',
)
/** A jar of the player's own, which no catalog publishes. */
const OWN = published('veinminer-1.0.jar', 'f'.repeat(128), 'e'.repeat(40), 'Vein Miner')

/** Modrinth's adapter on its recorded answers, and the requests it made. */
function recorded() {
  const asked: string[] = []
  const fetch = async (request: Request) => {
    const url = new URL(request.url)
    asked.push(`${request.method} ${url.pathname}${url.search}`)
    if (url.pathname.endsWith('/version_files')) {
      const { hashes } = (await request.json()) as { hashes: string[] }
      const known = versionFiles as Record<string, unknown>
      return Response.json(Object.fromEntries(hashes.flatMap((h) => (h in known ? [[h, known[h]]] : []))))
    }
    if (url.pathname.endsWith('/versions')) {
      const ids = JSON.parse(url.searchParams.get('ids') ?? '[]') as string[]
      return Response.json(oreHarvester.filter((version) => ids.includes(version.id)))
    }
    return new Response('', { status: 404 })
  }
  const catalog = new ModrinthCatalog(
    modrinthClient('cubepals/cubepals (test)', { fetch: fetch as never, maxWaitMs: 5, log: () => {} }),
  )
  return { catalog, asked }
}

describe('a world’s jars matched to Modrinth', () => {
  test('by the source Prism recorded, else by the jar’s bytes; one no catalog has is its owner’s', async () => {
    const { catalog, asked } = recorded()
    const ore = source('ore-harvester.pw.toml')
    if (ore === null) throw new Error('Unreadable source')
    const matches = await matchJars(catalog, [TREE_HARVESTER, ORE_HARVESTER, SODIUM, OWN], [ore])
    expect(
      matches.map((m) => ({
        name: m.name,
        kind: m.kind,
        ...(m.kind === 'catalog'
          ? { by: m.by, projectId: m.version.projectId, versionId: m.version.versionId }
          : {}),
        forPlayers: m.forPlayers,
      })),
    ).toEqual([
      {
        name: 'Tree Harvester',
        kind: 'catalog',
        by: 'hash',
        projectId: 'abooMhox',
        versionId: 'hKv1pACU',
        forPlayers: false,
      },
      {
        name: 'Ore Harvester',
        kind: 'catalog',
        by: 'source',
        projectId: 'Xiv4r347',
        versionId: 'GNL1u56u',
        forPlayers: false,
      },
      // Modrinth says Sodium runs only in players' games, whatever its jar says.
      {
        name: 'Sodium',
        kind: 'catalog',
        by: 'hash',
        projectId: 'AANobbMI',
        versionId: 'g6ju16VJ',
        forPlayers: true,
      },
      { name: 'Vein Miner', kind: 'own', forPlayers: false },
    ])
    // The recorded one is read by its version, and only the rest by their bytes.
    expect(asked).toEqual(['GET /v2/versions?ids=%5B%22GNL1u56u%22%5D', 'POST /v2/version_files'])
    // Collective, which Tree Harvester needs, comes from resolving it, not from this.
    const tree = matches[0]
    expect(tree?.kind === 'catalog' ? tree.version.dependencies : []).toEqual([
      { projectId: 'e0M1UDsY', versionId: null, kind: 'required' },
    ])
  })

  test('a source whose jar was replaced since is passed over for the bytes it is now', async () => {
    const { catalog, asked } = recorded()
    const ore = source('ore-harvester.pw.toml')
    if (ore === null) throw new Error('Unreadable source')
    const replaced = { ...OWN, fileName: ORE_HARVESTER.fileName }
    const [match] = await matchJars(catalog, [replaced], [ore])
    expect(match).toMatchObject({ kind: 'own', name: 'Vein Miner' })
    expect(asked).toEqual(['POST /v2/version_files'])
  })

  test('a jar its launcher marks for players’ games stays out where no catalog says otherwise', async () => {
    const { catalog } = recorded()
    const minimap = { ...OWN, fileName: 'minimap.jar' }
    const [match] = await matchJars(
      catalog,
      [minimap],
      [
        {
          name: 'A minimap',
          filename: 'minimap.jar',
          side: 'client',
          url: null,
          hash: null,
          modrinth: null,
          curseforge: null,
        },
      ],
    )
    expect(match).toMatchObject({ kind: 'own', forPlayers: true })
  })
})
