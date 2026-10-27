// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world upload that reading stops short of, through a real S3 store and the real reader: the
 * player is told why and what to do, nothing is kept as a backup, and the upload goes.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { LibraryUploadArchives } from '../../infra/formats/world-archives.ts'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { levelDat } from '../../testing/uploads.ts'
import { bringWorld } from '../../testing/world-imports.ts'
import { listBackups } from '../backups/persistence.ts'

const run = promisify(execFile)

const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

describe.skipIf(!hasDatabase || !s3.endpoint || !s3.bucket)('a world upload read no further', () => {
  let h: Harness
  let scratch: string
  const store = new S3ArchiveStore({
    endpoint: s3.endpoint ?? '',
    bucket: s3.bucket ?? '',
    region: 'auto',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  })

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'blockly-world-refusals-'))
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    await h.close()
    await rm(scratch, { recursive: true, force: true })
  })

  /** A folder packed as GNU tar packs it, after `prepare` has done what a test needs on disk. */
  const tarball = async (
    files: Record<string, string | Uint8Array>,
    prepare?: (dir: string) => Promise<void>,
  ) => {
    const dir = join(scratch, randomUUID())
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, 'volume', path, '..'), { recursive: true })
      await writeFile(join(dir, 'volume', path), content)
    }
    await prepare?.(join(dir, 'volume'))
    await run('tar', ['-czf', join(dir, 'world.tar.gz'), '-C', join(dir, 'volume'), '.'])
    return new Uint8Array(await readFile(join(dir, 'world.tar.gz')))
  }
  const world = { 'server.properties': 'level-name=world\n', 'world/level.dat': levelDat('26.3') }

  test('the player is told why, and nothing of the upload is kept', async () => {
    const owner = await h.user('Steve', 'free')
    const { id } = await h.create(owner, { loader: 'vanilla' })

    // Opened to a tighter limit than any real world reaches, as if it were larger than any disk.
    const open = LibraryUploadArchives.prototype.openWorld
    const tight = spyOn(LibraryUploadArchives.prototype, 'openWorld').mockImplementation(function (
      this: LibraryUploadArchives,
      path,
      limits,
    ) {
      return open.call(this, path, { ...limits, maxTotalBytes: 10 })
    })
    try {
      expect(await bringWorld(h, owner, id, await tarball(world))).toMatchObject({
        status: 'refused',
        message: 'This world is larger than any Cubepals server holds.',
      })
    } finally {
      tight.mockRestore()
    }

    // A link in the world could reach outside it once unpacked on the server.
    const linked = await tarball(world, (dir) => symlink('/etc/passwd', join(dir, 'world', 'region')))
    expect(await bringWorld(h, owner, id, linked)).toMatchObject({
      status: 'refused',
      message: 'Cubepals can’t open this file safely. Zip the world’s folder again and upload that.',
    })

    // A gzip that is no tarball inside.
    expect(
      await bringWorld(h, owner, id, new Uint8Array(Bun.gzipSync(new TextEncoder().encode('no tarball')))),
    ).toMatchObject({
      status: 'refused',
      message:
        'This file isn’t a zip or a .tar.gz, or it was cut short. Zip the world’s folder and upload that.',
    })

    expect((await listBackups(h.db, id)).filter((b) => b.trigger === 'uploaded')).toEqual([])
    const pending = await h.db
      .select()
      .from(schema.pendingUploads)
      .where(eq(schema.pendingUploads.serverId, id))
    expect(pending).toEqual([])
  }, 60_000)
})
