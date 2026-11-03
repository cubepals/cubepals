// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Validation credentials read only their pinned mod, companion and pack bytes until the lease expires. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { validationScope } from '../../testing/validation-scope.ts'
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
  const { server, mod, companion, pack, base, runtimeId, leaseUntil } = await validationScope(h, cdn)
  expect(await validationArtifact(h.db, server.id, '0'.repeat(128))).toBeUndefined()
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
