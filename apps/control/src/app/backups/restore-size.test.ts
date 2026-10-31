// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a restore tells the server's page about the world it brings back, so the page's wait fits
 * it: a download's size, fetched from the store, and nothing for a snapshot.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import type { UserActor } from '../actor.ts'
import { listBackups } from './persistence.ts'

describe.skipIf(!hasDatabase)('the size of the world a restore brings back', () => {
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

  /** The restore's operation as the page reads it, held while it keeps the world it replaces. */
  const whileRestoring = async (owner: UserActor, id: string, backupId: string) => {
    const original = h.runtime.snapshot.bind(h.runtime)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const saving = spyOn(h.runtime, 'snapshot')
    saving.mockImplementationOnce(async (handle) => {
      await held
      return original(handle)
    })
    try {
      await h.app.backups.restoreBackup(owner, id, backupId, randomUUID(), { withConfiguration: false })
      await h.until(id, 'restoring')
      return (await h.app.queries.get(owner, id)).activeOperation
    } finally {
      release()
      await h.until(id, 'running', 30_000)
      await h.settled(id, 30_000)
      saving.mockRestore()
    }
  }

  test('a download says how big it is, and a snapshot says nothing', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const snapshot = (await listBackups(h.db, id)).find((b) => b.tier === 'snapshot' && b.status === 'ready')
    if (snapshot === undefined) throw new Error('No backup was taken')
    await h.app.backups.archiveBackup(owner, id, snapshot.id, randomUUID())
    await h.settled(id)
    const archive = (await listBackups(h.db, id)).find((b) => b.tier === 'archive' && b.status === 'ready')
    if (archive?.sizeBytes == null) throw new Error('No archive was kept')

    expect(await whileRestoring(owner, id, archive.id)).toMatchObject({
      kind: 'restore',
      worldBytes: archive.sizeBytes,
    })
    expect(await whileRestoring(owner, id, snapshot.id)).toMatchObject({ kind: 'restore', worldBytes: null })
  }, 60_000)
})
