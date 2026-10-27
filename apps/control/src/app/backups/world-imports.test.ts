// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worlds as people bring them (docs/world-import.md), each made of what real servers wrote
 * (`minecraft/world-fixtures/`): a single-player save in a zip, a saves folder of several, and a
 * Paper server's folder whose Nether and End sit beside its world. Region files stand in as text:
 * nothing reads them, and what is checked is that they arrive where the server reads them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { LibraryFileFormats } from '../../infra/formats/file-formats.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { withHost, zipBytes } from '../../testing/uploads.ts'
import { bringWorld, broughtBackup, untilRead } from '../../testing/world-imports.ts'
import type { UserActor } from '../actor.ts'
import { listWorlds } from '../worlds/persistence.ts'

const run = promisify(execFile)
const FIXTURES = `${import.meta.dir}/../../minecraft/world-fixtures`
const PLAYER = `${import.meta.dir}/../../minecraft/player-fixtures/1.20.1/player.dat`
const formats = new LibraryFileFormats()

/** A real server's folder as files: its own small files as it wrote them, the rest as stand-ins. */
async function serverFolder(server: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  for (const path of (await readFile(`${FIXTURES}/${server}/files.txt`, 'utf8')).trim().split('\n'))
    files[path] = await readFile(`${FIXTURES}/${server}/${path}`).catch(() =>
      new TextEncoder().encode(`${server} ${path}`),
    )
  return files
}

/** One world of a server's folder as its own save: its files, under `folder`. */
async function save(folder: string, host = false): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  for (const [path, bytes] of Object.entries(await serverFolder('vanilla-1.21.11')))
    if (path.startsWith('world/')) files[`${folder}${path.slice('world/'.length)}`] = bytes
  if (host)
    files[`${folder}level.dat`] = await withHost(
      files[`${folder}level.dat`] as Uint8Array,
      await readFile(PLAYER),
    )
  return files
}

let h: Harness
let scratch: string
const store = new MemoryStore()

beforeAll(async () => {
  if (!hasDatabase) return
  await store.start()
  scratch = await mkdtemp(join(tmpdir(), 'world-imports-'))
  h = await startHarness({ capabilities: { archives: store, billing: null } })
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h?.close()
  store.close()
  await rm(scratch, { recursive: true, force: true })
})

const server = async (name: string): Promise<{ owner: UserActor; id: string }> => {
  const owner = await h.user(name, 'plus')
  const { id } = await h.create(owner)
  await h.until(id, 'running')
  await h.settled(id)
  return { owner, id }
}

/** The files a backup's archive holds, unpacked as a server's restore unpacks them. */
const unpacked = async (key: string | null): Promise<string> => {
  const bytes = store.objects.get(key ?? '')
  if (bytes === undefined) throw new Error(`Nothing at ${key}`)
  const dir = await mkdtemp(join(scratch, 'unpacked-'))
  await writeFile(join(dir, 'archive.tar.gz'), bytes)
  await run('tar', ['-xzf', join(dir, 'archive.tar.gz'), '-C', dir])
  return dir
}

