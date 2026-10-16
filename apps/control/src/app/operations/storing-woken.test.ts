// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A rest a join cuts short: the start waits only for the rest's snapshot, never for its packing,
 * and the world never leaves its disk. The store is a real S3 server; the provider is the fake.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { listBackups } from '../backups/persistence.ts'

const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

describe.skipIf(!hasDatabase || !s3.endpoint || !s3.bucket)('a rest a join cuts short', () => {
  let h: Harness
  const store = new S3ArchiveStore({
    endpoint: s3.endpoint ?? '',
    bucket: s3.bucket ?? '',
    region: 'auto',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  })

  beforeAll(async () => {
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    const keys = await h.db
      .select({ key: schema.backups.archiveKey })
      .from(schema.backups)
      .where(sql`${schema.backups.archiveKey} is not null`)
    for (const { key } of keys) if (key) await store.delete(key)
    await h.close()
  })

  test('a start asked for before the snapshot is packed ends the rest there, packing nothing', async () => {
    const owner = await h.user('Rowan')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await writeFile(h.minecraft.path(id, 'world/built.txt'), "Rowan's castle")
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - 15 * DAY_MS) })
      .where(eq(schema.minecraftServers.id, id))

    // The rest is held at its first step, stopping the server for real; a join wakes it meanwhile.
    const release = h.runtime.holdStops(1)
    await h.app.schedules.storeSweep()
    for (let i = 0; i < 100; i++) {
      if ((await h.operations(id)).some((op) => op.kind === 'store' && op.step === 'saving')) break
      await Bun.sleep(50)
    }
    await h.app.servers.start(owner, id, randomUUID())
    release()
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)

    expect(await readFile(h.minecraft.path(id, 'world/built.txt'), 'utf8')).toBe("Rowan's castle")
    const stores = (await h.operations(id)).filter((op) => op.kind === 'store')
    expect(stores.map((op) => op.status)).toEqual(['cancelled'])
    // Nothing was packed: the start waited for the snapshot alone, which stays as a backup.
    const backups = await listBackups(h.db, id)
    expect(backups.filter((b) => b.tier === 'archive')).toEqual([])
    expect(backups.some((b) => b.tier === 'snapshot' && b.trigger === 'stored')).toBe(true)
  }, 60_000)
})
