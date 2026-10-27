// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world brought while a server is being made (`new-world-imports.ts`), through the real reader
 * and a real store, from worlds real servers saved: read before any server exists, asked what only
 * its owner knows, packed as the new server's first start unpacks it, and a server made to fit it,
 * whose own link serves the archive the real step unpacks where its world goes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { diskForBroughtWorld, entitlementsFor } from '../../domain/account/entitlements.ts'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { LibraryFileFormats } from '../../infra/formats/file-formats.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { DATAPACKS_STEP } from '../../minecraft/datapacks.ts'
import { STARTER_STEP } from '../../minecraft/starter.ts'
import { VANILLA_PAPER_STEP } from '../../minecraft/vanilla-paper.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { savedOn, zipBytes, zipOf } from '../../testing/uploads.ts'
import { bringNewWorld, PLAYER, save, serverFolder, untilNewRead } from '../../testing/world-imports.ts'
import { grownStorage, loadRevision } from '../servers/persistence.ts'
import { installTuning, tuning } from '../tuning.ts'
import { listWorlds } from '../worlds/persistence.ts'

const run = promisify(execFile)
const formats = new LibraryFileFormats()

let h: Harness
let scratch: string
const store = new MemoryStore()
const cdn = new Cdn()

beforeAll(async () => {
  if (!hasDatabase) return
  await store.start()
  await cdn.start()
  scratch = await mkdtemp(join(tmpdir(), 'new-world-imports-'))
  h = await startHarness({ capabilities: { archives: store, billing: null } })
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h?.close()
  store.close()
  cdn.close()
  await rm(scratch, { recursive: true, force: true })
})

/** The files an archive a world starts on holds, unpacked as the step unpacks it. */
const unpacked = async (key: string): Promise<string> => {
  const bytes = store.objects.get(key)
  if (bytes === undefined) throw new Error(`Nothing at ${key}`)
  const dir = await mkdtemp(join(scratch, 'unpacked-'))
  await writeFile(join(dir, 'world.tar.gz'), bytes)
  await run('tar', ['-xzf', join(dir, 'world.tar.gz'), '-C', dir])
  await rm(join(dir, 'world.tar.gz'))
  return dir
}

/** The archive a ready import keeps, by the key the store holds it under. */
const keptKey = async (importId: string): Promise<string> => {
  const record = await h.db.query.worldImports.findFirst({ where: (t, { eq }) => eq(t.id, importId) })
  const ref = record?.startsOn?.ref
  if (ref?.kind !== 'stored') throw new Error('The import keeps no archive')
  return ref.key
}

/** A Fabric modpack on the catalog, its versions newest first, each file an index naming its release. */
const publishPack = (projectId: string, releases: Array<{ id: string; gameVersions: string[] }>) =>
  h.catalog.publishModpack(
    {
      projectId,
      slug: projectId,
      name: projectId,
      summary: `${projectId}, for tests`,
      iconUrl: null,
      environments: [],
      downloads: 1,
      categories: [],
    },
    releases.map(
      (release, i): CatalogVersion => ({
        versionId: release.id,
        projectId,
        versionLabel: release.id,
        channel: 'release',
        state: 'listed',
        environment: 'client_and_server',
        loaders: ['fabric'],
        gameVersions: release.gameVersions,
        publishedAt: new Date(Date.UTC(2026, 0, 1 + releases.length - i)),
        file: cdn.file(
          `${projectId}-${release.id}`,
          zipOf({
            'modrinth.index.json': JSON.stringify({
              formatVersion: 1,
              game: 'minecraft',
              versionId: release.id,
              name: projectId,
              files: [],
              dependencies: { minecraft: release.gameVersions[0], 'fabric-loader': '1.0.0' },
            }),
          }),
        ),
        dependencies: [],
      }),
    ),
  )

