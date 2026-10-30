// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world brought in from a newer Minecraft than its server runs (docs/world-import.md § Which
 * Minecraft): kept rather than refused after its upload, and its server moved up to it when its
 * owner restores it and chooses that. The store is a real S3 server, as for every upload.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { zipSync } from 'fflate'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { levelDat } from '../../testing/uploads.ts'
import { bringWorld, broughtBackup } from '../../testing/world-imports.ts'
import { loadRevision } from '../servers/persistence.ts'

const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

describe.skipIf(!hasDatabase || !s3.endpoint || !s3.bucket)('a world from a newer Minecraft', () => {
  let h: Harness

  beforeAll(async () => {
    const store = new S3ArchiveStore({
      endpoint: s3.endpoint ?? '',
      bucket: s3.bucket ?? '',
      region: 'auto',
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    })
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(() => h.close())

  test('is kept, and restoring it moves the server up, as its owner chooses', async () => {
    const owner = await h.user('Steve', 'plus')
    const { id } = await h.create(owner, { loader: 'vanilla', gameVersion: '1.21.11' })
    await h.until(id, 'running')
    await h.settled(id)
    const world = zipSync({
      'server.properties': new TextEncoder().encode('level-name=world\n'),
      'world/level.dat': levelDat('26.3'),
    })
    const read = await bringWorld(h, owner, id, world, { fileName: 'world.zip' })
    expect(read.status).toBe('ready')
    expect(read.status === 'ready' ? read.notes : []).toContain(
      'It was last played on Minecraft 26.3, newer than this server’s 1.21.11. Restoring it moves the server up to 26.3.',
    )
    const backup = await broughtBackup(h, read)
    const shown = async () =>
      (await h.app.backupQueries.list(owner, id)).backups.find((b) => b.id === backup.id)
    expect((await shown())?.movesServerTo).toBe('26.3')

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
    expect((await shown())?.movesServerTo).toBeNull()
  }, 90_000)
})
