// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Ingestion ignores releases removed from review and releases that are no longer pending. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { fabricJar, utf8, zipBytes } from '../../testing/uploads.ts'
import type { CuratedPack } from './packs.ts'
import { insertPending, loadRelease } from './persistence.ts'

let h: Harness
const cdn = new Cdn()
const store = new MemoryStore()
const review: CuratedPack[] = []
beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  await store.start()
  h = await startHarness({ capabilities: { archives: store, billing: null }, curatedPacks: review })
}, 30 * SECOND_MS)
afterAll(async () => {
  await h?.close()
  store.close()
  cdn.close()
})
interface Mod {
  id: string
  licence: string
  /** Where the pack's index says to download it from, when not the CDN. */
  url?: string
}

/** A pack published on the catalog, each mod published beside it and listed in its index. */
const publishPack = (key: string, mods: Mod[], licence = 'MIT'): CatalogVersion => {
  const files = mods.map((mod) => {
    const file = cdn.file(`${mod.id}-mod`, fabricJar(mod.id, { depends: { minecraft: '1.21.1' } }))
    h.catalog.publish(
      {
        projectId: `${mod.id}-project`,
        slug: mod.id,
        name: `Mod ${mod.id}`,
        summary: '',
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
        licence: mod.licence,
      },
      [
        {
          versionId: `${mod.id}-v1`,
          projectId: `${mod.id}-project`,
          versionLabel: '1.0',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['fabric'],
          gameVersions: ['1.21.1'],
          publishedAt: new Date(Date.UTC(2026, 0, 1)),
          file,
          dependencies: [],
        },
      ],
    )
    return { mod, file }
  })
  const pack = cdn.file(
    `${key}-1`,
    zipBytes({
      'modrinth.index.json': utf8(
        JSON.stringify({
          formatVersion: 1,
          game: 'minecraft',
          versionId: '1.0',
          name: `Pack ${key}`,
          files: files.map(({ mod, file }) => ({
            path: `mods/${mod.id}.jar`,
            hashes: { sha1: 'a'.repeat(40), sha512: file.sha512 },
            env: { client: 'required', server: 'required' },
            downloads: [mod.url ?? file.url],
            fileSize: file.sizeBytes,
          })),
          dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
        }),
      ),
      'overrides/config/pack.toml': utf8('release = 1\n'),
    }),
  )
  const version: CatalogVersion = {
    versionId: `${key}-v1`,
    projectId: `${key}-project`,
    versionLabel: '1.0',
    channel: 'release',
    state: 'listed',
    environment: 'client_and_server',
    loaders: ['fabric'],
    gameVersions: ['1.21.1'],
    publishedAt: new Date(Date.UTC(2026, 0, 1)),
    file: pack,
    dependencies: [],
  }
  h.catalog.publishModpack(
    {
      projectId: `${key}-project`,
      slug: key,
      name: `Pack ${key}`,
      summary: 'For tests',
      iconUrl: null,
      environments: ['client_and_server'],
      downloads: 1,
      categories: [],
      licence,
    },
    [version],
  )
  return version
}

const reviewed = (key: string, distribution: 'mirror' | 'upstream', version: CatalogVersion) => {
  const entry: CuratedPack = {
    key,
    name: `Pack ${key}`,
    blurb: 'A pack for tests.',
    authors: 'Test authors',
    source: { catalog: 'modrinth', projectId: `${key}-project` },
    distribution,
    readings: [],
    permissions: [],
    authored: [],
    review: `records:modpack-templates.md#${key}`,
    releases: [
      {
        version: version.versionLabel,
        versionId: version.versionId,
        sha512: version.file.sha512,
        sizeBytes: version.file.sizeBytes,
      },
    ],
  }
  review.push(entry)
  return entry
}

test.skipIf(!hasDatabase)('a removed review leaves its pending release untouched', async () => {
  const key = 'removed-review'
  await insertPending(h.db, key, '1.0')
  const downloads = cdn.downloads
  await h.app.curation.ingest({ key, version: '1.0' })
  expect((await loadRelease(h.db, key, '1.0'))?.state).toBe('pending')
  expect(cdn.downloads).toBe(downloads)
})

test.skipIf(!hasDatabase)('a removed version is not replaced by another reviewed version', async () => {
  const key = 'removed-version'
  const version = publishPack(key, [])
  const pack = reviewed(key, 'mirror', version)
  const spec = pack.releases[0]
  if (!spec) throw new Error('The reviewed release must exist')
  pack.releases = [{ ...spec, version: '2.0' }]
  await insertPending(h.db, key, '1.0')
  const downloads = cdn.downloads
  await h.app.curation.ingest({ key, version: '1.0' })
  expect((await loadRelease(h.db, key, '1.0'))?.state).toBe('pending')
  expect(cdn.downloads).toBe(downloads)
})

test.skipIf(!hasDatabase)(
  'absent and already verified releases are not downloaded again',
  async () => {
    const key = 'pending-only'
    reviewed(key, 'mirror', publishPack(key, []))
    const downloads = cdn.downloads
    await h.app.curation.ingest({ key, version: '1.0' })
    expect(await loadRelease(h.db, key, '1.0')).toBeNull()
    expect(cdn.downloads).toBe(downloads)
    await insertPending(h.db, key, '1.0')
    await h.app.curation.ingest({ key, version: '1.0' })
    const verified = await loadRelease(h.db, key, '1.0')
    expect(verified?.state).toBe('verified')
    expect(cdn.downloads).toBeGreaterThan(downloads)
    const checked = cdn.downloads
    await h.app.curation.ingest({ key, version: '1.0' })
    expect(await loadRelease(h.db, key, '1.0')).toEqual(verified)
    expect(cdn.downloads).toBe(checked)
  },
  30 * SECOND_MS,
)
