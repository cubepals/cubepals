// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A backup a queued archive or restore will read, when retention runs first: the backup stays
 * until they have read it, and the next pass brings the count back to the plan's.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { listBackups } from './persistence.ts'

// The free plan keeps three restore points.
const KEPT = 3

describe.skipIf(!hasDatabase)('retention with an archive and a restore waiting', () => {
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

  test('keeps the oldest backup until both have read it, then trims it', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    for (let i = 0; i < KEPT; i++) {
      await h.app.backups.createBackup(owner, id, randomUUID())
      await h.settled(id)
    }
    const snapshots = async () =>
      (await listBackups(h.db, id)).filter((b) => b.tier === 'snapshot' && b.status === 'ready')
    const oldest = (await snapshots()).at(-1)
    if (oldest === undefined) throw new Error('No backup was taken')

    // A backup that takes a while to save, with the archive and the restore asked for behind it.
    const original = h.runtime.snapshot.bind(h.runtime)
    const saving = spyOn(h.runtime, 'snapshot')
    saving.mockImplementationOnce(async (handle) => {
      await Bun.sleep(1_000)
      return original(handle)
    })
    try {
      await h.app.backups.createBackup(owner, id, randomUUID())
      // The restore cancels a backup still waiting, so it is asked for once this one is saving.
      for (
        let i = 0;
        i < 400 && !(await h.operations(id)).some((op) => op.kind === 'backup' && op.status === 'running');
        i++
      )
        await Bun.sleep(50)
      await h.app.backups.archiveBackup(owner, id, oldest.id, randomUUID())
      await h.app.backups.restoreBackup(owner, id, oldest.id, randomUUID(), { withConfiguration: false })
      await h.until(id, 'running', 30_000)
      await h.settled(id, 30_000)
    } finally {
      saving.mockRestore()
    }

    const ops = await h.operations(id)
    for (const kind of ['backup', 'archive', 'restore'] as const)
      expect(ops.filter((op) => op.kind === kind).at(-1)).toMatchObject({ status: 'succeeded' })

    // Nothing queued reads it now: the next pass trims it, and the plan's count is back.
    await h.app.backups.enforceRetention(await h.server(id))
    const left = (await snapshots()).filter((b) => b.trigger !== 'pre_restore')
    expect(left.length).toBeLessThanOrEqual(KEPT)
    expect(left.map((b) => b.id)).not.toContain(oldest.id)
  }, 60_000)
})
