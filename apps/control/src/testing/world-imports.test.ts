// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Import waiters preserve real refusals, detect unfinished jobs and reject a backup removed after an import. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from './harness.ts'
import { MemoryStore } from './memory-store.ts'
import { utf8, zipBytes } from './uploads.ts'
import { bringWorld, broughtBackup, save, untilNewRead, untilRead } from './world-imports.ts'

let h: Harness
const store = new MemoryStore()
describe.skipIf(!hasDatabase)('world import waiters', () => {
  beforeAll(async () => {
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)
  afterAll(async () => {
    await h.close()
    store.close()
  })

  test('real refusals and a removed backup cannot appear as a ready backup', async () => {
    const owner = await h.user('Import waiter', 'plus')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const refused = await bringWorld(h, owner, id, zipBytes({ 'other.txt': utf8('No world') }), {
      fileName: 'invalid.zip',
    })
    expect(refused.status).toBe('refused')
    if (refused.status !== 'refused') throw new Error('The actual importer did not refuse the non-world')
    await expect(broughtBackup(h, refused)).rejects.toThrow(refused.message)
    const ready = await bringWorld(h, owner, id, zipBytes(await save('world/')), { fileName: 'valid.zip' })
    const backup = await broughtBackup(h, ready)
    await h.db.delete(schema.worldImports).where(eq(schema.worldImports.backupId, backup.id))
    await h.db.delete(schema.backups).where(eq(schema.backups.id, backup.id))
    await expect(broughtBackup(h, ready)).rejects.toThrow('is missing')
  }, 30_000)

  test('real pending imports time out explicitly for existing and new servers', async () => {
    const owner = await h.user('Pending import', 'plus')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const enqueue = spyOn(h.jobs, 'enqueueWorldImport').mockResolvedValue(undefined)
    const bytes = zipBytes(await save('world/'))
    try {
      const upload = await h.app.backups.beginWorldUpload(owner, id, {
        fileName: 'pending.zip',
        sizeBytes: bytes.length,
      })
      await fetch(upload.url, { method: 'PUT', body: bytes, headers: upload.headers })
      const { importId } = await h.app.backups.finishWorldUpload(owner, id, upload.ticket)
      const pending = await h.app.backups.imports.view(owner, id, importId)
      await expect(broughtBackup(h, pending)).rejects.toThrow('reading')
      await expect(untilRead(h, owner, id, importId, 0)).rejects.toThrow('still being read')
      const fresh = await h.app.backups.newWorlds.begin(owner, {
        fileName: 'pending.zip',
        sizeBytes: bytes.length,
      })
      await fetch(fresh.url, { method: 'PUT', body: bytes, headers: fresh.headers })
      const next = await h.app.backups.newWorlds.finish(owner, fresh.ticket)
      await expect(untilNewRead(h, owner, next.importId, 0)).rejects.toThrow('still being read')
    } finally {
      enqueue.mockRestore()
    }
  }, 30_000)
})
