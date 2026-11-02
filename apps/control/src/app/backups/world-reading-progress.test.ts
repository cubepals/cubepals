// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real store downloads report their exact bytes before checking replaces the current stage. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryFileFormats } from '../../infra/formats/file-formats.ts'
import { LibraryUploadArchives } from '../../infra/formats/world-archives.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { zipBytes } from '../../testing/uploads.ts'
import { save } from '../../testing/world-imports.ts'
import { loadPendingUpload } from '../uploads/persistence.ts'
import { ImportProgress } from './import-progress.ts'
import { Refused, SAID, WorldReading } from './world-reading.ts'

let h: Harness
const store = new MemoryStore()
describe.skipIf(!hasDatabase)('world download progress', () => {
  beforeAll(async () => {
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)
  afterAll(async () => {
    await h.close()
    store.close()
  })
  test(
    'a larger replacement is refused, while a missing store object remains an infrastructure failure',
    downloadFailures,
  )
  test(
    'fetching completes its exact byte count and the same reader works without a progress observer',
    downloadProgress,
  )
})

async function uploadedRead() {
  const owner = await h.user('Reading progress', 'plus')
  const bytes = zipBytes(await save('Life/'))
  const work = await mkdtemp(join(tmpdir(), 'world-reading-progress-'))
  const queued = spyOn(h.jobs, 'enqueueWorldImport').mockResolvedValue(undefined)
  const close = async () => {
    queued.mockRestore()
    await rm(work, { recursive: true, force: true })
  }
  try {
    const start = await h.app.backups.newWorlds.begin(owner, {
      fileName: 'Life.zip',
      sizeBytes: bytes.length,
    })
    await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
    const { importId } = await h.app.backups.newWorlds.finish(owner, start.ticket)
    const pending = await loadPendingUpload(h.db, importId)
    if (pending === null) throw new Error('The uploaded world must exist')
    const reader = new WorldReading({
      db: h.db,
      capabilities: { archives: store, billing: null },
      formats: new LibraryFileFormats(),
      archives: new LibraryUploadArchives(),
      profiles: h.profiles,
    })
    return { owner, bytes, work, importId, pending, reader, close }
  } catch (error) {
    await close()
    throw error
  }
}

async function downloadProgress() {
  const { owner, bytes, work, importId, pending, reader, close } = await uploadedRead()
  try {
    const progress = new ImportProgress(h.db, importId)
    const step = progress.step.bind(progress)
    const watched = spyOn(progress, 'step').mockImplementation(async (next, total) => {
      if (next === 'checking') {
        const view = await h.app.backups.newWorlds.view(owner, importId)
        expect(view).toMatchObject({
          status: 'reading',
          progress: { step: 'fetching', bytes: bytes.length, totalBytes: bytes.length },
        })
      }
      await step(next, total)
    })
    try {
      const archive = await reader.open(pending, work, progress)
      try {
        expect(archive.kept.has('Life/level.dat')).toBe(true)
        expect(await h.app.backups.newWorlds.view(owner, importId)).toMatchObject({
          status: 'reading',
          progress: {
            step: 'checking',
            bytes: 0,
            totalBytes: null,
            steps: [
              { step: 'fetching', at: expect.any(String) },
              { step: 'checking', at: expect.any(String) },
            ],
          },
        })
      } finally {
        await archive.close()
      }
    } finally {
      watched.mockRestore()
    }
    const without = await reader.open(pending, work)
    try {
      expect(without.kept.has('Life/level.dat')).toBe(true)
    } finally {
      await without.close()
    }
  } finally {
    await close()
  }
}

async function downloadFailures() {
  const { bytes, work, pending, reader, close } = await uploadedRead()
  try {
    store.objects.set(pending.key, Buffer.concat([bytes, Buffer.alloc(100)]))
    await expect(reader.open(pending, work)).rejects.toThrow(SAID.tooLarge)
    store.objects.delete(pending.key)
    const failure = await reader.open(pending, work).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(Refused)
  } finally {
    await close()
  }
}
