// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Catalog checks read reviewed bytes from the real local CDN and open actual archives. */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECOND_MS } from '@blockly/contracts/durations'
import { strFromU8, unzipSync } from 'fflate'
import { checkCatalogRelease } from '../../app/curation/catalog-check.ts'
import { Refused } from '../../app/curation/check-outcome.ts'
import type { CuratedPack } from '../../app/curation/packs.ts'
import { PackContents } from '../../app/packs/contents.ts'
import { licenceKind } from '../../domain/mods/curation.ts'
import { INDEX_FILE } from '../../minecraft/mrpack.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import { LibraryFileFormats } from './file-formats.ts'
import { LibraryPackArchives } from './pack-archives.ts'

type Mode =
  | 'normal'
  | 'mirror'
  | 'archived'
  | 'missing-version'
  | 'wrong-project'
  | 'different-hash'
  | 'different-size'
  | 'withheld-project'
  | 'forbidden-host'
  | 'different-served-bytes'
  | 'unsafe'
  | 'missing-index'
  | 'wrong-game'
  | 'no-loader'
  | 'pin-refused'
function archiveBytes(mode: Mode) {
  if (mode === 'unsafe') return utf8('This is not an archive')
  if (mode === 'missing-index') return zipBytes({ 'readme.txt': utf8('No pack index') })
  return zipBytes({
    [INDEX_FILE]: utf8(
      JSON.stringify({
        formatVersion: 1,
        game: mode === 'wrong-game' ? 'another-game' : 'minecraft',
        versionId: '1.0',
        name: 'Fixture pack',
        files: [],
        dependencies:
          mode === 'no-loader' ? { minecraft: '26.2' } : { minecraft: '26.2', 'fabric-loader': '0.16.14' },
      }),
    ),
    'overrides/config/fixture.toml': utf8('feature = true\n'),
  })
}
function reviewed(h: Harness, cdn: Cdn, mode: Mode) {
  const bytes = archiveBytes(mode),
    file = cdn.file('reviewed-pack', bytes)
  const project = {
    projectId: 'reviewed-pack',
    slug: 'reviewed-pack',
    name: 'Fixture pack',
    summary: 'A synthetic pack',
    iconUrl: null,
    environments: ['client_and_server'] as const,
    downloads: 1,
    categories: [],
    licence: 'MIT',
  }
  const version = {
    versionId: 'reviewed-pack-1',
    projectId: project.projectId,
    versionLabel: '1.0',
    channel: 'release' as const,
    state: 'listed' as const,
    environment: 'client_and_server' as const,
    loaders: ['fabric'],
    gameVersions: ['26.2'],
    publishedAt: new Date(),
    file,
    dependencies: [],
  }
  h.catalog.publishModpack({ ...project, environments: [...project.environments] }, [version])
  const spec = {
    version: '1.0',
    versionId: version.versionId,
    sha512: file.sha512,
    sizeBytes: file.sizeBytes,
  }
  const pack: CuratedPack = {
    key: 'provenance-fixture',
    name: project.name,
    blurb: 'A fixture',
    authors: 'Fixture authors',
    source: { catalog: h.catalog.id, projectId: project.projectId },
    distribution: mode === 'mirror' ? 'mirror' : 'upstream',
    readings: [],
    permissions: [],
    authored: [],
    review: 'records:fixture.md#provenance',
    releases: [spec],
  }
  switch (mode) {
    case 'missing-version':
      h.catalog.setVersionState(version.versionId, 'absent')
      break
    case 'wrong-project':
      h.catalog.publishModpack({ ...project, environments: [...project.environments] }, [
        { ...version, projectId: 'another-project' },
      ])
      break
    case 'different-hash':
      spec.sha512 = createHash('sha512').update('another reviewed file').digest('hex')
      break
    case 'different-size':
      spec.sizeBytes++
      break
    case 'archived':
      h.catalog.setProjectState(project.projectId, 'archived')
      break
    case 'withheld-project':
      h.catalog.setProjectState(project.projectId, 'withheld')
      break
    case 'forbidden-host':
      h.catalog.allowDownloadsFrom([])
      break
    case 'different-served-bytes': {
      const different = Buffer.from(bytes)
      different[0] = (different[0] ?? 0) ^ 1
      cdn.files.set(new URL(file.url).pathname, different)
      break
    }
  }
  return { pack, spec, file }
}
async function fixture(mode: Mode) {
  const cdn = new Cdn(),
    store = new MemoryStore()
  await cdn.start()
  await store.start()
  const h = await startHarness({ capabilities: { archives: store, billing: null } })
  const work = await mkdtemp(join(tmpdir(), 'catalog-provenance-'))
  const formats = new LibraryFileFormats()
  const values = reviewed(h, cdn, mode)
  return {
    h,
    store,
    work,
    ...values,
    deps: {
      catalog: h.catalog,
      archives: new LibraryPackArchives(),
      formats,
      contents: new PackContents({ db: h.db, formats, catalog: h.catalog, jarChecks: h.app.jarChecks }),
      capabilities: { archives: mode === 'mirror' ? store : null },
      pin: async (projectId: string, versionId: string) => {
        if (mode === 'pin-refused') {
          const project = await h.catalog.project(projectId)
          if (!project) throw new Error('The reviewed project must exist before the pin')
          // The publisher changes its audience after provenance was checked.
          h.catalog.publish({ ...project, environments: ['client_only'] }, [])
        }
        return h.app.setups.pinnedPack(projectId, versionId)
      },
    },
    async close() {
      await h.close()
      store.close()
      cdn.close()
      await rm(work, { recursive: true, force: true })
    },
  }
}
async function accepted(mode: 'normal' | 'archived' | 'mirror') {
  const f = await fixture(mode)
  try {
    const before = Date.now()
    const result = await checkCatalogRelease(f.deps, f.pack, f.spec, f.work)
    const pinned = await f.h.app.setups.pinnedPack(f.pack.source.projectId, f.spec.versionId)
    expect(result.distribution).toBe(mode === 'mirror' ? 'mirror' : 'upstream')
    expect(result.pack.curated).toEqual({ key: f.pack.key, version: f.spec.version })
    expect(result.facts).toMatchObject({
      gameVersion: pinned.gameVersion,
      loader: pinned.loader,
      loaderVersion: pinned.loaderVersion,
      tier: pinned.tier,
      playersNeedIt: true,
      mods: 0,
      jarBytes: 0,
      notes: pinned.notes,
      checked: { files: 0, bytes: 0, hosts: [] },
      code: [],
      licences: [
        { name: f.pack.name, project: f.pack.source.projectId, licence: 'MIT', kind: licenceKind('MIT') },
      ],
      mirrorBlockers: [],
    })
    expect(result.facts.upstream).toEqual({
      catalog: f.h.catalog.id,
      projectId: f.pack.source.projectId,
      versionId: f.spec.versionId,
      sha512: f.spec.sha512,
      sizeBytes: f.spec.sizeBytes,
      fileName: f.file.fileName,
      fetchedAt: expect.any(String),
    })
    const fetched = Date.parse(result.facts.upstream?.fetchedAt ?? '')
    expect(fetched).toBeGreaterThanOrEqual(before)
    expect(fetched).toBeLessThanOrEqual(Date.now())
    expect(result.forPlayers).toEqual([])
    if (mode !== 'mirror') {
      expect(result.pack).toEqual({ ...pinned.pinned, curated: { key: f.pack.key, version: f.spec.version } })
      expect(result.stored).toBeNull()
      expect(result.contents).toBeNull()
      expect(result.facts.obligations).toEqual([])
      return
    }
    if (!result.stored) throw new Error('A mirrored result must retain its stored bytes')
    const bytes = f.store.objects.get(result.stored.key)
    if (!bytes) throw new Error('The real archive adapter must retain the copy')
    expect(result.stored).toEqual({
      key: result.stored.key,
      sha512: createHash('sha512').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    })
    expect(result.pack.artifact.sha512).toBe(result.stored.sha512)
    expect(result.pack.artifact.ref).toEqual({ kind: 'stored', key: result.stored.key })
    expect(result.contents?.sha512).toBe(result.stored.sha512)
    expect(result.facts.obligations.length).toBeGreaterThan(0)
    const files = unzipSync(bytes)
    expect(JSON.parse(strFromU8(files[INDEX_FILE] ?? new Uint8Array())).files).toEqual([])
    expect(strFromU8(files['overrides/config/fixture.toml'] ?? new Uint8Array())).toBe('feature = true\n')
    expect(Object.keys(files).some((name) => /notices/i.test(name))).toBe(true)
  } finally {
    await f.close()
  }
}
const refusalWords: Partial<Record<Mode, RegExp>> = {
  'missing-version': /no longer publish/,
  'wrong-project': /another project/,
  'different-hash': /different bytes under/,
  'different-size': /different bytes under/,
  'withheld-project': /project isn’t published/,
  'forbidden-host': /published somewhere/,
  'different-served-bytes': /site served isn’t/,
  unsafe: /open safely/,
  'missing-index': /no Modrinth index/,
  'wrong-game': /Modrinth format/,
  'no-loader': /no mod loader/,
  'pin-refused': /player's own game/,
}
async function refused(mode: Mode) {
  const f = await fixture(mode)
  try {
    const error = await checkCatalogRelease(f.deps, f.pack, f.spec, f.work).then(
      () => {
        throw new Error('An unreviewed or unsafe release must be refused')
      },
      (error) => error,
    )
    expect(error).toBeInstanceOf(Refused)
    const words = refusalWords[mode]
    if (!words) throw new Error('Each refusal must identify the check that refused it')
    expect(error.message).toMatch(words)
    expect(error.detail.length).toBeGreaterThan(0)
    expect(f.store.objects.size).toBe(0)
  } finally {
    await f.close()
  }
}
describe.skipIf(!hasDatabase)('catalog release provenance through real files', () => {
  for (const mode of ['normal', 'archived', 'mirror'] as const)
    test(`a ${mode} release retains its reviewed facts and bytes`, () => accepted(mode), 30 * SECOND_MS)
  for (const mode of [
    'missing-version',
    'wrong-project',
    'different-hash',
    'different-size',
    'withheld-project',
    'forbidden-host',
    'different-served-bytes',
    'unsafe',
    'missing-index',
    'wrong-game',
    'no-loader',
    'pin-refused',
  ] as const)
    test(`a ${mode} release is refused before anything is stored`, () => refused(mode), 30 * SECOND_MS)
})
