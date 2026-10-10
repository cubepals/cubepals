// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * World downloads end to end: an archive in a real S3 store, copied on a worker for its owner to
 * download, holding the world and what is theirs and leaving out what Blockly may not hand on,
 * while the archive itself stays whole for restores; made once and handed out again, gone after a
 * day or with its archive; and the note it carries, read when it comes back.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { downloadNote } from '../../minecraft/world-download.ts'
import { downloaded } from '../../testing/downloads.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { levelDat } from '../../testing/uploads.ts'
import type { UserActor } from '../actor.ts'
import { AppError } from '../errors.ts'
import { listBackups } from './persistence.ts'

const run = promisify(execFile)

const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

const enabled = hasDatabase && Boolean(s3.endpoint) && Boolean(s3.bucket)
let h: Harness
const store = new S3ArchiveStore({
  endpoint: s3.endpoint ?? '',
  bucket: s3.bucket ?? '',
  region: 'auto',
  accessKeyId: s3.accessKeyId,
  secretAccessKey: s3.secretAccessKey,
})
const written: string[] = []
const scratches: string[] = []

beforeAll(async () => {
  if (enabled) h = await startHarness({ capabilities: { archives: store, billing: null } })
}, 30_000)

afterAll(async () => {
  if (!enabled) return
  await h.close()
  for (const key of written) await store.delete(key)
  for (const dir of scratches) await rm(dir, { recursive: true, force: true })
})

const server = async (plan: string, loader: 'fabric' | 'vanilla') => {
  const owner = await h.user('Steve', plan)
  const created = await h.create(owner, { loader })
  await h.until(created.id, 'running')
  await h.settled(created.id)
  return { owner, id: created.id }
}

/** An archive of the server's world as it is now. */
const archived = async (owner: UserActor, id: string) => {
  await h.app.backups.createBackup(owner, id, randomUUID())
  await h.settled(id)
  const [snapshot] = (await listBackups(h.db, id)).filter((b) => b.trigger === 'manual')
  await h.app.backups.archiveBackup(owner, id, snapshot?.id ?? '', randomUUID())
  await h.settled(id)
  const [archive] = (await listBackups(h.db, id)).filter((b) => b.tier === 'archive')
  if (archive?.archiveKey == null) throw new Error('No archive was made')
  written.push(archive.archiveKey)
  return archive
}
const copiesOf = (backupId: string) =>
  h.db.select().from(schema.worldDownloads).where(eq(schema.worldDownloads.backupId, backupId))

