// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { CatalogFile, ModEnvironment } from '../../domain/mods/catalog.ts'
import { isPackKey, isReleaseVersion } from '../../domain/mods/curation.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { fabricJar } from '../../testing/uploads.ts'
import type { Actor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'
import { neededByPlayers, OWN_PACKS, type OwnPack, ownGameVersion, ownOrder, ownRelease } from './own.ts'
import { CURATED_PACKS } from './packs.ts'
import { loadReleases } from './persistence.ts'

// Blockly's own packs (docs/modpack-templates.md § Blockly's own packs): the review is well formed,
// and a list becomes a release only once every mod in it is checked, as any curated pack's are.
describe('the review of Blockly’s own packs', () => {
  test('every pack has a key no other pack uses, and a review written up', async () => {
    const keys = [...OWN_PACKS, ...CURATED_PACKS].map((pack) => pack.key)
    expect(new Set(keys).size).toBe(keys.length)
    const doc = await Bun.file(new URL('../../../../../docs/modpack-templates.md', import.meta.url)).text()
    for (const pack of OWN_PACKS) {
      expect(isPackKey(pack.key)).toBe(true)
      expect(pack.review).toBe(`docs/modpack-templates.md#${pack.key}`)
      expect(doc).toContain(`<a id="${pack.key}"></a>`)
      expect(pack.mods.length).toBeGreaterThan(0)
      const projects = pack.mods.map((mod) => mod.projectId)
      expect(new Set(projects).size).toBe(projects.length)
    }
  })

  test('each pack is described as what playing it is, in a person’s words', () => {
    for (const pack of OWN_PACKS) {
      expect(pack.blurb).toMatch(/^[A-Z].+\.$/)
      expect(pack.blurb.length).toBeLessThanOrEqual(80)
      for (const word of ['loader', 'fabric', 'forge', 'modrinth', 'mod ', 'mods', 'ram', 'gb'])
        expect(pack.blurb.toLowerCase()).not.toContain(word)
    }
  })

  test('a release is named for its day and its Minecraft, and releases go newest Minecraft first', () => {
    const version = ownRelease(new Date('2026-09-28T13:00:00Z'), '26.1.2')
    expect(version).toBe('2026.09.28+26.1.2')
    expect(isReleaseVersion(version)).toBe(true)
    expect(ownGameVersion(version)).toBe('26.1.2')
    expect(ownGameVersion('1.0')).toBeNull()
    expect(
      ownOrder(['2026.09.28+1.21.1', '2026.10.02+26.3', '2026.09.28+26.1.2', '2026.09.30+26.1.2']),
    ).toEqual(['2026.10.02+26.3', '2026.09.30+26.1.2', '2026.09.28+26.1.2', '2026.09.28+1.21.1'])
  })

  test('a library marked for both sides is needed by players only when something they need asks for it', () => {
    const mod = (name: string, environment: 'server' | 'optional' | 'both', requiredBy: string[] = []) => ({
      name,
      environment,
      origin: requiredBy.length > 0 ? ('dependency' as const) : ('user' as const),
      requiredBy,
    })
    // YUNG's API: marked for both, asked for only by structure mods that run on the server alone.
    const structures = [
      mod('Better Dungeons', 'server'),
      mod('Better Strongholds', 'server'),
      mod('YUNG’s API', 'both', ['Better Dungeons', 'Better Strongholds']),
      mod('Cloth Config', 'optional', ['Better Dungeons']),
    ]
    expect(neededByPlayers(structures)).toEqual([])
    // A mod that is itself for both sides is needed, and so is what it needs.
    const furniture = [mod('Furniture', 'both'), mod('Its library', 'both', ['Furniture'])]
    expect(neededByPlayers(furniture).map((m) => m.name)).toEqual(['Furniture', 'Its library'])
    // Down a chain: a library of a library of server mods stays on the server.
    const chain = [
      mod('Graves', 'server'),
      mod('Polymer', 'both', ['Graves']),
      mod('API', 'both', ['Polymer']),
    ]
    expect(neededByPlayers(chain)).toEqual([])
  })
})

const admin: Actor = { kind: 'admin', userId: 'curator' }

/**
 * A harness with a CDN and an archive store, whose review of Blockly's own packs each test adds to,
 * and the ways those tests publish mods, list packs and check them.
 */
function ownPacks() {
  let h: Harness | undefined
  const cdn = new Cdn()
  const store = new MemoryStore()
  const own: OwnPack[] = []

  beforeAll(async () => {
    await cdn.start()
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null }, ownPacks: own })
  }, 30_000)

  afterAll(async () => {
    await h?.close()
    store.close()
    cdn.close()
  })

  /** A mod its author published for one Minecraft, under a licence, served from the CDN. */
  const publishMod = (
    id: string,
    licence: string,
    gameVersion: string,
    options: { side?: ModEnvironment; needs?: string[] } = {},
  ): CatalogFile => {
    const file = cdn.file(`${id}-${gameVersion}`, fabricJar(id, { depends: { minecraft: gameVersion } }))
    const side = options.side ?? 'server_only'
    harness().catalog.publish(
      {
        projectId: `${id}-project`,
        slug: id,
        name: `Mod ${id}`,
        summary: '',
        iconUrl: null,
        environments: [side],
        downloads: 1,
        licence,
      },
      [
        {
          versionId: `${id}-${gameVersion}`,
          projectId: `${id}-project`,
          versionLabel: `1.0+${gameVersion}`,
          channel: 'release',
          state: 'listed',
          environment: side,
          loaders: ['fabric'],
          gameVersions: [gameVersion],
          publishedAt: new Date(Date.UTC(2026, 0, 1)),
          file,
          dependencies: (options.needs ?? []).map((need) => ({
            projectId: `${need}-project`,
            versionId: null,
            kind: 'required' as const,
          })),
        },
      ],
    )
    return file
  }

  const ownList = (
    key: string,
    ids: string[],
    review: Pick<OwnPack, 'playersInstall' | 'held'> = {},
  ): OwnPack => {
    const pack: OwnPack = {
      key,
      name: `Own ${key}`,
      blurb: 'A pack for tests.',
      authors: 'Cubepals',
      loader: 'fabric',
      mods: ids.map((id) => ({ catalog: 'modrinth', projectId: `${id}-project` })),
      review: `docs/modpack-templates.md#${key}`,
      ...review,
    }
    own.push(pack)
    return pack
  }

  /** Puts together what is due, checks every release of the pack that is pending, and returns them. */
  const checked = async (key: string) => {
    await harness().app.curation.queueDue()
    for (const release of await loadReleases(harness().db, [key]))
      if (release.state === 'pending') await harness().app.curation.ingest(release)
    return loadReleases(harness().db, [key])
  }

  const harness = (): Harness => {
    if (h === undefined) throw new Error('the harness hasn’t started')
    return h
  }

  return { harness, cdn, store, publishMod, ownList, checked }
}

