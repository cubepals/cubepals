// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A restore whose backup went while it waited in the server's queue (behind a long archive
 * export, and expired by the daily sweep meanwhile) changes nothing: the server goes on as it
 * was, running, on what it ran, and the restore says the backup was gone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { listBackups } from '../backups/persistence.ts'

describe.skipIf(!hasDatabase)('a restore whose backup went while it waited', () => {
  let h: Harness
  const store = new MemoryStore()

  beforeAll(async () => {
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    await h?.close()
    store.close()
  })

  test('leaves the server as it was, running, not failed', async () => {
    const owner = await h.user('Tess', 'plus')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [newer, older] = (await listBackups(h.db, id)).filter((b) => b.trigger === 'manual')
    if (newer === undefined || older === undefined) throw new Error('two backups expected')
    const ran = (await h.server(id)).activeWorldId

    // A download of the newer one is packing (a big world takes a while); the owner restores the older.
    const release = h.runtime.holdExports(1)
    await h.app.backups.archiveBackup(owner, id, newer.id, randomUUID())
    for (
      let i = 0;
      i < 100 && !(await h.operations(id)).some((o) => o.kind === 'archive' && o.status === 'running');
      i++
    )
      await Bun.sleep(50)
    await h.app.backups.restoreBackup(owner, id, older.id, randomUUID(), { withConfiguration: false })
    // The daily sweep finds the older snapshot past its lifetime meanwhile.
    await h.db
      .update(schema.backups)
      .set({ expiresAt: new Date(Date.now() - MINUTE_MS) })
      .where(eq(schema.backups.id, older.id))
    await h.app.schedules.backups()
    release()
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)

    const server = await h.server(id)
    expect(server.lifecycle.status).toBe('running')
    expect(server.activeWorldId).toBe(ran)
    const restore = (await h.operations(id)).find((o) => o.kind === 'restore')
    expect(restore?.status).toBe('failed')
  }, 60_000)
})