describe.skipIf(!hasDatabase)('a single-player save, before its server is made', () => {
  test('is asked who played it, and kept as the world its server starts on', async () => {
    const owner = await h.user('Wren', 'plus')
    const asked = await bringNewWorld(h, owner, zipBytes(await save('My World/', true)), 'My World.zip')
    expect(asked).toMatchObject({ status: 'asking', player: true, worlds: null, problem: null })
    if (asked.status !== 'asking') return
    await h.app.backups.newWorlds.answer(owner, asked.importId, { player: 'Alex' })
    const ready = await untilNewRead(h, owner, asked.importId)
    expect(ready).toMatchObject({
      status: 'ready',
      world: { name: 'world', gameVersion: '1.21.11', playsOn: '1.21.11' },
      notes: [
        'Found “world” in My World.',
        'Gave Alex what they carried and where they stood in the single-player world.',
      ],
    })

    // Its world inside its own folder, as the step unpacks it, its host's file among it.
    const dir = await unpacked(await keptKey(asked.importId))
    const alex = normalizeUuid((await h.profiles.byName('Alex'))?.uuid ?? '')
    expect((await readdir(dir)).sort()).toEqual(expect.arrayContaining(['level.dat', 'playerdata', 'region']))
    expect(await readdir(dir)).not.toContain('session.lock')
    const own = await formats.decodeNbt(await readFile(join(dir, `playerdata/${alex}.dat`)))
    expect(own).toEqual(await formats.decodeNbt(await readFile(PLAYER)))
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a server made from a world its owner brought', () => {
  test('fits it, starts on it through its own link, and the store keeps it', async () => {
    const owner = await h.user('Ezra', 'plus')
    const ready = await bringNewWorld(h, owner, zipBytes(await save('Island/')), 'Island.zip')
    if (ready.status !== 'ready') throw new Error(`The import is ${ready.status}`)
    const from = { kind: 'world', importId: ready.importId } as const
    expect(await h.app.queries.setupPreview(owner, from)).toMatchObject({
      from: 'world',
      gameVersion: '1.21.11',
      mods: [],
      modpack: null,
    })

    const server = await h.create(owner, { from })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    expect(revision.gameVersion).toBe('1.21.11')
    // The fixture's world was saved in survival on easy.
    expect(revision.settings).toMatchObject({ defaultGameMode: 'survival', difficulty: 'easy' })
    const [world] = await listWorlds(h.db, server.id)
    const kept = await h.db.query.worldImports.findFirst({ where: (t, { eq }) => eq(t.id, ready.importId) })
    expect(world).toMatchObject({
      levelName: 'world',
      name: 'world',
      seed: kept?.facts?.seed,
      generatedOnVersion: '1.21.11',
      startsOn: kept?.startsOn,
    })

    // The step fetches it through the server's own link, checked by its bytes, before the steps
    // that lay a world out run, and unpacks it where the world goes.
    const { spec } = await h.app.specs.desired(h.db, await h.server(server.id))
    const [sha512, link = ''] = (spec.env.BLOCKLY_STARTER ?? '').split(' ')
    expect(sha512).toBe(kept?.startsOn?.sha512)
    const script = spec.entrypoint?.[2] ?? ''
    expect(script.indexOf(STARTER_STEP)).toBeGreaterThan(-1)
    for (const after of [VANILLA_PAPER_STEP, DATAPACKS_STEP])
      expect(script.indexOf(STARTER_STEP)).toBeLessThan(script.indexOf(after))
    const volume = await mkdtemp(join(scratch, 'volume-'))
    const step = Bun.spawn(['/bin/sh', '-c', STARTER_STEP.replaceAll('/data', volume)], {
      env: { LEVEL: 'world', BLOCKLY_STARTER: `${sha512} ${link}` },
      stderr: 'ignore',
    })
    expect(await step.exited).toBe(0)
    expect(await readFile(join(volume, 'world/level.dat'))).toEqual(
      Buffer.from((await save('Island/'))['Island/level.dat'] as Uint8Array),
    )

    // Nothing else pins it, and the sweep for unused blobs leaves it while the server has it.
    await h.app.artifacts.collectGarbage(new Date(Date.now() + 60 * DAY_MS))
    expect(await store.head(await keptKey(ready.importId))).not.toBeNull()
  }, 120_000)
})

describe.skipIf(!hasDatabase)('the disk a server made from a world brought starts with', () => {
  test('has room for the world, and for its archive while its first start unpacks it', async () => {
    const owner = await h.user('Wren', 'plus')
    const small = await bringNewWorld(h, owner, zipBytes(await save('Small/')), 'small.zip')
    if (small.status !== 'ready') throw new Error(`The import is ${small.status}`)
    const first = await h.create(owner, { from: { kind: 'world', importId: small.importId } })
    // A small world starts on the plan's first disk, as any new server does.
    expect(await grownStorage(h.db, first.id)).toBe(0)

    const large = await bringNewWorld(h, owner, zipBytes(await save('Large/')), 'large.zip')
    if (large.status !== 'ready') throw new Error(`The import is ${large.status}`)
    // As though the world were 6 GB unpacked: its server starts on the disk that holds it and its
    // archive at once, past the plan's first.
    const kept = await h.db.query.worldImports.findFirst({ where: (t, { eq }) => eq(t.id, large.importId) })
    if (kept?.facts == null || kept.startsOn == null) throw new Error('The import keeps no world')
    await h.db
      .update(schema.worldImports)
      .set({ facts: { ...kept.facts, sizeBytes: 6 * 2 ** 30 } })
      .where(eq(schema.worldImports.id, large.importId))
    const second = await h.create(owner, { from: { kind: 'world', importId: large.importId } })
    const plus = entitlementsFor('plus')
    expect(await grownStorage(h.db, second.id)).toBe(
      diskForBroughtWorld(plus, 6 * 2 ** 30, kept.startsOn.sizeBytes),
    )
    expect(await grownStorage(h.db, second.id)).toBeGreaterThan(plus.storage.startGb)
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a Paper server’s folder, before its server is made', () => {
  test('brings its Nether and End inside the world, where every server type finds them', async () => {
    const owner = await h.user('Juno', 'plus')
    const ready = await bringNewWorld(h, owner, zipBytes(await serverFolder('paper-1.21.11')), 'server.zip')
    expect(ready).toMatchObject({ status: 'ready', world: { gameVersion: '1.21.11' } })
    const dir = await unpacked(await keptKey(ready.importId))
    const names = await readdir(dir)
    expect(names).toEqual(expect.arrayContaining(['level.dat', 'region', 'DIM-1', 'DIM1']))
    expect(names).not.toContain('world_nether')
    expect(names).not.toContain('server.properties')
    expect(await readdir(join(dir, 'DIM-1/region'))).toContain('r.0.0.mca')
  }, 120_000)
})

describe.skipIf(!hasDatabase)('what can’t make a server', () => {
  test('a world newer than every release offered is refused, saying so', async () => {
    const owner = await h.user('Ivo', 'plus')
    const files = await save('Future/')
    files['Future/level.dat'] = await savedOn(files['Future/level.dat'] as Uint8Array, '99.1')
    expect(await bringNewWorld(h, owner, zipBytes(files), 'future.zip')).toMatchObject({
      status: 'refused',
      message: 'This world was last played on Minecraft 99.1, newer than any release Cubepals offers yet.',
    })
  }, 120_000)

  test('a world refused after a ready one leaves that one to make a server from', async () => {
    const owner = await h.user('Nell', 'plus')
    const kept = await bringNewWorld(h, owner, zipBytes(await save('Keep/')), 'keep.zip')
    const files = await save('Later/')
    files['Later/level.dat'] = await savedOn(files['Later/level.dat'] as Uint8Array, '99.1')
    expect((await bringNewWorld(h, owner, zipBytes(files), 'later.zip')).status).toBe('refused')
    expect(kept.status).toBe('ready')
    // The create page can still make a server from the first.
    expect(await h.app.queries.setupPreview(owner, { kind: 'world', importId: kept.importId })).toMatchObject(
      {
        from: 'world',
      },
    )
  }, 120_000)

  test('past the worlds an account may bring in a day, the next is refused before it is sent', async () => {
    const was = tuning()
    installTuning({ ...was, abuse: { ...was.abuse, worldUploadsPerDay: 1 } })
    try {
      const owner = await h.user('Fern', 'plus')
      // A ticket taken before the day's world was finished is refused as it is finished.
      const early = await h.app.backups.newWorlds.begin(owner, { fileName: 'early.zip', sizeBytes: 1024 })
      expect((await bringNewWorld(h, owner, zipBytes(await save('Today/')), 'today.zip')).status).toBe(
        'ready',
      )
      await fetch(early.url, { method: 'PUT', body: new Uint8Array(1024), headers: early.headers })
      await expect(h.app.backups.newWorlds.finish(owner, early.ticket)).rejects.toThrow(
        'That’s a lot of worlds for one day. Try again tomorrow.',
      )
      await expect(
        h.app.backups.newWorlds.begin(owner, { fileName: 'more.zip', sizeBytes: 1024 }),
      ).rejects.toThrow('That’s a lot of worlds for one day. Try again tomorrow.')
    } finally {
      installTuning(was)
    }
  }, 120_000)

  test('a world brought before the latest one, or someone else’s', async () => {
    const owner = await h.user('Lark', 'plus')
    const first = await bringNewWorld(h, owner, zipBytes(await save('One/')), 'one.zip')
    const second = await bringNewWorld(h, owner, zipBytes(await save('Two/')), 'two.zip')
    expect([first.status, second.status]).toEqual(['ready', 'ready'])
    await expect(h.create(owner, { from: { kind: 'world', importId: first.importId } })).rejects.toThrow(
      'Cubepals no longer keeps this world. Upload it again.',
    )
    const stranger = await h.user('Moss', 'plus')
    await expect(h.create(stranger, { from: { kind: 'world', importId: second.importId } })).rejects.toThrow(
      'Upload',
    )
    await expect(h.app.backups.newWorlds.view(stranger, second.importId)).rejects.toThrow('Upload')
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a world played with mods', () => {
  test('a world played with mods asks for its pack, and its server is made from that pack', async () => {
    const owner = await h.user('Sage', 'plus')
    const files = await serverFolder('vanilla-1.21.11')
    files['mods/sodium.jar'] = new TextEncoder().encode('a mod')
    const ready = await bringNewWorld(h, owner, zipBytes(files), 'modded.zip')
    expect(ready).toMatchObject({ status: 'ready', world: { gameVersion: '1.21.11', moddedWith: [] } })
    if (ready.status !== 'ready') return
    // Alone it would be opened on plain Minecraft, which would lose what its mods added.
    await expect(
      h.app.queries.setupPreview(owner, { kind: 'world', importId: ready.importId }),
    ).rejects.toThrow(
      'This world was played with mods, which plain Minecraft would lose. Choose the pack it was played with, and its server is made from that.',
    )

    // Named without a version, the pack plays its newest one for the world's own release.
    publishPack('played-pack', [
      { id: 'pp-2', gameVersions: ['26.3'] },
      { id: 'pp-1', gameVersions: ['1.21.11'] },
    ])
    const from = {
      kind: 'world',
      importId: ready.importId,
      pack: { kind: 'modpack', projectId: 'played-pack' },
    } as const
    expect(await h.app.queries.setupPreview(owner, from)).toMatchObject({
      gameVersion: '1.21.11',
      loader: 'fabric',
      modpack: { version: 'pp-1' },
    })
    const server = await h.create(owner, { from })
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    expect(revision.modpack).toMatchObject({ projectId: 'played-pack', versionId: 'pp-1' })
    // The world's own game mode and difficulty, and the world itself to start on.
    expect(revision.settings).toMatchObject({ defaultGameMode: 'survival', difficulty: 'easy' })
    const kept = await h.db.query.worldImports.findFirst({ where: (t, { eq }) => eq(t.id, ready.importId) })
    const [world] = await listWorlds(h.db, server.id)
    expect(world?.startsOn).toEqual(kept?.startsOn ?? null)

    // A version that lists the world's release among others is one for it.
    publishPack('wide-pack', [
      { id: 'wp-2', gameVersions: ['26.3'] },
      { id: 'wp-1', gameVersions: ['1.21.11', '26.3'] },
    ])
    expect(
      await h.app.queries.setupPreview(owner, {
        kind: 'world',
        importId: ready.importId,
        pack: { kind: 'modpack', projectId: 'wide-pack' },
      }),
    ).toMatchObject({ gameVersion: '1.21.11', modpack: { version: 'wp-1' } })
    // A newest version whose own index runs another release gives way to the next one for it.
    publishPack('mixed-pack', [
      { id: 'mp-2', gameVersions: ['1.21.1', '1.21.11'] },
      { id: 'mp-1', gameVersions: ['1.21.11'] },
    ])
    expect(
      await h.app.queries.setupPreview(owner, {
        kind: 'world',
        importId: ready.importId,
        pack: { kind: 'modpack', projectId: 'mixed-pack' },
      }),
    ).toMatchObject({ gameVersion: '1.21.11', modpack: { version: 'mp-1' } })
    // With none for its release, the world isn't moved to a newer Minecraft unasked; its owner picks.
    publishPack('newer-pack', [{ id: 'np-1', gameVersions: ['26.3'] }])
    const newer = { kind: 'modpack', projectId: 'newer-pack' } as const
    await expect(
      h.app.queries.setupPreview(owner, { kind: 'world', importId: ready.importId, pack: newer }),
    ).rejects.toThrow(
      'No version of newer-pack runs Minecraft 1.21.11, which this world was played on. Choose the version it was played with, or one on a newer Minecraft to update the world to.',
    )
    expect(
      await h.app.queries.setupPreview(owner, {
        kind: 'world',
        importId: ready.importId,
        pack: { ...newer, versionId: 'np-1' },
      }),
    ).toMatchObject({
      gameVersion: '26.3',
      modpack: {
        notes: [
          'It was last played on Minecraft 1.21.11. newer-pack runs 26.3, which updates it when it first starts.',
        ],
      },
    })

    // A pack version older than the world would lose what its release added.
    publishPack('older-pack', [{ id: 'op-1', gameVersions: ['1.21.1'] }])
    await expect(
      h.app.queries.setupPreview(owner, {
        kind: 'world',
        importId: ready.importId,
        pack: { kind: 'modpack', projectId: 'older-pack' },
      }),
    ).rejects.toThrow(
      'This world was last played on Minecraft 1.21.11, and older-pack runs 1.21.1, which can’t open it. Choose the version of the pack the world was played with.',
    )
  }, 120_000)
})
