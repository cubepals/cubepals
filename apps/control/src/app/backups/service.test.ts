// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Importing and restoring a modded world use the BackupService's shared collaborators. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { fabricJar, zipBytes } from '../../testing/uploads.ts'
import { loadRevision } from '../servers/persistence.ts'

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
})

async function importedMods() {
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
  const { id } = await h.create(owner, { loader: 'vanilla', gameVersion: '26.3' })
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
    const read = await h.app.backups.imports.view(owner, id, importId)
    expect(read.status).toBe('ready')
    if (read.status !== 'ready') throw new Error('The modded world must be kept')
    expect(read.playedWith?.mods?.mods.map((mod) => mod.name)).toEqual(['Service mod'])
    await h.app.backups.restoreBackup(owner, id, read.backupId, randomUUID(), {
      withConfiguration: false,
      withMods: true,
    })
    await h.settled(id)
    const desired = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(desired.loader).toBe('fabric')
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