/** A tarball's files, unpacked into a directory of their own, by path. */
const unpacked = async (tarball: Uint8Array) => {
  const dir = await mkdtemp(join(tmpdir(), 'blockly-download-'))
  scratches.push(dir)
  await writeFile(join(dir, 'world.tar.gz'), tarball)
  await mkdir(join(dir, 'out'))
  await run('tar', ['-xzf', join(dir, 'world.tar.gz'), '-C', join(dir, 'out')])
  const files = (await readdir(join(dir, 'out'), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(join(dir, 'out'), join(entry.parentPath, entry.name)))
  return {
    files,
    read: (path: string, encoding: 'utf8' | null = 'utf8') => readFile(join(dir, 'out', path), encoding),
  }
}

describe.skipIf(!enabled)('a world download', () => {
  test('a download holds the world and what is the owner’s, and the archive stays whole', async () => {
    const { owner, id } = await server('plus', 'fabric')
    const files: Record<string, string> = {
      'world/built.txt': 'the castle',
      'world/datapacks/castle-loot.zip': 'a datapack the owner added',
      'world/datapacks/towers/pack.mcmeta': '{}',
      'config/create-common.toml': 'speed = 2',
      'minecraft_server.26.3.jar': 'Mojang’s',
      'fabric-server-mc.26.3-loader.0.17.2-launcher.1.1.0.jar': 'the launcher',
      'libraries/net/fabricmc/fabric-loader/0.17.2/fabric-loader-0.17.2.jar': 'the loader',
      'libraries/natives/lwjgl.so': 'a native library',
      'versions/26.3/server-26.3.jar': 'unpacked',
      '.fabric/server/26.3-server.jar': 'remapped',
      '.fabric-manifest.json': '{}',
      'mods/create.jar': 'a mod',
    }
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(h.minecraft.path(id, path)), { recursive: true })
      await writeFile(h.minecraft.path(id, path), text)
    }
    const archive = await archived(owner, id)

    const download = await unpacked(await downloaded(h.app, owner, id, archive.id))
    expect(download.files).toEqual(
      expect.arrayContaining([
        'world/built.txt',
        'world/datapacks/castle-loot.zip',
        'world/datapacks/towers/pack.mcmeta',
        'config/create-common.toml',
        'server.properties',
        'whitelist.json',
      ]),
    )
    expect(download.files.filter((path) => /\.jar$|^libraries\/|^versions\/|^\./.test(path))).toEqual([])
    // Its note says what is missing, naming the mods it was played with.
    expect(await download.read('cubepals-download.txt')).toBe(downloadNote(['mods/create.jar']))

    // The archive itself, as a restore reads it, still holds everything.
    const { url } = await store.presignGet(archive.archiveKey ?? '', 60, 'runtime')
    const whole = await unpacked(new Uint8Array(await (await fetch(url)).arrayBuffer()))
    expect(whole.files).toEqual(expect.arrayContaining(Object.keys(files)))
    expect(whole.files).not.toContain('cubepals-download.txt')
  }, 60_000)

  test('a download without its mods is known by its note, and refused where mods don’t run', async () => {
    const { owner, id } = await server('free', 'vanilla')
    const download = await (async () => {
      const dir = await mkdtemp(join(tmpdir(), 'blockly-download-'))
      scratches.push(dir)
      await mkdir(join(dir, 'in', 'world'), { recursive: true })
      await writeFile(join(dir, 'in', 'server.properties'), 'level-name=world\n')
      await writeFile(join(dir, 'in', 'world', 'level.dat'), levelDat('26.3'))
      await writeFile(join(dir, 'in', 'cubepals-download.txt'), downloadNote(['mods/create.jar']))
      await run('tar', ['-czf', join(dir, 'world.tar.gz'), '-C', join(dir, 'in'), '.'])
      return new Uint8Array(await readFile(join(dir, 'world.tar.gz')))
    })()
    const start = await h.app.backups.beginWorldUpload(owner, id, {
      fileName: 'world.tar.gz',
      sizeBytes: download.length,
    })
    await fetch(start.url, { method: 'PUT', body: download, headers: start.headers })
    const refused = await h.app.backups.finishWorldUpload(owner, id, start.ticket).catch((e) => e)
    expect(refused).toBeInstanceOf(AppError)
    expect((refused as AppError).code).toBe('not_entitled')
  }, 60_000)
})

describe.skipIf(!enabled)('a world download’s copy', () => {
  test('a copy is made once when asked twice at the same time, then handed out again', async () => {
    const { owner, id } = await server('plus', 'vanilla')
    const archive = await archived(owner, id)
    const made = spyOn(h.app.backups.downloads, 'make')
    try {
      const both = await Promise.all([
        h.app.backups.downloads.ask(owner, id, archive.id),
        h.app.backups.downloads.ask(owner, id, archive.id),
      ])
      expect(both.map((state) => state.status)).toEqual(['ready', 'ready'])
      expect(await copiesOf(archive.id)).toHaveLength(1)
      // Asked again later, the same copy is handed out: nothing more is made.
      const again = await h.app.backups.downloads.ask(owner, id, archive.id)
      expect(again.status).toBe('ready')
      expect(await copiesOf(archive.id)).toHaveLength(1)
      expect(made).toHaveBeenCalledTimes(1)
    } finally {
      made.mockRestore()
    }
  }, 60_000)

  test('a copy goes once its day is past, and with its archive', async () => {
    const { owner, id } = await server('plus', 'vanilla')
    // 9 MiB that doesn't compress: more than one PUT here, so the copy goes in parts.
    const region = randomBytes(9 * 1024 ** 2)
    await writeFile(h.minecraft.path(id, 'world/region.mca'), region)
    const archive = await archived(owner, id)
    const whole = await unpacked(await downloaded(h.app, owner, id, archive.id))
    expect(Buffer.from(await whole.read('world/region.mca', null)).equals(region)).toBe(true)
    const [copy] = await copiesOf(archive.id)
    expect(await store.head(copy?.key ?? '')).not.toBeNull()
    // Past its day, the sweep erases it, and the next ask makes a new one.
    await h.db
      .update(schema.worldDownloads)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.worldDownloads.backupId, archive.id))
    await h.app.backups.eraseArchives()
    expect(await copiesOf(archive.id)).toEqual([])
    expect(await store.head(copy?.key ?? '')).toBeNull()
    await downloaded(h.app, owner, id, archive.id)
    const [next] = await copiesOf(archive.id)
    // Deleting the archive deletes its copy.
    await h.app.backups.deleteBackup(owner, id, archive.id)
    expect(await copiesOf(archive.id)).toEqual([])
    expect(await store.head(next?.key ?? '')).toBeNull()
  }, 60_000)
})
