// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Production review defaults and a failed offering read use the same curation service as server creation. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { getTableName, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { NotFound } from '../errors.ts'
import { OWN_PACKS } from './own.ts'
import { CURATED_PACKS } from './packs.ts'

describe.skipIf(!hasDatabase)('curation service boundaries', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness({ productionCuration: true })
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })

  test('the admin review uses production defaults and owner accounts cannot read administrative evidence', async () => {
    const admin = { kind: 'admin' as const, userId: 'reviewer' }
    const review = await h.app.curation.review(admin)
    expect(review.map((pack) => pack.key).sort()).toEqual(
      [...CURATED_PACKS, ...OWN_PACKS].map((pack) => pack.key).sort(),
    )
    const compatibility = await h.app.curation.compatibility(admin)
    expect(compatibility).toBeDefined()
    const owner = await h.user('Review boundary')
    await expect(h.app.curation.review(owner)).rejects.toBeInstanceOf(NotFound)
    await expect(h.app.curation.compatibility(owner)).rejects.toBeInstanceOf(NotFound)
  })

  test('a real database refusal is not cached after the database recovers', async () => {
    const temporary = sql.identifier('curation_offering_unavailable')
    await h.db.execute(sql`ALTER TABLE ${schema.curatedReleases} RENAME TO ${temporary}`)
    try {
      await expect(h.app.curation.offered()).rejects.toThrow()
    } finally {
      await h.db.execute(
        sql`ALTER TABLE ${temporary} RENAME TO ${sql.identifier(getTableName(schema.curatedReleases))}`,
      )
    }
    const offered = await h.app.curation.offered()
    expect(offered).toEqual([])
    expect(await h.app.curation.offered()).toBe(offered)
  })
})
