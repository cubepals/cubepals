// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world brought in from a newer Minecraft than its server runs (docs/world-import.md § Which
 * Minecraft): kept rather than refused after its upload, and its server moved up to it when its
 * owner restores it and chooses that. The store is a real S3 server, as for every upload.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { levelDat } from '../../testing/uploads.ts'
import { bringWorld, broughtBackup } from '../../testing/world-imports.ts'
import { loadRevision } from '../servers/persistence.ts'
import { movesUpTo, newerRelease } from './moved-up.ts'

const run = promisify(execFile)

const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

describe.skipIf(!hasDatabase || !s3.endpoint || !s3.bucket)('a world from a newer Minecraft', () => {
  let h: Harness
  let scratch: string
  /** A server's folder, packed as a download from another host comes. */
  const tarball = async (files: Record<string, string | Uint8Array>) => {
    const dir = join(scratch, randomUUID())
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, 'volume', path, '..'), { recursive: true })
      await writeFile(join(dir, 'volume', path), content)
    }
    await run('tar', ['-czf', join(dir, 'world.tar.gz'), '-C', join(dir, 'volume'), '.'])
    return new Uint8Array(await readFile(join(dir, 'world.tar.gz')))
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'blockly-newer-'))
    const store = new S3ArchiveStore({
      endpoint: s3.endpoint ?? '',
      bucket: s3.bucket ?? '',
      region: 'auto',
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    })
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    await h.close()
    await rm(scratch, { recursive: true, force: true })
  })

  test('is kept, and restoring it moves the server up, as its owner chooses', async () => {
    const owner = await h.user('Steve', 'plus')
    const { id } = await h.create(owner, { loader: 'vanilla', gameVersion: '1.21.11' })
    await h.until(id, 'running')
    await h.settled(id)
    const world = await tarball({
      'server.properties': 'level-name=world\n',
      'world/level.dat': levelDat('26.3'),
    })
    const read = await bringWorld(h, owner, id, world)
    expect(read.status).toBe('ready')
    expect(read.status === 'ready' ? read.notes : []).toContain(
      'It was last played on Minecraft 26.3, newer than this server’s 1.21.11. Restoring it moves the server up to 26.3.',
    )
    const backup = await broughtBackup(h, read)
    const shown = async () =>
      (await h.app.backupQueries.list(owner, id)).backups.find((b) => b.id === backup.id)
    expect((await shown())?.newerWorld).toEqual({ gameVersion: '26.3', movesServer: true })

    // Moving up can't be undone, so a restore that didn't choose it is refused, saying how.
    const refused = await h.app.backups
      .restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false })
      .then(
        () => null,
        (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }),
      )
    expect(refused).toEqual({
      code: 'version_downgrade',
      message:
        "This world was last played on Minecraft 26.3, newer than this server's 1.21.11. Restore it moving the server up to 26.3.",
    })

    await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), {
      withConfiguration: false,
      moveUp: true,
    })
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect((await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).gameVersion).toBe('26.3')
    expect((await shown())?.newerWorld).toBeNull()
  }, 90_000)
})

describe('what restoring a world from a newer Minecraft takes', () => {
  const plain = { gameVersion: '26.2', mods: [], modpack: null }

  test('only a release is newer: a snapshot’s name orders against none', () => {
    expect(newerRelease('26.3', '26.2')).toBe('26.3')
    expect(newerRelease('24w14a', '1.21.11')).toBeNull()
    expect(movesUpTo({ gameVersion: '24w14a' }, plain, undefined)).toBeNull()
    expect(movesUpTo({ gameVersion: '26.1' }, plain, undefined)).toBeNull()
  })

  test('a server with mods changes version in its settings first, whatever the restore asks', () => {
    const modded = { ...plain, mods: [{} as never] }
    expect(() => movesUpTo({ gameVersion: '26.3' }, modded, true)).toThrow(
      "This world was last played on Minecraft 26.3, newer than this server's 26.2. Change the server to 26.3 in Settings, so its mods move with it, then restore the world.",
    )
    expect(movesUpTo({ gameVersion: '26.3' }, plain, true)).toBe('26.3')
  })
})
