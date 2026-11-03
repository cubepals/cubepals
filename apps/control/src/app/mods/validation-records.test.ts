// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Temporary provider ownership follows the current database lease, including abandoned attempts. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { validationScope } from '../../testing/validation-scope.ts'
import { validationActive, validationResource } from './validation-records.ts'

describe.skipIf(!hasDatabase)('validation attempt resource ownership', () => {
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
  test('only an unfinished current checking attempt has live access', async () => {
    const { key, runtimeId, leaseUntil } = await validationScope(h, cdn)
    const initial = await validationResource(h.db, runtimeId)
    expect(initial).toMatchObject({ key, leaseUntil, state: 'checking' })
    const [stored] = await h.db.select().from(schema.modValidations).where(eq(schema.modValidations.key, key))
    expect(initial?.plan).toEqual(stored?.plan)
    expect(initial?.createdAt).toEqual(stored?.createdAt)
    expect(validationActive(initial, new Date(leaseUntil.getTime() - 1))).toBe(true)
    expect(validationActive(initial, leaseUntil)).toBe(false)
    expect(validationActive(initial, new Date(leaseUntil.getTime() + MINUTE_MS))).toBe(false)
    expect(await validationResource(h.db, randomUUID())).toBeNull()
    expect(validationActive(null)).toBe(false)

    await h.db
      .update(schema.modValidations)
      .set({ state: 'verified' })
      .where(eq(schema.modValidations.key, key))
    const completed = await validationResource(h.db, runtimeId)
    expect(completed?.state).toBe('verified')
    expect(validationActive(completed)).toBe(false)
    await h.db
      .update(schema.modValidations)
      .set({ state: 'checking', runtimeId: randomUUID() })
      .where(eq(schema.modValidations.key, key))
    expect((await validationResource(h.db, runtimeId))?.state).toBe('unavailable')
    await h.db.update(schema.modValidations).set({ runtimeId }).where(eq(schema.modValidations.key, key))
    await h.db
      .update(schema.modValidationRuns)
      .set({ finishedAt: new Date() })
      .where(eq(schema.modValidationRuns.id, runtimeId))
    expect((await validationResource(h.db, runtimeId))?.state).toBe('unavailable')
  }, 30_000)
})
