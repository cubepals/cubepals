// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Orphan cleanup keeps unrecognized worlds and active checks, and removes expired attempts. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { Cdn } from '../../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../../testing/harness.ts'
import { validationArtifact } from '../../artifacts/validation-artifacts.ts'
import { validationKey, validationSpec } from '../../mods/validation-plan.ts'
import { runtimeKey } from '../../ports/runtime.ts'
import { loadRevision } from '../../servers/persistence.ts'

describe.skipIf(!hasDatabase)('orphan validation ownership', () => {
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
    'keeps unknown worlds and live checks, removes expired and late resources',
    () => validationOrphans(h, cdn),
    30_000,
  )
})

async function validationOrphans(h: Harness, cdn: Cdn) {
  const owner = await h.user('Check ownership', 'plus')
  const { id } = await h.create(owner, { loader: 'fabric' })
  await h.until(id, 'running')
  const legacy = runtimeKey('legacy-provider-key')
  const original = h.runtime.machine(id)
  if (original === null) throw new Error('Missing original world')
  const legacyHandle = await h.runtime.ensureProvisioned(legacy, { regionKey: 'local' }, original.spec, {
    handle: async () => {},
    step: async () => {},
  })
  await h.app.schedules.orphans()
  expect(h.runtime.machine(legacy)?.state).toBe('stopped')
  expect(h.runtime.machine(id)?.state).toBe('running')
  await h.runtime.destroy(legacyHandle)
  const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
  const mod = cdn.publish('owned-check')
  const plan = await h.app.configuration.plan({ ...revision, mods: [mod] })
  if (plan === null) throw new Error('Missing validation plan')
  const key = validationKey(plan)
  const runtimeId = randomUUID()
  const leaseUntil = new Date(Date.now() + MINUTE_MS)
  await h.db.insert(schema.modValidations).values({ key, plan, runtimeId, leaseUntil })
  await h.db.insert(schema.modValidationRuns).values({ id: runtimeId, key, leaseUntil })
  const spec = validationSpec(plan, runtimeId, 'check-password', (artifact) => {
    if (artifact.ref.kind !== 'remote') throw new Error('This fixture uses a remote jar')
    return artifact.ref.url
  })
  await h.runtime.ensureProvisioned(runtimeKey(runtimeId), { regionKey: plan.regionKey }, spec, {
    handle: async () => {},
    step: async () => {},
  })
  await h.app.schedules.orphans()
  expect(h.runtime.machine(runtimeId)?.state).toBe('running')
  expect((await validationArtifact(h.db, runtimeId, mod.artifact.sha512))?.artifact.sha512).toBe(
    mod.artifact.sha512,
  )
  await h.db
    .update(schema.modValidationRuns)
    .set({ leaseUntil: new Date(Date.now() - MINUTE_MS) })
    .where(eq(schema.modValidationRuns.id, runtimeId))
  expect(await validationArtifact(h.db, runtimeId, mod.artifact.sha512)).toBeNull()
  await h.app.schedules.orphans()
  expect(h.runtime.machine(runtimeId)).toBeNull()
  // A delivered retry cleans interrupted ownership before assigning its own fresh attempt.
  await h.app.modValidation.runImport(key)
  expect((await h.app.modValidation.status(key)).state).toBe('verified')
  const [retried] = await h.db.select().from(schema.modValidations).where(eq(schema.modValidations.key, key))
  expect(retried?.runtimeId).not.toBe(runtimeId)
  const [previous] = await h.db
    .select()
    .from(schema.modValidationRuns)
    .where(eq(schema.modValidationRuns.id, runtimeId))
  expect(previous?.finishedAt).not.toBeNull()
  // Retained attempt history recognizes a late resource even after the parent check moved on.
  await h.db
    .update(schema.modValidations)
    .set({ runtimeId: randomUUID() })
    .where(eq(schema.modValidations.key, key))
  await h.runtime.ensureProvisioned(runtimeKey(runtimeId), { regionKey: plan.regionKey }, spec, {
    handle: async () => {},
    step: async () => {},
  })
  await h.app.schedules.orphans()
  expect(h.runtime.machine(runtimeId)).toBeNull()
}
