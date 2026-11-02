// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A worker receives the destination account when it checks companion worlds, and records each stage. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { zipBytes } from '../../testing/uploads.ts'
import { serverFolder } from '../../testing/world-imports.ts'

let h: Harness
const store = new MemoryStore()
describe.skipIf(!hasDatabase)('new-world import worker', () => {
  beforeAll(async () => {
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)
  afterAll(async () => {
    await h.close()
    store.close()
  })
  test('a server folder checks its other worlds against the owner and keeps measured stages', async () => {
    const owner = await h.user('Other worlds', 'plus')
    const files = await serverFolder('paper-1.21.11')
    for (const [path, bytes] of Object.entries({ ...files }))
      if (path.startsWith('world/')) files[`creative/${path.slice('world/'.length)}`] = bytes
    const bytes = zipBytes(files)
    const queued = spyOn(h.jobs, 'enqueueWorldImport').mockResolvedValue(undefined)
    try {
      const start = await h.app.backups.newWorlds.begin(owner, {
        fileName: 'server.zip',
        sizeBytes: bytes.length,
      })
      await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
      const { importId } = await h.app.backups.newWorlds.finish(owner, start.ticket)
      await h.app.backups.imports.runImport(importId)
      const read = await h.app.backups.newWorlds.view(owner, importId)
      expect(read.status).toBe('ready')
      const row = await h.db.query.worldImports.findFirst({
        where: (table, { eq }) => eq(table.id, importId),
      })
      expect(row?.progress?.steps.map((entry) => entry.step)).toEqual([
        'fetching',
        'checking',
        'players',
        'packing',
        'saving',
      ])
      expect(read.status === 'ready' && read.notes.join(' ')).toContain('creative')
    } finally {
      queued.mockRestore()
    }
  })
})
