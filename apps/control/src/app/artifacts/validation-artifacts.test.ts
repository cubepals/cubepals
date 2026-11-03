// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Validation credentials read only their pinned mod, companion and pack bytes until the lease expires. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { type ModValidationPlanJson, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { defaultSettings } from '../../domain/revision/revision.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import { validationKey } from '../mods/validation-plan.ts'
import { validationArtifact } from './validation-artifacts.ts'

describe.skipIf(!hasDatabase)('validation artifact ownership', () => {
  let h: Harness
  const cdn = new Cdn()
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
    cdn.close()
  })
  test(
    'downloads include exact companion and pack bytes and expire together',
    () => scopedDownloads(h, cdn),
    30_000,
  )
})

async function scopedDownloads(h: Harness, cdn: Cdn) {
  const owner = await h.user('Normal downloads', 'plus')
  const server = await h.create(owner, { loader: 'vanilla' })
  await h.until(server.id, 'running')
  await h.settled(server.id)
  expect(await validationArtifact(h.db, server.id, '0'.repeat(128))).toBeUndefined()
  const mod = cdn.publish('scope-main'),
    companion = cdn.publish('scope-companion')
  const base: ModValidationPlanJson = {
    gameVersion: '26.3',
    loader: 'fabric',
    loaderVersion: '0.19.5',
    settings: defaultSettings({ name: 'Scope', gameMode: 'survival', maxPlayers: 1 }),
    mods: [mod],
    compat: [],
    modpack: null,
    files: [],
    memoryTier: '3g',
    storageGb: 5,
    provider: 'fake',
    regionKey: 'local',
  }
  const pack = cdn.publish(
    'scope-pack',
    Buffer.from(
      zipBytes({
        'modrinth.index.json': utf8(
          JSON.stringify({
            formatVersion: 1,
            game: 'minecraft',
            versionId: '1',
            name: 'Scope',
            files: [],
            dependencies: { minecraft: base.gameVersion, 'fabric-loader': base.loaderVersion },
          }),
        ),
      }),
    ),
  )
  const plan = {
    ...base,
    compat: [companion],
    modpack: {
      catalog: 'modrinth',
      projectId: 'scope-pack',
      versionId: '1',
      name: 'Scope',
      versionLabel: '1',
      artifact: pack.artifact,
      page: null,
    },
  }
  const key = validationKey(plan),
    runtimeId = randomUUID(),
    leaseUntil = new Date(Date.now() + MINUTE_MS)
  await h.db.insert(schema.modValidations).values({ key, plan, runtimeId, leaseUntil })
  await h.db.insert(schema.modValidationRuns).values({ id: runtimeId, key, leaseUntil })
  for (const entry of [mod, companion])
    expect(await validationArtifact(h.db, runtimeId, entry.artifact.sha512)).toMatchObject({
      mod: entry,
      artifact: entry.artifact,
      refreshedAt: null,
    })
  expect(await validationArtifact(h.db, runtimeId, pack.artifact.sha512)).toMatchObject({
    mod: null,
    artifact: pack.artifact,
    pinnedAt: expect.any(Date),
    refreshedAt: null,
  })
  expect(await validationArtifact(h.db, runtimeId, '0'.repeat(128))).toBeNull()
  expect(await validationArtifact(h.db, randomUUID(), mod.artifact.sha512)).toBeUndefined()
  const bareKey = validationKey(base),
    bareRuntime = randomUUID()
  await h.db
    .insert(schema.modValidations)
    .values({ key: bareKey, plan: base, runtimeId: bareRuntime, leaseUntil })
  await h.db.insert(schema.modValidationRuns).values({ id: bareRuntime, key: bareKey, leaseUntil })
  expect(await validationArtifact(h.db, bareRuntime, '0'.repeat(128))).toBeNull()

  await h.db
    .update(schema.modValidationRuns)
    .set({ leaseUntil: new Date(Date.now() - MINUTE_MS) })
    .where(eq(schema.modValidationRuns.id, runtimeId))
  for (const entry of [mod, companion, pack])
    expect(await validationArtifact(h.db, runtimeId, entry.artifact.sha512)).toBeNull()
}