describe.skipIf(!hasDatabase)('a single-player save', () => {
  test('a single-player save, zipped: its host is asked for, and gets what they carried', async () => {
    const { owner, id } = await server('Alex')
    const zip = zipBytes(await save('My World 🌲/', true))
    const asked = await bringWorld(h, owner, id, zip, { fileName: 'My World.zip' })
    expect(asked).toMatchObject({ status: 'asking', player: true, worlds: null, problem: null })
    if (asked.status !== 'asking') return

    // A name no account has is asked again, saying so.
    h.profiles.unknown('Nobody_Here')
    await h.app.backups.imports.answer(owner, id, asked.importId, { player: 'Nobody_Here' })
    expect(await untilRead(h, owner, id, asked.importId)).toMatchObject({
      status: 'asking',
      player: true,
      problem: 'No Minecraft account is called Nobody_Here.',
    })

    await h.app.backups.imports.answer(owner, id, asked.importId, { player: 'Alex' })
    const ready = await untilRead(h, owner, id, asked.importId)
    expect(ready).toMatchObject({ status: 'ready' })
    if (ready.status !== 'ready') return
    expect(ready.notes).toEqual([
      'Found “world” in My World 🌲.',
      'Gave Alex what they carried and where they stood in the single-player world.',
      'It was last played on Minecraft 1.21.11. Restoring it opens it on 26.3, which updates it; this backup stays as it came.',
      'Its folder on the server is world-2.',
    ])

    const backup = await broughtBackup(h, ready)
    const dir = await unpacked(backup.archiveKey)
    expect(await readFile(join(dir, 'server.properties'), 'utf8')).toBe('level-name=world-2\n')
    const alex = normalizeUuid((await h.profiles.byName('Alex'))?.uuid ?? '')
    const own = await formats.decodeNbt(await readFile(join(dir, `world-2/playerdata/${alex}.dat`)))
    expect(own).toEqual(await formats.decodeNbt(await readFile(PLAYER)))
    expect(await readFile(join(dir, 'world-2/region/r.0.0.mca'), 'utf8')).toBe(
      'vanilla-1.21.11 world/region/r.0.0.mca',
    )
    expect((await listWorlds(h.db, id)).find((w) => w.id === backup.worldId)).toMatchObject({
      levelName: 'world-2',
      name: 'world',
      generatedOnVersion: '1.21.11',
    })

    // Restored, it is the server's world, its host's file where the server reads it.
    await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false })
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect((await h.server(id)).activeWorldId).toBe(backup.worldId)
    expect(await readFile(h.minecraft.path(id, `world-2/playerdata/${alex}.dat`))).toBeTruthy()
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a saves folder', () => {
  test('a saves folder of several: its owner chooses which', async () => {
    const { owner, id } = await server('Sam')
    const zip = zipBytes({ ...(await save('saves/Old Farm/')), ...(await save('saves/new-city/')) })
    const asked = await bringWorld(h, owner, id, zip, { fileName: 'saves.zip' })
    expect(asked).toMatchObject({
      status: 'asking',
      player: false,
      worlds: [
        { folder: 'saves/Old Farm/', name: 'world', gameVersion: '1.21.11' },
        { folder: 'saves/new-city/', name: 'world', gameVersion: '1.21.11' },
      ],
    })
    expect(
      h.app.backups.imports.answer(owner, id, asked.importId, { folder: 'saves/Elsewhere/' }),
    ).rejects.toThrow('Choose one of the worlds in the file.')
    await h.app.backups.imports.answer(owner, id, asked.importId, { folder: 'saves/new-city/' })
    const backup = await broughtBackup(h, await untilRead(h, owner, id, asked.importId))
    // Its own folder's name is one a server can run, and free: it keeps it.
    const dir = await unpacked(backup.archiveKey)
    expect(await readFile(join(dir, 'server.properties'), 'utf8')).toBe('level-name=new-city\n')
    expect(await readFile(join(dir, 'new-city/level.dat'))).toBeTruthy()
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a server’s folder', () => {
  test('a Paper server’s folder: its Nether and End come with the world, and the rest stays out', async () => {
    const { owner, id } = await server('Robin')
    const zip = zipBytes(await serverFolder('paper-1.21.11'))
    const view = await bringWorld(h, owner, id, zip, { fileName: 'server.zip' })
    expect(view).toMatchObject({ status: 'ready' })
    if (view.status !== 'ready') return
    expect(view.notes).toContain(
      'Left out what isn’t the world: banned-ips.json, banned-players.json, bukkit.yml, commands.yml, config/, eula.txt, help.yml, ops.json.',
    )
    const dir = await unpacked((await broughtBackup(h, view)).archiveKey)
    expect(await readFile(join(dir, 'world-2_nether/DIM-1/region/r.0.0.mca'), 'utf8')).toBe(
      'paper-1.21.11 world_nether/DIM-1/region/r.0.0.mca',
    )
    expect(await readFile(join(dir, 'world-2_the_end/level.dat'))).toBeTruthy()
    const { stdout } = await run('ls', ['-A', dir])
    expect(stdout.trim().split('\n').sort()).toEqual([
      'archive.tar.gz',
      'server.properties',
      'world-2',
      'world-2_nether',
      'world-2_the_end',
    ])
  }, 120_000)
})
