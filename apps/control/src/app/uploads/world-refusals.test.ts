// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world upload that reading stops short of, through a real S3 store and the real reader: the
 * player is told which limit stopped it and what to do, and nothing is kept as a backup.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { LibraryFileFormats } from '../../infra/formats/file-formats.ts'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { levelDat } from '../../testing/uploads.ts'
import type { UserActor } from '../actor.ts'
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
  // Answers, then sends nothing: a download that never finishes arriving.
  let stalled: Server
  let stalledUrl = ''
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
    stalled = createServer((_request, response) => response.writeHead(200).write(''))
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve))
    stalledUrl = `http://127.0.0.1:${(stalled.address() as AddressInfo).port}/world.tar.gz`
  }, 30_000)

  afterAll(async () => {
    stalled.closeAllConnections()
    stalled.close()
    await h.close()
    await rm(scratch, { recursive: true, force: true })
  })

  /** A server's storage, packed as a download is. */
  const tarball = async (files: Record<string, string | Uint8Array>) => {
    const dir = join(scratch, randomUUID())
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, 'volume', path, '..'), { recursive: true })
      await writeFile(join(dir, 'volume', path), content)
    }
    await run('tar', ['-czf', join(dir, 'world.tar.gz'), '-C', join(dir, 'volume'), '.'])
    return new Uint8Array(await readFile(join(dir, 'world.tar.gz')))
  }
  const refusal = async (owner: UserActor, id: string, bytes: Uint8Array) => {
    const start = await h.app.backups.beginWorldUpload(owner, id, {
      fileName: 'world.tar.gz',
      sizeBytes: bytes.length,
    })
    const put = await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
    expect(put.status).toBe(200)
    return h.app.backups.finishWorldUpload(owner, id, start.ticket).then(
      () => null,
      (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }),
    )
  }
  /**
   * The real reader, held to a tighter limit than a real world needs to reach, and reading `from`
   * in place of the store when given.
   */
  const tightened = (limits: { maxInflatedBytes?: number; deadlineMs?: number }, from?: () => string) => {
    const read = LibraryFileFormats.prototype.readTarball
    return spyOn(LibraryFileFormats.prototype, 'readTarball').mockImplementation(function (
      this: LibraryFileFormats,
      url,
      options,
    ) {
      return read.call(this, from?.() ?? url, { ...options, ...limits })
    })
  }

  test('the player is told which limit stopped it, and what to do', async () => {
    // Free reads every download whole, looking for mods, so it reads as far as any limit.
    const owner = await h.user('Steve', 'free')
    const { id } = await h.create(owner, { loader: 'vanilla' })
    const world = { 'server.properties': 'level-name=world\n', 'world/level.dat': levelDat('26.3') }

    const manyWorlds: Record<string, string | Uint8Array> = { ...world }
    for (let i = 0; i < 70; i++) manyWorlds[`world_${i}/level.dat`] = levelDat('26.3')
    expect(await refusal(owner, id, await tarball(manyWorlds))).toEqual({
      code: 'invalid_upload',
      message: 'This download holds more worlds than one server runs. Upload one server’s download.',
    })

    // Inflated a megabyte at a time, so the first counted is already past this.
    const small = tightened({ maxInflatedBytes: 1000 })
    try {
      expect(await refusal(owner, id, await tarball(world))).toEqual({
        code: 'invalid_upload',
        message: 'This world is larger than any Cubepals server holds.',
      })
    } finally {
      small.mockRestore()
    }

    // Read from a download that never finishes, so only the deadline ends it.
    const slow = tightened({ deadlineMs: 200 }, () => stalledUrl)
    try {
      expect(await refusal(owner, id, await tarball(world))).toEqual({
        code: 'invalid_upload',
        message:
          'Reading this world took too long. Try a smaller world, or write to support and we’ll help bring this one in.',
      })
    } finally {
      slow.mockRestore()
    }

    expect((await listBackups(h.db, id)).filter((b) => b.trigger === 'uploaded')).toEqual([])
  }, 60_000)
})
