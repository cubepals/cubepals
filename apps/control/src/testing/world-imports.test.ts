// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Import waiters preserve real refusals, detect unfinished jobs and reject a backup removed after an import. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { UserActor } from '../app/actor.ts'
import { loadRevision } from '../app/servers/persistence.ts'
import { Cdn } from './cdn.ts'
import { type Harness, hasDatabase, startHarness } from './harness.ts'
import { MemoryStore } from './memory-store.ts'
import { utf8, zipBytes } from './uploads.ts'
import { broughtBackup, save, untilNewRead, untilRead } from './world-imports.ts'

let h: Harness
const store = new MemoryStore()
const cdn = new Cdn()
let phases: Awaited<ReturnType<typeof preparedFixture>>
describe.skipIf(!hasDatabase)('world import waiters', () => {
  beforeAll(async () => {
    await store.start()
    await cdn.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
    phases = await preparedFixture()
  }, 30_000)
  afterAll(async () => {
    await h.close()
    store.close()
    cdn.close()
  })

  test('reading and a pending proof wait; completed outcomes return', pendingProof, 30_000)

  test('real refusals and a removed backup cannot appear as a ready backup', async () => {
    const owner = await h.user('Import waiter', 'plus')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const refused = await readUploaded(owner, id, zipBytes({ 'other.txt': utf8('No world') }))
    expect(refused.status).toBe('refused')
    if (refused.status !== 'refused') throw new Error('The actual importer did not refuse the non-world')
    await expect(broughtBackup(h, refused)).rejects.toThrow(refused.message)
    const ready = await readUploaded(owner, id, zipBytes(await save('world/')))
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

async function importedFixture() {
  const owner = await h.user('Import wait', 'plus')
  const serverId = (await h.create(owner, { loader: 'fabric' })).id
  await h.until(serverId, 'running')
  await h.settled(serverId)
  const bytes = zipBytes(await save('Life/'))
  const queued = spyOn(h.jobs, 'enqueueWorldImport').mockResolvedValue(undefined)
  try {
    const upload = await h.app.backups.beginWorldUpload(owner, serverId, {
      fileName: 'Life.zip',
      sizeBytes: bytes.length,
    })
    await fetch(upload.url, { method: 'PUT', body: bytes, headers: upload.headers })
    const { importId } = await h.app.backups.finishWorldUpload(owner, serverId, upload.ticket)
    const reading = await h.app.backups.imports.view(owner, serverId, importId)
    await h.app.backups.imports.runImport(importId)
    const finished = await h.app.backups.imports.view(owner, serverId, importId)
    if (finished.status !== 'ready') throw new Error('The actual fixture import was not kept')
    return { owner, serverId, reading, ready: finished }
  } finally {
    queued.mockRestore()
  }
}

async function preparedFixture() {
  const fixture = await importedFixture()
  const { serverId } = fixture
  const queued = spyOn(h.jobs, 'enqueueModValidation').mockResolvedValue(undefined)
  try {
    const revision = await loadRevision(h.db, (await h.server(serverId)).desiredRevisionId)
    const plan = await h.app.configuration.plan({ ...revision, mods: [cdn.publish(randomUUID())] })
    if (plan === null) throw new Error('No check for the modded fixture')
    const pending = await h.app.modValidation.request(plan)
    const verified = await h.app.modValidation.ensure(plan)
    const other = await h.app.modValidation.request({ ...plan, mods: [cdn.publish(randomUUID())] })
    await h.app.modValidation.importGaveUp(other.key, 'A temporary worker failure')
    const unavailable = await h.app.modValidation.status(other.key)
    expect(unavailable.state).toBe('unavailable')
    return { ...fixture, pending, verified, unavailable }
  } finally {
    queued.mockRestore()
  }
}

async function pendingProof() {
  const { owner, serverId, reading, ready, pending, verified, unavailable } = phases
  const watched = spyOn(h.app.backups.imports, 'view')
  let reads = 0
  try {
    watched.mockImplementation(async () => (++reads === 1 ? reading : ready))
    expect(await untilRead(h, owner, serverId, ready.importId, SECOND_MS / 2)).toEqual(ready)
    expect(reads).toBe(2)
    reads = 0
    watched.mockImplementation(async () => ({ ...ready, compatibility: ++reads === 1 ? pending : verified }))
    const result = await untilRead(h, owner, serverId, ready.importId, SECOND_MS / 2)
    expect(result.status === 'ready' && result.compatibility?.state).toBe('verified')
    expect(reads).toBe(2)
    for (const outcome of [ready, { ...ready, compatibility: unavailable }]) {
      watched.mockResolvedValue(outcome)
      expect(await untilRead(h, owner, serverId, ready.importId, SECOND_MS / 2)).toEqual(outcome)
    }
  } finally {
    watched.mockRestore()
  }
}

async function readUploaded(owner: UserActor, serverId: string, bytes: Uint8Array) {
  const upload = await h.app.backups.beginWorldUpload(owner, serverId, {
    fileName: 'world.zip',
    sizeBytes: bytes.length,
  })
  await fetch(upload.url, { method: 'PUT', body: bytes, headers: upload.headers })
  const { importId } = await h.app.backups.finishWorldUpload(owner, serverId, upload.ticket)
  return untilRead(h, owner, serverId, importId, SECOND_MS)
}