describe.skipIf(!hasDatabase)('Blockly’s own packs', () => {
  const { harness, cdn, store, publishMod, ownList, checked } = ownPacks()

  test('a list becomes a release on the newest Minecraft all of it runs on, checked, offered, and installed from its authors', async () => {
    publishMod('lib', 'MIT', '1.21.1', { side: 'client_and_server' })
    const graves = publishMod('graves', 'LGPL-3.0-only', '1.21.1', { needs: ['lib'] })
    const perf = publishMod('perf', 'MIT', '1.21.1', { side: 'client_or_server' })
    ownList('easy', ['graves', 'perf'])

    const [release] = await checked('easy')
    if (release === undefined) throw new Error('no release was put together')
    // Nothing newer than 1.21.1 runs every mod of it, so that is the Minecraft it plays.
    expect(release.version).toBe(ownRelease(new Date(), '1.21.1'))
    expect(release.state).toBe('verified')
    expect(release.distribution).toBe('upstream')
    expect(release.pack?.artifact.ref.kind).toBe('stored')
    expect(release.pack?.environment).toBe('server')
    expect(release.pack?.curated).toEqual({ key: 'easy', version: release.version })
    expect(release.facts?.upstream).toBeNull()
    expect(release.facts?.playersNeedIt).toBe(false)
    expect(release.facts?.checked).toEqual({ files: 3, bytes: expect.any(Number), hosts: ['127.0.0.1'] })
    expect(release.facts?.licences.map((l) => [l.name, l.kind])).toEqual([
      ['Own easy', 'copyleft'],
      ['Mod graves', 'copyleft'],
      ['Mod lib', 'open'],
      ['Mod perf', 'open'],
    ])
    // Blockly kept its own index and nothing of anyone else's.
    expect(store.objects.size).toBe(1)

    // Nothing new to put together while the same Minecraft is the newest it runs on.
    await harness().app.curation.queueDue()
    expect((await loadReleases(harness().db, ['easy'])).length).toBe(1)

    // Verified is not offered: an admin says so first.
    expect(await harness().app.curation.offered()).toEqual([])
    await harness().app.curation.publish(admin, { key: 'easy', version: release.version })
    const owner = await harness().user('Pat', 'plus')
    const options = await harness().app.queries.createOptions(owner)
    expect(options.packs.map((p) => [p.key, p.name, p.gameVersion, p.playersNeedIt, p.authors])).toEqual([
      ['easy', 'Own easy', '1.21.1', false, 'Cubepals'],
    ])

    // A server of it fetches every mod from where its authors publish it, and plain Minecraft joins.
    const before = cdn.downloads
    const server = await harness().create(owner, { from: { kind: 'curated', key: 'easy' } })
    await harness().until(server.id, 'running')
    await harness().settled(server.id)
    expect(cdn.downloads - before).toBe(3)
    expect(await harness().minecraft.file(server.id, `mods/${graves.fileName}`)).not.toBeNull()
    expect(await harness().minecraft.file(server.id, `mods/${perf.fileName}`)).not.toBeNull()
    const page = await harness().app.sharingQueries.page(server.slug, owner)
    expect(page?.needs).toEqual({ gameVersion: '1.21.1', modpack: null, loader: null, mods: [] })
    const list = await harness().app.modQueries.list(owner, server.id)
    expect(list.packUploaded).toBe(false)
    expect(list.packUpdate).toBeNull()

    // Its mods reach a newer Minecraft: a release is put together there, and once offered, the
    // server is offered it. Nothing moves by itself, and moving the world is its owner's choice.
    publishMod('lib', 'MIT', '26.3', { side: 'client_and_server' })
    publishMod('graves', 'LGPL-3.0-only', '26.3', { needs: ['lib'] })
    publishMod('perf', 'MIT', '26.3', { side: 'client_or_server' })
    const releases = await checked('easy')
    const newer = releases.find((r) => r.version === ownRelease(new Date(), '26.3'))
    if (newer === undefined) throw new Error('no newer release was put together')
    expect(newer.state).toBe('verified')
    await harness().app.curation.publish(admin, { key: 'easy', version: newer.version })
    expect((await harness().app.modQueries.list(owner, server.id)).packUpdate).toMatchObject({
      gameVersion: '26.3',
      movesWorld: true,
      release: newer.version,
    })
    const pinned = (await loadRevision(harness().db, (await harness().server(server.id)).desiredRevisionId))
      .modpack
    expect(pinned?.curated).toEqual({ key: 'easy', version: release.version })
    expect((await harness().app.queries.createOptions(owner)).packs.map((p) => p.gameVersion)).toEqual([
      '26.3',
    ])
    const view = await harness().app.curation.review(admin)
    expect(view.find((p) => p.key === 'easy')?.releases.map((r) => r.version)).toEqual([
      newer.version,
      release.version,
    ])
  }, 90_000)

  test('a release that would need anything of players, or anything not openly licensed, is refused', async () => {
    publishMod('furniture', 'MIT', '1.21.1', { side: 'client_and_server' })
    ownList('needs-players', ['furniture'])
    const [asks] = await checked('needs-players')
    expect(asks?.state).toBe('refused')
    expect(asks?.refusal).toBe('Players would need Mod furniture in their own games to join.')

    publishMod('closed', 'LicenseRef-All-Rights-Reserved', '1.21.1')
    ownList('closed', ['closed'])
    expect((await checked('closed'))[0]?.refusal).toContain('all rights reserved: Mod closed')

    // A refused release waits for an admin: nothing is put together again under it by itself.
    await harness().app.curation.queueDue()
    expect((await loadReleases(harness().db, ['closed'])).map((r) => r.state)).toEqual(['refused'])
  })
})

