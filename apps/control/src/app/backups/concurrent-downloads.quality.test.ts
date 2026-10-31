// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Two requests that both find no download must share the copy won by one real database insert.
 * A barrier holds both initial reads before either inserts, so this checks conflict recovery
 * regardless of request scheduling, while the real queue and worker still make the download.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import * as records from './download-records.ts'
import { listBackups } from './persistence.ts'

describe('downloads whose initial reads race', () => {
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

  test('the losing insert returns the winning copy without enqueueing another download', async () => {
    const owner = await h.user('Steve', 'plus')
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.backups.createBackup(owner, server.id, randomUUID())
    await h.settled(server.id)
    const snapshot = (await listBackups(h.db, server.id)).find((backup) => backup.trigger === 'manual')
    if (!snapshot) throw new Error('No snapshot was made')
    await h.app.backups.archiveBackup(owner, server.id, snapshot.id, randomUUID())
    await h.settled(server.id)
    const archive = (await listBackups(h.db, server.id)).find((backup) => backup.tier === 'archive')
    if (!archive?.archiveKey) throw new Error('No archive was made')

    const bothRead = Promise.withResolvers<void>()
    const originalRead = records.liveDownload
    const originalInsert = records.insertDownload
    const initial: Array<records.DownloadRecord | null> = []
    const inserted: Array<records.DownloadRecord | null> = []
    const read = spyOn(records, 'liveDownload').mockImplementation(async (...args) => {
      const answer = await originalRead(...args)
      if (args[1] === archive.id && initial.length < 2) {
        initial.push(answer)
        if (initial.length === 2) bothRead.resolve()
        await bothRead.promise
      }
      return answer
    })
    const insert = spyOn(records, 'insertDownload').mockImplementation(async (...args) => {
      const answer = await originalInsert(...args)
      inserted.push(answer)
      return answer
    })
    const queued = spyOn(h.jobs, 'enqueueWorldDownload')
    const made = spyOn(h.app.backups.downloads, 'make')
    const pending: Array<ReturnType<typeof h.app.backups.downloads.ask>> = []
    const deadline = setTimeout(() => {
      bothRead.reject(new Error('Both requests did not reach the initial download lookup'))
    }, 10_000)
    try {
      pending.push(
        h.app.backups.downloads.ask(owner, server.id, archive.id),
        h.app.backups.downloads.ask(owner, server.id, archive.id),
      )
      const answers = await Promise.all(pending)
      expect(initial).toEqual([null, null])
      expect(inserted).toHaveLength(2)
      expect(inserted.filter((copy) => copy === null)).toHaveLength(1)
      const copies = await h.db
        .select()
        .from(schema.worldDownloads)
        .where(eq(schema.worldDownloads.backupId, archive.id))
      expect(copies).toHaveLength(1)
      const copy = copies[0]
      if (!copy) throw new Error('Neither request recorded a download')
      expect(copy.status).toBe('ready')
      expect(answers).toEqual([
        { status: 'ready', url: (await store.presignGet(copy.key)).url },
        { status: 'ready', url: (await store.presignGet(copy.key)).url },
      ])
      expect(queued).toHaveBeenCalledTimes(1)
      expect(queued.mock.calls[0]?.[1]).toBe(copy.id)
      expect(made).toHaveBeenCalledTimes(1)
      expect(made).toHaveBeenCalledWith(copy.id)
      const response = await fetch((await store.presignGet(copy.key)).url)
      expect(response.ok).toBe(true)
      if (copy.sizeBytes === null) throw new Error('The ready download has no recorded size')
      expect((await response.arrayBuffer()).byteLength).toBe(copy.sizeBytes)
    } finally {
      clearTimeout(deadline)
      bothRead.resolve()
      await Promise.allSettled(pending)
      read.mockRestore()
      insert.mockRestore()
      queued.mockRestore()
      made.mockRestore()
    }
  }, 60_000)
})
