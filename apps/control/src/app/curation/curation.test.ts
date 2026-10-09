import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { CatalogFile, CatalogVersion } from '../../domain/mods/catalog.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { fabricJar, utf8, zipBytes } from '../../testing/uploads.ts'
import type { Actor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'
import type { CuratedPack } from './packs.ts'
import { loadRelease } from './persistence.ts'

// Packs Blockly offers by name (docs/modpack-templates.md), end to end on the stand-in runtime:
// only reviewed bytes get in, licences decide whether Blockly keeps a copy, an admin decides what
// is offered, and nothing a server plays ever changes under it.
describe.skipIf(!hasDatabase)('curated packs', () => {
  let h: Harness
  const cdn = new Cdn()
  const store = new MemoryStore()
  const review: CuratedPack[] = []
  const admin: Actor = { kind: 'admin', userId: 'curator' }

  beforeAll(async () => {
    await cdn.start()
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null }, curatedPacks: review })
  }, 30_000)

  afterAll(async () => {
    await h.close()
    store.close()
    cdn.close()
  })

  interface Mod {
    id: string
    licence: string
    side?: 'server_only' | 'client_only' | 'client_and_server'
  }

  /** A mod its author published on the catalog, under a licence, and served from the CDN. */
  const publishMod = (mod: Mod, gameVersion = '1.21.1'): CatalogFile => {
    const file = cdn.file(`${mod.id}-mod`, fabricJar(mod.id, { depends: { minecraft: gameVersion } }))
    h.catalog.publish(
      {
        projectId: `${mod.id}-project`,
        slug: mod.id,
        name: `Mod ${mod.id}`,
        summary: '',
        iconUrl: null,
        environments: [mod.side ?? 'server_only'],
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
          environment: mod.side ?? 'server_only',
          loaders: ['fabric'],
          gameVersions: [gameVersion],
          publishedAt: new Date(Date.UTC(2026, 0, 1)),
          file,
          dependencies: [],
        },
      ],
    )
    return file
  }

  /**
   * A pack published on the catalog: its index lists each mod at the CDN, and it carries a config.
   * Returns its catalog version, whose file is what a review pins.
   */
  const publishPack = (
    key: string,
    n: number,
    mods: Mod[],
    options: { licence?: string; overrides?: Record<string, Uint8Array> } = {},
  ): CatalogVersion => {
    const files = mods.map((mod) => ({ mod, file: publishMod(mod) }))
    const pack = cdn.file(
      `${key}-${n}`,
      zipBytes({
        'modrinth.index.json': utf8(
          JSON.stringify({
            formatVersion: 1,
            game: 'minecraft',
            versionId: `${n}.0`,
            name: `Pack ${key}`,
            files: files.map(({ mod, file }) => ({
              path: `mods/${mod.id}.jar`,
              hashes: { sha1: 'a'.repeat(40), sha512: file.sha512 },
              env: { client: 'required', server: 'required' },
              downloads: [file.url],
              fileSize: file.sizeBytes,
            })),
            dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
          }),
        ),
        'overrides/config/pack.toml': utf8(`release = ${n}\n`),
        ...options.overrides,
      }),
    )
    const version: CatalogVersion = {
      versionId: `${key}-v${n}`,
      projectId: `${key}-project`,
      versionLabel: `${n}.0`,
      channel: 'release',
      state: 'listed',
      environment: 'client_and_server',
      loaders: ['fabric'],
      gameVersions: ['1.21.1'],
      publishedAt: new Date(Date.UTC(2026, 0, n)),
      file: pack,
      dependencies: [],
    }
    const earlier = review.find((p) => p.key === key)?.releases ?? []
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
        licence: options.licence ?? 'MIT',
      },
      [version, ...earlier.map((r) => ({ ...version, versionId: r.versionId, versionLabel: r.version }))],
    )
    return version
  }

  /** The review of a pack, pinning the given versions, newest first. */
  const reviewed = (key: string, distribution: 'mirror' | 'upstream', ...versions: CatalogVersion[]) => {
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
      review: `docs/modpack-templates.md#${key}`,
      releases: versions.map((v) => ({
        version: v.versionLabel,
        versionId: v.versionId,
        sha512: v.file.sha512,
        sizeBytes: v.file.sizeBytes,
      })),
    }
    const at = review.findIndex((p) => p.key === key)
    if (at >= 0) review.splice(at, 1, entry)
    else review.push(entry)
    return entry
  }

  const checked = async (key: string, version: string) => {
    await h.app.curation.queueDue()
    await h.app.curation.ingest({ key, version })
    return loadRelease(h.db, key, version)
  }

  test('an open pack is kept as Blockly’s own copy, offered once an admin says so, and installs from it alone', async () => {
    const v1 = publishPack('open', 1, [
      { id: 'lithium', licence: 'LGPL-3.0-only' },
      { id: 'ferrite', licence: 'MIT' },
      // Only players need it: left out of servers, and never reviewed as something a server runs.
      { id: 'minimap', licence: 'LicenseRef-All-Rights-Reserved', side: 'client_only' },
    ])
    reviewed('open', 'mirror', v1)

    const release = await checked('open', '1.0')
    expect(release?.state).toBe('verified')
    expect(release?.distribution).toBe('mirror')
    expect(release?.pack?.artifact.ref.kind).toBe('stored')
    expect(release?.pack?.curated).toEqual({ key: 'open', version: '1.0' })
    // Players still get the pack from its authors, never from Blockly.
    expect(release?.pack?.publishedFile).toBe(v1.file.url)
    expect(release?.facts?.checked).toEqual({ files: 2, bytes: expect.any(Number), hosts: ['127.0.0.1'] })
    expect(release?.facts?.licences.map((l) => [l.name, l.kind])).toEqual([
      ['Pack open', 'open'],
      ['Mod lithium', 'copyleft'],
      ['Mod ferrite', 'open'],
    ])
    expect(release?.facts?.obligations.find((o) => o.name === 'Mod lithium')?.owes).toEqual([
      'notices',
      'source',
    ])

    // Verified is not offered: nobody sees it until an admin publishes it.
    expect(await h.app.curation.offered()).toEqual([])
    const owner = await h.user('Pat', 'plus')
    await expect(h.create(owner, { from: { kind: 'curated', key: 'open' } })).rejects.toThrow(/isn’t offered/)
    await h.app.curation.publish(admin, { key: 'open', version: '1.0' })
    const options = await h.app.queries.createOptions(owner)
    expect(options.packs.map((p) => [p.key, p.version, p.gameVersion, p.fits.allowed])).toEqual([
      ['open', '1.0', '1.21.1', true],
    ])

    // A server of it installs Blockly's copy, and fetches nothing from where the pack came from.
    const before = cdn.downloads
    const server = await h.create(owner, { from: { kind: 'curated', key: 'open' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect(cdn.downloads).toBe(before)
    expect(await h.minecraft.file(server.id, 'mods/lithium.jar')).not.toBeNull()
    expect(await h.minecraft.file(server.id, 'mods/ferrite.jar')).not.toBeNull()
    expect(await h.minecraft.file(server.id, 'mods/minimap.jar')).toBeNull()
    expect(await h.minecraft.file(server.id, 'config/pack.toml')).not.toBeNull()
    const pinned = (await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)).modpack
    expect(pinned?.curated).toEqual({ key: 'open', version: '1.0' })
    const [made] = await h.db
      .select({ from: schema.minecraftServers.createdFrom })
      .from(schema.minecraftServers)
      .where(eq(schema.minecraftServers.id, server.id))
    expect(made?.from).toBe('curated')
    // Which pack and release it was, for the metrics that count them (docs/metrics.md).
    const [audit] = await h.db
      .select({ data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectId, server.id))
    expect(audit?.data).toMatchObject({ from: 'curated', curated: 'open', release: '1.0' })
  }, 60_000)

  test('a pack carrying all-rights-reserved mods is offered from its authors, and its servers fetch each file there', async () => {
    const v1 = publishPack('mixed', 1, [
      { id: 'cobble', licence: 'MPL-2.0' },
      { id: 'balm', licence: 'LicenseRef-All-Rights-Reserved' },
    ])
    reviewed('mixed', 'upstream', v1)
    const release = await checked('mixed', '1.0')
    expect(release?.state).toBe('verified')
    expect(release?.distribution).toBe('upstream')
    expect(release?.pack?.artifact).toEqual({
      ref: { kind: 'remote', url: v1.file.url },
      sha512: v1.file.sha512,
      sizeBytes: v1.file.sizeBytes,
      fileName: v1.file.fileName,
    })
    // What would stand in the way of a copy is kept, for when someone asks the author.
    expect(release?.facts?.mirrorBlockers).toEqual([
      { name: 'Mod balm', licence: 'LicenseRef-All-Rights-Reserved', because: 'reserved' },
    ])

    await h.app.curation.publish(admin, { key: 'mixed', version: '1.0' })
    const owner = await h.user('Sam', 'plus')
    const before = cdn.downloads
    const server = await h.create(owner, { from: { kind: 'curated', key: 'mixed' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    // The pack and both of its mods, from the pack's own CDN.
    expect(cdn.downloads - before).toBe(3)
    expect(await h.minecraft.file(server.id, 'mods/balm.jar')).not.toBeNull()
  }, 60_000)

  test('a review that asked for a copy its licences don’t allow is refused, naming what stands in the way', async () => {
    const v1 = publishPack('wrong', 1, [{ id: 'arr', licence: 'LicenseRef-All-Rights-Reserved' }])
    reviewed('wrong', 'mirror', v1)
    const release = await checked('wrong', '1.0')
    expect(release?.state).toBe('refused')
    expect(release?.refusal).toContain('all rights reserved: Mod arr')
    expect(store.objects.size).toBe(1) // only the open pack's copy from before
  })

  test('nothing noncommercial is offered at all, and nothing unread', async () => {
    const nc = publishPack('noncommercial', 1, [{ id: 'nc', licence: 'CC-BY-NC-4.0' }])
    reviewed('noncommercial', 'upstream', nc)
    expect((await checked('noncommercial', '1.0'))?.refusal).toContain('noncommercial only: Mod nc')
    const custom = publishPack('custom', 1, [{ id: 'own', licence: 'LicenseRef-Own-Terms' }])
    reviewed('custom', 'upstream', custom)
    expect((await checked('custom', '1.0'))?.refusal).toContain('nobody has read yet: Mod own')
  })

  test('only the reviewed bytes get in: a changed version, a swapped pack or a swapped mod is refused', async () => {
    // The catalog now publishes other bytes under the reviewed version.
    const v1 = publishPack('swapped', 1, [{ id: 's1', licence: 'MIT' }])
    const entry = reviewed('swapped', 'upstream', v1)
    entry.releases = [{ ...(entry.releases[0] as (typeof entry.releases)[number]), sha512: 'c'.repeat(128) }]
    expect((await checked('swapped', '1.0'))?.refusal).toBe(
      'Its authors now publish different bytes under this version than the ones reviewed.',
    )

    // The CDN serves something else at the published address.
    const v2 = publishPack('served', 1, [{ id: 's2', licence: 'MIT' }])
    reviewed('served', 'upstream', v2)
    cdn.files.set(new URL(v2.file.url).pathname, Buffer.from(zipBytes({ 'x.txt': utf8('not the pack') })))
    expect((await checked('served', '1.0'))?.refusal).toBe(
      'The file its authors’ site served isn’t the one reviewed.',
    )

    // One of its mods changes on the CDN after the pack listed it: the index and the catalog agree
    // on its hash, and the bytes served aren't them, as a compromised host would serve.
    const v3 = publishPack('mod-swapped', 1, [{ id: 's3', licence: 'MIT' }])
    reviewed('mod-swapped', 'upstream', v3)
    const genuine = cdn.files.get('/files/s3-mod.jar') as Buffer
    cdn.files.set('/files/s3-mod.jar', Buffer.from(fabricJar('s3-and-more')))
    // More bytes than the pack says: the download is cut off before it is used.
    expect((await checked('mod-swapped', '1.0'))?.refusal).toBe(
      's3.jar is bigger than its authors say it is.',
    )
    // As many bytes, but one of them changed: the hash says so.
    const tampered = Buffer.from(genuine)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
    cdn.files.set('/files/s3-mod.jar', tampered)
    await h.app.curation.retry(admin, { key: 'mod-swapped', version: '1.0' })
    expect((await checked('mod-swapped', '1.0'))?.refusal).toBe('s3.jar isn’t what the pack says it is.')
    // Once what refused it is put right, an admin has it checked again, and it goes through.
    cdn.files.set('/files/s3-mod.jar', genuine)
    await h.app.curation.retry(admin, { key: 'mod-swapped', version: '1.0' })
    expect((await checked('mod-swapped', '1.0'))?.state).toBe('verified')
  })

  test('a pack is never fetched from, or sent to, a host the catalog doesn’t allow', async () => {
    const v1 = publishPack('elsewhere', 1, [{ id: 'e1', licence: 'MIT' }])
    reviewed('elsewhere', 'upstream', v1)
    h.catalog.allowDownloadsFrom(['cdn.example'])
    try {
      const release = await checked('elsewhere', '1.0')
      expect(release?.refusal).toBe('It is published somewhere Cubepals doesn’t fetch packs from.')
    } finally {
      h.catalog.allowDownloadsFrom(null)
    }
  })

  test('a pack that would write outside the server’s folder is refused before anything is used', async () => {
    const v1 = publishPack('escape', 1, [{ id: 'x1', licence: 'MIT' }], {
      overrides: { 'overrides/../../etc/cron.d/x': utf8('* * * * * root id\n') },
    })
    reviewed('escape', 'upstream', v1)
    const release = await checked('escape', '1.0')
    expect(release?.state).toBe('refused')
    expect(release?.refusal).toBe('Its file isn’t a pack Cubepals can open safely.')
  })

  test('withdrawing takes a release from new servers, never from the ones that play it, and its copy stays', async () => {
    const owner = await h.user('Kim', 'plus')
    const server = await h.create(owner, { from: { kind: 'curated', key: 'open' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)

    await h.app.curation.withdraw(admin, { key: 'open', version: '1.0' }, 'A mod in it crashes on join')
    expect((await h.app.curation.offered()).map((p) => p.pack.key)).toEqual(['mixed'])
    await expect(h.create(owner, { from: { kind: 'curated', key: 'open' } })).rejects.toThrow(/isn’t offered/)

    // The server that plays it restarts onto the same files.
    await h.app.servers.restart(owner, server.id, randomUUID())
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect(await h.minecraft.file(server.id, 'mods/lithium.jar')).not.toBeNull()

    // A month on, garbage collection still keeps the copy: it can be offered again.
    const kept = (await loadRelease(h.db, 'open', '1.0'))?.pack?.artifact.sha512 ?? ''
    await h.app.artifacts.collectGarbage(new Date(Date.now() + 40 * 86_400_000))
    expect(store.objects.has(`artifacts/${kept}`)).toBe(true)
    await h.app.curation.publish(admin, { key: 'open', version: '1.0' })
    expect((await h.app.curation.offered()).map((p) => p.pack.key)).toEqual(['open', 'mixed'])
  }, 60_000)

  test('a newer release is offered to an owner and applied only when they move to it', async () => {
    const owner = await h.user('Lee', 'plus')
    const server = await h.create(owner, { from: { kind: 'curated', key: 'mixed' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)

    const v2 = publishPack('mixed', 2, [
      { id: 'cobble2', licence: 'MPL-2.0' },
      { id: 'balm2', licence: 'LicenseRef-All-Rights-Reserved' },
    ])
    const v1 = (await h.catalog.version('mixed-v1')) as CatalogVersion
    reviewed('mixed', 'upstream', v2, v1)
    await checked('mixed', '2.0')
    // Verified but not offered: nothing to move to yet.
    expect((await h.app.modQueries.list(owner, server.id)).packUpdate).toBeNull()
    await h.app.curation.publish(admin, { key: 'mixed', version: '2.0' })
    const offered = await h.app.modQueries.list(owner, server.id)
    expect(offered.packUpdate).toEqual({
      versionId: 'mixed-v2',
      label: '2.0',
      gameVersion: '1.21.1',
      movesWorld: false,
      release: '2.0',
    })
    // Nothing moved by itself.
    const before = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
    expect(before.modpack?.curated).toEqual({ key: 'mixed', version: '1.0' })

    await h.app.packChanges.change(owner, server.id, { kind: 'curated', version: '2.0' }, randomUUID(), {
      version: (await h.server(server.id)).version,
    })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const after = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
    expect(after.modpack?.curated).toEqual({ key: 'mixed', version: '2.0' })
    expect(await h.minecraft.file(server.id, 'mods/balm2.jar')).not.toBeNull()
  }, 90_000)

  test('a pack the review holds is checked like any other, and no admin can offer it until the review lifts the hold', async () => {
    const v1 = publishPack('held', 1, [{ id: 'h1', licence: 'MIT' }])
    const entry = reviewed('held', 'upstream', v1)
    entry.held = 'Ask its authors first.'
    expect((await checked('held', '1.0'))?.state).toBe('verified')
    await expect(h.app.curation.publish(admin, { key: 'held', version: '1.0' })).rejects.toThrow(
      'Ask its authors first.',
    )
    expect((await h.app.curation.review(admin)).find((p) => p.key === 'held')?.held).toBe(
      'Ask its authors first.',
    )
    delete entry.held
    await h.app.curation.publish(admin, { key: 'held', version: '1.0' })
    expect((await h.app.curation.offered()).map((p) => p.pack.key)).toContain('held')
  })

  test('only admins publish, withdraw or check again, and only reviewed releases', async () => {
    const person: Actor = { kind: 'user', userId: 'someone' }
    await expect(h.app.curation.publish(person, { key: 'mixed', version: '2.0' })).rejects.toThrow()
    await expect(h.app.curation.review(person)).rejects.toThrow()
    await expect(h.app.curation.publish(admin, { key: 'mixed', version: '9.9' })).rejects.toThrow()
    // A published release can't be checked again: its bytes were verified once, for good.
    await expect(h.app.curation.retry(admin, { key: 'mixed', version: '2.0' })).rejects.toThrow(/can’t be/)
    const view = await h.app.curation.review(admin)
    expect(view.find((p) => p.key === 'mixed')?.releases.map((r) => [r.version, r.state])).toEqual([
      ['2.0', 'published'],
      ['1.0', 'published'],
    ])
  })
})
