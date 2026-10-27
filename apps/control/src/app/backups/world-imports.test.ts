// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worlds as people bring them (docs/world-import.md), each made of what real servers wrote
 * (`minecraft/world-fixtures/`): a single-player save in a zip, a saves folder of several, and a
 * Paper server's folder whose Nether and End sit beside its world. Region files stand in as text:
 * nothing reads them, and what is checked is that they arrive where the server reads them.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import { LibraryFileFormats } from '../../infra/formats/file-formats.ts'
import { LibraryUploadArchives } from '../../infra/formats/world-archives.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { savedOn, zipBytes } from '../../testing/uploads.ts'
import {
  bringWorld,
  broughtBackup,
  PLAYER,
  save,
  serverFolder,
  untilRead,
} from '../../testing/world-imports.ts'
import { offlineUuid } from '../access/identity.ts'
import type { UserActor } from '../actor.ts'
import { listWorlds } from '../worlds/persistence.ts'
import { WorldReading } from './world-reading.ts'

const run = promisify(execFile)
const formats = new LibraryFileFormats()

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

const server = async (name: string, plan = 'plus'): Promise<{ owner: UserActor; id: string }> => {
  const owner = await h.user(name, plan)
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

describe.skipIf(!hasDatabase)('a single-player save whose host has a file of their own already', () => {
  test('keeps that file as it was, and says so', async () => {
    const { owner, id } = await server('Kai')
    const kai = normalizeUuid((await h.profiles.byName('Kai'))?.uuid ?? '')
    const files = {
      ...(await save('Kai World/', true)),
      [`Kai World/playerdata/${kai}.dat`]: await readFile(PLAYER),
    }
    const asked = await bringWorld(h, owner, id, zipBytes(files), { fileName: 'Kai World.zip' })
    await h.app.backups.imports.answer(owner, id, asked.importId, { player: 'Kai' })
    const ready = await untilRead(h, owner, id, asked.importId)
    expect(ready).toMatchObject({ status: 'ready' })
    if (ready.status !== 'ready') return
    expect(ready.notes).toContain('Kai already had a player file in the world, which stays as it was.')
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

  test('the same folder as a hand-made .tar.gz is written again too: only a Cubepals download is kept as it came', async () => {
    const { owner, id } = await server('Rowan')
    const folder = await mkdtemp(join(scratch, 'server-'))
    for (const [path, bytes] of Object.entries(await serverFolder('paper-1.21.11'))) {
      await run('mkdir', ['-p', join(folder, path, '..')])
      await writeFile(join(folder, path), bytes)
    }
    await run('tar', ['-czf', join(scratch, 'server.tar.gz'), '-C', folder, '.'])
    const view = await bringWorld(
      h,
      owner,
      id,
      new Uint8Array(await readFile(join(scratch, 'server.tar.gz'))),
      {
        fileName: 'server.tar.gz',
      },
    )
    const dir = await unpacked((await broughtBackup(h, view)).archiveKey)
    const { stdout } = await run('ls', ['-A', dir])
    expect(stdout).not.toContain('plugins')
    expect(stdout).not.toContain('bukkit.yml')
  }, 120_000)
})

/** A server's folder with a second world beside the first, and its Nether, as a server with several keeps them. */
function withSecondWorld(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const copies = Object.entries(files).flatMap(([path, bytes]) =>
    path.startsWith('world/') || path.startsWith('world_nether/')
      ? [[path.replace(/^world/, 'creative'), bytes] as const]
      : [],
  )
  return { ...files, ...Object.fromEntries(copies) }
}

describe.skipIf(!hasDatabase)('a server’s folder with other worlds', () => {
  test('keeps each as a backup of its own, in a folder of its own, and says so', async () => {
    const { owner, id } = await server('Sasha')
    const files = withSecondWorld(await serverFolder('paper-1.21.11'))
    // Alex, of the offline-mode server, played only in the other world: moved to their account there.
    const alex = offlineUuid('Alex')
    files[`creative/playerdata/${alex}.dat`] = new Uint8Array(await readFile(PLAYER))
    files['usercache.json'] = new TextEncoder().encode(JSON.stringify([{ name: 'Alex', uuid: alex }]))
    const view = await bringWorld(h, owner, id, zipBytes(files), { fileName: 'server.zip' })
    if (view.status !== 'ready') throw new Error(`The import is ${view.status}`)
    expect(view.notes).toContain(
      'Also kept creative, the server’s other world, as a backup to restore when you want to play it.',
    )
    expect(view.notes.find((note) => note.startsWith('Left out what isn’t the world'))).not.toContain(
      'creative',
    )
    const kept = await h.db.query.backups.findMany({
      where: (t, { and, eq }) => and(eq(t.serverId, id), eq(t.trigger, 'uploaded')),
    })
    expect(kept).toHaveLength(2)
    const worlds = await listWorlds(h.db, id)
    const creative = worlds.find((world) => world.name === 'creative')
    if (creative === undefined) throw new Error('No world was kept for creative')
    const backup = kept.find((one) => one.worldId === creative.id)
    if (backup === undefined || backup.archiveKey === null) throw new Error('No backup was kept for creative')
    const dir = await unpacked(backup.archiveKey)
    const { stdout } = await run('ls', ['-A', dir])
    expect(stdout.trim().split('\n').sort()).toEqual([
      'archive.tar.gz',
      `${creative.levelName}`,
      `${creative.levelName}_nether`,
      'server.properties',
    ])
    const online = normalizeUuid((await h.profiles.byName('Alex'))?.uuid ?? '')
    expect(await run('ls', [join(dir, creative.levelName, 'playerdata')]).then((r) => r.stdout.trim())).toBe(
      `${online}.dat`,
    )
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a server’s folder with other worlds past its room', () => {
  test('keeps the ones that fit together, and says why the rest stay out', async () => {
    const { owner, id } = await server('Tobin')
    const files = withSecondWorld(await serverFolder('paper-1.21.11'))
    // A server with room for only one world of that size: the second doesn't fit beside it.
    const room = spyOn(WorldReading.prototype, 'refuseWhatWontOpen').mockResolvedValue(1)
    try {
      const view = await bringWorld(h, owner, id, zipBytes(files), { fileName: 'server.zip' })
      if (view.status !== 'ready') throw new Error(`The import is ${view.status}`)
      expect(view.notes.some((note) => note.startsWith('Left out creative: with the worlds before it'))).toBe(
        true,
      )
      const kept = await h.db.query.backups.findMany({
        where: (t, { and, eq }) => and(eq(t.serverId, id), eq(t.trigger, 'uploaded')),
      })
      expect(kept).toHaveLength(1)
    } finally {
      room.mockRestore()
    }
  }, 120_000)
})

describe.skipIf(!hasDatabase)('an upload that goes while it is read', () => {
  test('is refused, saying to upload it again, rather than left being read', async () => {
    const { owner, id } = await server('Quinn')
    const target = store.archiveTarget.bind(store)
    // As the daily sweep takes an upload past its day: between reading it and keeping the world.
    const swept = spyOn(store, 'archiveTarget').mockImplementation(async (key) => {
      await h.db.delete(schema.pendingUploads).where(eq(schema.pendingUploads.serverId, id))
      return target(key)
    })
    try {
      expect(
        await bringWorld(h, owner, id, zipBytes(await save('My World/')), { fileName: 'w.zip' }),
      ).toMatchObject({
        status: 'refused',
        message: 'The upload was cleared before Cubepals finished reading it. Upload it again.',
      })
    } finally {
      swept.mockRestore()
    }
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a world larger than the server holds', () => {
  test('is refused by its size unpacked, not by the size it was sent at', async () => {
    const { owner, id } = await server('Rowan')
    const open = LibraryUploadArchives.prototype.openWorld
    // Region files that unpack past any disk the plan has: the real archive, its sizes made large.
    const opened = spyOn(LibraryUploadArchives.prototype, 'openWorld').mockImplementation(async function (
      this: LibraryUploadArchives,
      ...args
    ) {
      const archive = await open.apply(this, args)
      const files = archive.files.map((file) =>
        file.name.endsWith('.mca') ? { ...file, sizeBytes: 8 * 1024 ** 3 } : file,
      )
      return new Proxy(archive, {
        get: (target, key) => {
          if (key === 'files') return files
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    })
    try {
      const view = await bringWorld(h, owner, id, zipBytes(await save('My World/')), { fileName: 'w.zip' })
      expect(view).toMatchObject({ status: 'refused' })
      expect(view.status === 'refused' && view.message).toMatch(
        /^This world is [\d.]+ GB unpacked, and this server has room for a world of up to [\d.]+ GB\.$/,
      )
    } finally {
      opened.mockRestore()
    }
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a world kept when recording it fails', () => {
  test('leaves no copy behind, and the retry keeps one', async () => {
    const { owner, id } = await server('Sage')
    const target = store.archiveTarget.bind(store)
    const written: string[] = []
    // A world made under the same folder while this one is written: Postgres refuses the second.
    const raced = spyOn(store, 'archiveTarget').mockImplementation(async (key) => {
      written.push(key)
      if (written.length === 1)
        await h.db.insert(schema.worlds).values({
          serverId: id,
          levelName: 'world-2',
          name: 'Made meanwhile',
          generatedOnVersion: '26.3',
        })
      return target(key)
    })
    try {
      const bytes = zipBytes(await save('My World/'))
      const start = await h.app.backups.beginWorldUpload(owner, id, {
        fileName: 'w.zip',
        sizeBytes: bytes.length,
      })
      await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
      const { importId } = await h.app.backups.finishWorldUpload(owner, id, start.ticket)
      // The first try failed, and its job waits to be tried again.
      const until = Date.now() + 60_000
      const stateOf = async () =>
        (
          await h.db.execute<{ state: string }>(
            sql`select state from pgboss.job where name = 'world-import' and data->>'importId' = ${importId}`,
          )
        ).rows[0]?.state
      while ((await stateOf()) !== 'retry' && Date.now() < until) await Bun.sleep(200)
      expect(await stateOf()).toBe('retry')
      expect(written).toHaveLength(1)
      expect(store.objects.has(written[0] as string)).toBe(false)
      // The retry, as the queue runs it once it comes due.
      await h.app.backups.imports.runImport(importId)
      const backup = await broughtBackup(h, await untilRead(h, owner, id, importId))
      expect(written).toHaveLength(2)
      expect(backup.archiveKey).toBe(written[1] as string)
    } finally {
      raced.mockRestore()
    }
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a world last played on a snapshot', () => {
  test('is taken, its snapshot said, since a snapshot’s name says nothing of the releases around it', async () => {
    const { owner, id } = await server('Tamsin')
    const files = await save('Snapshot World/')
    files['Snapshot World/level.dat'] = await savedOn(
      files['Snapshot World/level.dat'] as Uint8Array,
      '26.4-snapshot-1',
    )
    const view = await bringWorld(h, owner, id, zipBytes(files), { fileName: 'w.zip' })
    expect(view).toMatchObject({ status: 'ready' })
    expect(view.status === 'ready' && view.notes).toContain(
      'It was last played on the Minecraft snapshot 26.4-snapshot-1. A release older than that snapshot can’t open it.',
    )
    const world = (await listWorlds(h.db, id)).find((one) => one.name === 'Snapshot World')
    expect(world?.generatedOnVersion).not.toBe('26.4-snapshot-1')
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a Paper server’s folder with its plugins', () => {
  test('is plain Minecraft’s world, brought on a plan without mods, the plugins left out', async () => {
    const { owner, id } = await server('Ulla', 'free')
    const files = await serverFolder('paper-1.21.11')
    files['plugins/EssentialsX.jar'] = new TextEncoder().encode('a plugin')
    const view = await bringWorld(h, owner, id, zipBytes(files), { fileName: 'server.zip' })
    expect(view).toMatchObject({ status: 'ready' })
    if (view.status !== 'ready') return
    const dir = await unpacked((await broughtBackup(h, view)).archiveKey)
    expect((await run('ls', ['-A', dir])).stdout).not.toContain('plugins')
  }, 120_000)
})

describe.skipIf(!hasDatabase)('an upload that says it is a Cubepals download', () => {
  test('is written again where it holds what no download does: a jar never reaches the server', async () => {
    const { owner, id } = await server('Vale', 'free')
    const folder = await mkdtemp(join(scratch, 'claimed-'))
    const files = {
      ...(await serverFolder('paper-1.21.11')),
      'cubepals-download.txt': new TextEncoder().encode('Your world from Cubepals.\n'),
      'plugins/Backdoor.jar': new TextEncoder().encode('a plugin'),
    }
    for (const [path, bytes] of Object.entries(files)) {
      await run('mkdir', ['-p', join(folder, path, '..')])
      await writeFile(join(folder, path), bytes)
    }
    await run('tar', ['-czf', join(scratch, 'claimed.tar.gz'), '-C', folder, '.'])
    const view = await bringWorld(
      h,
      owner,
      id,
      new Uint8Array(await readFile(join(scratch, 'claimed.tar.gz'))),
      {
        fileName: 'claimed.tar.gz',
      },
    )
    const dir = await unpacked((await broughtBackup(h, view)).archiveKey)
    expect((await run('ls', ['-A', dir])).stdout).not.toContain('plugins')
  }, 120_000)
})
