// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Importing and restoring a modded world use the BackupService's shared collaborators. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { SECOND_MS } from '@blockly/contracts/durations'
import { type BroughtModsJson, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { fabricJar, zipBytes } from '../../testing/uploads.ts'
import { bringWorld, broughtBackup, save } from '../../testing/world-imports.ts'
import { loadRevision } from '../servers/persistence.ts'
import { BackupService } from './service.ts'
import { WorldImports } from './world-imports.ts'

let h: Harness
const store = new MemoryStore()
const cdn = new Cdn()

describe.skipIf(!hasDatabase)('backup service modded imports', () => {
  beforeAll(async () => {
    await store.start()
    await cdn.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)
  afterAll(async () => {
    await h.close()
    store.close()
    cdn.close()
  })
  test('the real importer and restore preserve the selected server mod', importedMods, 30_000)
  test('retained mod facts survive catalog outages and report their compatibility', retainedModView, 30_000)
})

async function importedMods() {
  expect(h.app.backups).toBeInstanceOf(BackupService)
  expect(h.app.backups.imports).toBeInstanceOf(WorldImports)
  const jar = fabricJar('service_mod', { name: 'Service mod' })
  h.catalog.publish(
    {
      projectId: 'service-mod',
      slug: 'service-mod',
      name: 'Service mod',
      summary: '',
      iconUrl: null,
      environments: ['server_only'],
      downloads: 1,
    },
    [
      {
        projectId: 'service-mod',
        versionId: 'service-mod-1',
        versionLabel: '1',
        channel: 'release',
        state: 'listed',
        environment: 'server_only',
        loaders: ['fabric'],
        gameVersions: ['26.3'],
        publishedAt: new Date('2026-10-01'),
        file: cdn.file('service-mod', jar),
        dependencies: [],
      },
    ],
  )
  const owner = await h.user('Service import', 'plus')
  const { id } = await h.create(owner, { loader: 'vanilla', gameVersion: '1.21.11' })
  await h.until(id, 'running')
  await h.settled(id)
  const bytes = zipBytes({
    'Prism/mmc-pack.json': await readFile(
      new URL('../../minecraft/instance-fixtures/prism-fabric-26.3/mmc-pack.json', import.meta.url),
    ),
    'Prism/minecraft/saves/Life/level.dat': await readFile(
      new URL('../../minecraft/player-fixtures/26.3/level.dat', import.meta.url),
    ),
    'Prism/minecraft/mods/service-mod.jar': jar,
  })
  const queued = spyOn(h.jobs, 'enqueueWorldImport').mockResolvedValue(undefined)
  try {
    const start = await h.app.backups.beginWorldUpload(owner, id, {
      fileName: 'Life.zip',
      sizeBytes: bytes.length,
    })
    await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
    const { importId } = await h.app.backups.finishWorldUpload(owner, id, start.ticket)
    await h.app.backups.imports.runImport(importId)
    let read = await h.app.backups.imports.view(owner, id, importId)
    const deadline = Date.now() + 5 * SECOND_MS
    while (read.status === 'ready' && read.compatibility?.state === 'checking' && Date.now() < deadline) {
      await Bun.sleep(10)
      read = await h.app.backups.imports.view(owner, id, importId)
    }
    expect(read.status).toBe('ready')
    if (read.status !== 'ready') throw new Error('The modded world must be kept')
    expect(read.compatibility?.state).toBe('verified')
    expect(read.playedWith?.mods?.mods.map((mod) => mod.name)).toEqual(['Service mod'])
    await h.app.backups.restoreBackup(owner, id, read.backupId, randomUUID(), {
      withConfiguration: false,
      withMods: true,
      moveUp: true,
    })
    await h.settled(id)
    const desired = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(desired.loader).toBe('fabric')
    expect(desired.gameVersion).toBe('26.3')
    expect(desired.mods.map((mod) => mod.name)).toEqual(['Service mod'])
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const points = await h.app.backupQueries.list(owner, id)
    expect(points.backups.some((backup) => backup.trigger === 'manual' && backup.status === 'ready')).toBe(
      true,
    )
    await h.app.backups.deleteBackup(owner, id, read.backupId)
    expect(
      (await h.app.backupQueries.list(owner, id)).backups.some((backup) => backup.id === read.backupId),
    ).toBe(false)
    expect((await h.server(id)).lifecycle.status).toBe('running')
  } finally {
    queued.mockRestore()
  }
}

async function retainedModView() {
  const owner = await h.user('Retained mod view', 'plus')
  const { id } = await h.create(owner, { loader: 'vanilla' })
  await h.until(id, 'running')
  await h.settled(id)
  const read = await bringWorld(h, owner, id, zipBytes(await save('Retained/')))
  expect(read.status === 'ready' && read.compatibility).toBeNull()
  const backup = await broughtBackup(h, read)
  if (backup.worldFacts === null) throw new Error('The actual import has no world facts')
  const mods: BroughtModsJson = {
    loader: 'fabric',
    catalog: [
      { name: 'Retained mod', fileName: 'retained.jar', projectId: 'retained', versionId: 'retained-1' },
    ],
    own: [],
    forPlayers: [],
    refused: [],
  }
  await h.db
    .update(schema.backups)
    .set({ worldFacts: { ...backup.worldFacts, mods } })
    .where(eq(schema.backups.id, backup.id))
  h.catalog.outage(true)
  try {
    const unavailable = await h.app.backups.imports.view(owner, id, read.importId)
    expect(unavailable.status).toBe('ready')
    if (unavailable.status !== 'ready') throw new Error('The retained import disappeared')
    expect(unavailable.playedWith?.mods?.mods.map((mod) => mod.name)).toEqual(['Retained mod'])
    expect(unavailable.compatibility?.state).toBe('unavailable')
    expect(unavailable.compatibility?.key).toBe('')
    expect(unavailable.compatibility?.message).toContain('Your world is imported; the check will be retried.')
  } finally {
    h.catalog.outage(false)
  }
  await h.db
    .update(schema.backups)
    .set({ worldFacts: { ...backup.worldFacts, mods, gameVersion: '99.1' } })
    .where(eq(schema.backups.id, backup.id))
  const blocked = await h.app.backups.imports.view(owner, id, read.importId)
  expect(blocked.status === 'ready' && blocked.compatibility?.state).toBe('blocked')
  expect(blocked.status === 'ready' && blocked.compatibility?.key).toBe('')
  await h.app.servers.stop(owner, id, randomUUID())
  await h.until(id, 'stopped')
  await h.settled(id)
}
