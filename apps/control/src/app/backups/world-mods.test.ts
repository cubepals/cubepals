// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world played with mods, brought with them (docs/world-import.md § Mods): a Prism instance
 * picked whole, as the browser sends one, its world a single-player one Minecraft 26.3 saved with
 * Fabric (`player-fixtures/26.3/level.dat`, `ServerBrands` `["fabric"]`), its `mmc-pack.json`,
 * `instance.cfg` and a mod's `.pw.toml` as Prism writes them (`minecraft/instance-fixtures/`). Its
 * jars are test jars, published on the stand-in catalog by their bytes where the test says. Restored
 * with its mods, the server moves to Fabric with them and what they depend on, in the one restore.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { fabricJar } from '../../testing/uploads.ts'
import { bringWorld, broughtBackup, untilRead } from '../../testing/world-imports.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'

const run = promisify(execFile)
const MINECRAFT = join(import.meta.dir, '../../minecraft')
const INSTANCE = join(MINECRAFT, 'instance-fixtures/prism-fabric-26.3')
const FABRIC_WORLD = join(MINECRAFT, 'player-fixtures/26.3/level.dat')

const TREE_HARVESTER = fabricJar('treeharvester', { name: 'Tree Harvester', depends: { collective: '*' } })
const COLLECTIVE = fabricJar('collective', { name: 'Collective' })
const SODIUM = fabricJar('sodium', { name: 'Sodium' })
const VEIN_MINER = fabricJar('veinminer', { name: 'Vein Miner' })

let h: Harness
let scratch: string
const store = new MemoryStore()
const cdn = new Cdn()

/** A Fabric mod on the stand-in catalog, its one version's file these bytes. */
const publish = (
  projectId: string,
  name: string,
  bytes: Uint8Array,
  environment: CatalogVersion['environment'],
  requires: string[] = [],
) =>
  h.catalog.publish(
    {
      projectId,
      slug: projectId,
      name,
      summary: name,
      iconUrl: null,
      environments: [environment],
      downloads: 1,
    },
    [
      {
        versionId: `${projectId}-1`,
        projectId,
        versionLabel: '1.0',
        channel: 'release',
        state: 'listed',
        environment,
        loaders: ['fabric'],
        gameVersions: ['26.3'],
        publishedAt: new Date(Date.UTC(2026, 9, 1)),
        file: cdn.file(projectId, bytes),
        dependencies: requires.map((p) => ({ projectId: p, versionId: null, kind: 'required' as const })),
      },
    ],
  )

beforeAll(async () => {
  if (!hasDatabase) return
  await store.start()
  await cdn.start()
  scratch = await mkdtemp(join(tmpdir(), 'world-mods-'))
  h = await startHarness({ capabilities: { archives: store, billing: null } })
  publish('tree-harvester', 'Tree Harvester', TREE_HARVESTER, 'server_only', ['collective'])
  publish('collective', 'Collective', COLLECTIVE, 'client_or_server_prefers_both')
  publish('sodium', 'Sodium', SODIUM, 'client_only')
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h?.close()
  store.close()
  cdn.close()
  await rm(scratch, { recursive: true, force: true })
})

const server = async (name: string): Promise<{ owner: UserActor; id: string }> => {
  const owner = await h.user(name, 'plus')
  const { id } = await h.create(owner, { loader: 'vanilla', gameVersion: '26.3' })
  await h.until(id, 'running')
  await h.settled(id)
  return { owner, id }
}

/** The instance as the browser sends one picked whole: a tarball of what it keeps of it. */
const instance = async (jars: Record<string, Uint8Array>): Promise<Uint8Array> => {
  const dir = join(scratch, randomUUID())
  const root = join(dir, 'Fabric 26.3')
  await cp(INSTANCE, root, { recursive: true })
  await mkdir(join(root, 'minecraft/saves/Life/region'), { recursive: true })
  await cp(FABRIC_WORLD, join(root, 'minecraft/saves/Life/level.dat'))
  await writeFile(join(root, 'minecraft/saves/Life/region/r.0.0.mca'), 'a region')
  for (const [name, bytes] of Object.entries(jars)) await writeFile(join(root, 'minecraft/mods', name), bytes)
  await run('tar', ['-cf', join(dir, 'instance.tar'), '-C', dir, 'Fabric 26.3'])
  return new Uint8Array(await readFile(join(dir, 'instance.tar')))
}

