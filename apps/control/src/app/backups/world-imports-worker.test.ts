// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The real worker connects stage and source-byte measurements to the streamed archive it saves. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { LibraryUploadArchives } from '../../infra/formats/world-archives.ts'
import { DOWNLOAD_NOTE, downloadNote, inWorldDownload } from '../../minecraft/world-download.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import { save, serverFolder } from '../../testing/world-imports.ts'
import { ImportProgress } from './import-progress.ts'

let h: Harness
const store = new MemoryStore()
describe.skipIf(!hasDatabase)('world import worker', () => {
  beforeAll(async () => {
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)
  afterAll(async () => {
    await h.close()
    store.close()
  })
  test(
    'packing finishes the exact source byte count before saving and keeps the measured stages',
    workerProgress,
    30_000,
  )
})

async function workerProgress() {
  const owner = await h.user('Worker progress', 'plus')
  const { id } = await h.create(owner)
  await h.until(id, 'running')
  await h.settled(id)
  for (const kind of ['plain', 'host', 'download'] as const) {
    const upload = await uploadOf(kind)
    const queued = spyOn(h.jobs, 'enqueueWorldImport').mockResolvedValue(undefined)
    const step = ImportProgress.prototype.step
    let importId = ''
    let checkedPacking = false
    const stages = spyOn(ImportProgress.prototype, 'step').mockImplementation(async function (
      this: ImportProgress,
      next,
      total,
    ) {
      if (next === 'saving') {
        const row = await h.db.query.worldImports.findFirst({
          where: (table, { eq }) => eq(table.id, importId),
        })
        expect(row?.progress?.step).toBe('packing')
        if (kind === 'plain') {
          expect(row?.progress?.totalBytes).toBeGreaterThan(0)
          expect(row?.progress?.bytes).toBe(row?.progress?.totalBytes)
        } else expect(row?.progress?.totalBytes).toBeNull()
        checkedPacking = true
      }
      await step.call(this, next, total)
    })
    try {
      const start = await h.app.backups.beginWorldUpload(owner, id, {
        fileName: upload.fileName,
        sizeBytes: upload.bytes.length,
      })
      await fetch(start.url, { method: 'PUT', body: upload.bytes, headers: start.headers })
      importId = (await h.app.backups.finishWorldUpload(owner, id, start.ticket)).importId
      await h.app.backups.imports.runImport(importId)
      if (kind === 'host') {
        await h.app.backups.imports.answer(owner, id, importId, { player: 'Alex' })
        await h.app.backups.imports.runImport(importId)
      }
      expect((await h.app.backups.imports.view(owner, id, importId)).status).toBe('ready')
      expect(checkedPacking).toBe(true)
      const row = await h.db.query.worldImports.findFirst({
        where: (table, { eq }) => eq(table.id, importId),
      })
      expect(row?.progress?.steps.map((entry) => entry.step)).toEqual([
        'fetching',
        'checking',
        'players',
        'mods',
        'packing',
        'saving',
      ])
    } finally {
      stages.mockRestore()
      queued.mockRestore()
    }
  }
}

async function uploadOf(kind: 'plain' | 'host' | 'download') {
  if (kind === 'host') return { bytes: zipBytes(await save('Life/', true)), fileName: 'Life.zip' }
  const files = await serverFolder('paper-1.21.11')
  if (kind === 'plain') return { bytes: zipBytes(files), fileName: 'server.zip' }
  files[DOWNLOAD_NOTE] = utf8(downloadNote([]))
  // A download excludes the server and plugin jars; its marker alone never establishes provenance.
  for (const name of Object.keys(files))
    if (name !== DOWNLOAD_NOTE && !inWorldDownload(name)) delete files[name]
  const entries = async function* () {
    for (const [name, data] of Object.entries(files)) yield { name, sizeBytes: data.length, data }
  }
  return {
    bytes: new Uint8Array(await new Response(new LibraryUploadArchives().tarball(entries())).arrayBuffer()),
    fileName: 'download.tar.gz',
  }
}