describe.skipIf(!hasDatabase)('Blockly’s own packs players install', () => {
  const { harness, publishMod, ownList, checked } = ownPacks()

  test('a pack players install is checked as one, and an invite names the release they need', async () => {
    publishMod('creatures', 'MPL-2.0', '1.21.1', { side: 'client_and_server' })
    publishMod('tidy', 'MIT', '1.21.1')
    ownList('creatures', ['creatures', 'tidy'], { playersInstall: true })

    const [release] = await checked('creatures')
    if (release === undefined) throw new Error('no release was put together')
    expect(release.state).toBe('verified')
    expect(release.pack?.environment).toBe('both')
    expect(release.facts?.playersNeedIt).toBe(true)

    await harness().app.curation.publish(admin, { key: 'creatures', version: release.version })
    const owner = await harness().user('Robin', 'plus')
    const server = await harness().create(owner, { from: { kind: 'curated', key: 'creatures' } })
    await harness().until(server.id, 'running')
    await harness().settled(server.id)
    const page = await harness().app.sharingQueries.page(server.slug, owner)
    expect(page?.needs.modpack).toMatchObject({ name: 'Own creatures', version: release.version })
  }, 90_000)

  test('a held pack is checked, and no admin can offer it', async () => {
    publishMod('held', 'MIT', '1.21.1')
    ownList('held', ['held'], { held: 'Not yet.' })
    const [release] = await checked('held')
    expect(release?.state).toBe('verified')
    await expect(
      harness().app.curation.publish(admin, { key: 'held', version: release?.version ?? '' }),
    ).rejects.toThrow('Not yet.')
  })
})