/** Brought, its host's things given to nobody: the single-player world asks who played it. */
const brought = async (owner: UserActor, id: string, bytes: Uint8Array) => {
  const asked = await bringWorld(h, owner, id, bytes, { fileName: 'Fabric 26.3.tar' })
  if (asked.status !== 'asking') return asked
  await h.app.backups.imports.answer(owner, id, asked.importId, { player: null })
  return untilRead(h, owner, id, asked.importId)
}

describe.skipIf(!hasDatabase)('a world brought with its mods', () => {
  test('its mods come: Modrinth’s by their bytes, its own as uploads, players’ left out', async () => {
    const { owner, id } = await server('Robin')
    const read = await brought(
      owner,
      id,
      await instance({
        'treeharvester-26.3.0-10.4.jar': TREE_HARVESTER,
        'sodium-fabric-0.9.3.jar': SODIUM,
        'veinminer-1.0.jar': VEIN_MINER,
      }),
    )
    expect(read.status).toBe('ready')
    if (read.status !== 'ready') return
    expect(read.playedWith).toEqual({
      moddedWith: ['fabric'],
      mods: {
        loader: 'fabric',
        mods: [
          { name: 'Tree Harvester', fileName: 'treeharvester-26.3.0-10.4.jar', from: 'modrinth' },
          { name: 'Vein Miner', fileName: 'veinminer-1.0.jar', from: 'own' },
        ],
        forPlayers: [{ name: 'Sodium', fileName: 'sodium-fabric-0.9.3.jar' }],
        leftOut: [],
      },
    })
    // Said where it is played, from playedWith, not again among what Cubepals did.
    expect(read.notes.join(' ')).not.toMatch(/Tree Harvester|Sodium|mods/)
    const backup = await broughtBackup(h, read)
    const listed = (await h.app.backupQueries.list(owner, id)).backups.find((b) => b.id === backup.id)
    expect(listed?.playedWith).toEqual(read.playedWith)
    // Its own jars wait with it in Backups, however long it waits there, and stay until it goes.
    await h.app.artifacts.collectGarbage(new Date(Date.now() + 60 * DAY_MS))
    const own = (await h.db.query.backups.findFirst({ where: (t, { eq: is }) => is(t.id, backup.id) }))
      ?.worldFacts?.mods?.own[0]
    if (own === undefined) throw new Error('No own jar kept')
    await expect(h.app.mods.deleteUpload(owner, id, own.uploadId)).rejects.toThrow('a world in Backups')

    await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), {
      withConfiguration: false,
      withMods: true,
    })
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    const desired = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect({ loader: desired.loader, gameVersion: desired.gameVersion }).toEqual({
      loader: 'fabric',
      gameVersion: '26.3',
    })
    expect(desired.loaderVersion).not.toBeNull()
    // Collective comes because Tree Harvester needs it; the player's own jar as their upload.
    expect(
      desired.mods.map((mod) => [mod.name, 'uploadId' in mod.source ? 'own' : mod.source.versionId]).sort(),
    ).toEqual([
      ['Collective', 'collective-1'],
      ['Tree Harvester', 'tree-harvester-1'],
      ['Vein Miner', 'own'],
    ])

    // Played again on the loader and release it is on: the server keeps the loader build it has.
    await h.db
      .update(schema.serverRevisions)
      .set({ loaderVersion: '0.16.0' })
      .where(eq(schema.serverRevisions.id, desired.id))
    h.loaderBuilds.builds.set('fabric', '0.19.7')
    await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), {
      withConfiguration: false,
      withMods: true,
    })
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect((await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).loaderVersion).toBe('0.16.0')
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a world brought without its mods', () => {
  test('says what it was played with, and asks for its mods', async () => {
    const { owner, id } = await server('Sam')
    const dir = join(scratch, randomUUID())
    await mkdir(join(dir, 'Life'), { recursive: true })
    await cp(FABRIC_WORLD, join(dir, 'Life/level.dat'))
    await run('tar', ['-cf', join(dir, 'world.tar'), '-C', dir, 'Life'])
    const read = await brought(owner, id, new Uint8Array(await readFile(join(dir, 'world.tar'))))
    expect(read.status).toBe('ready')
    if (read.status !== 'ready') return
    expect(read.playedWith).toEqual({ moddedWith: ['fabric'], mods: null })
    expect(read.notes.join(' ')).not.toMatch(/Fabric|mods/)
    const backup = await broughtBackup(h, read)
    await expect(
      h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), {
        withConfiguration: false,
        withMods: true,
      }),
    ).rejects.toThrow('This world came without its mods, so there are none to bring.')
  }, 60_000)
})
