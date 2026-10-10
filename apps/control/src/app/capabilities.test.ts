// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, count, eq, inArray } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../testing/harness.ts'
import { archivesMissing } from './capabilities.ts'
import type { ArchiveStore } from './ports/optional.ts'

// A deployment that lost its archive store (§11, §15.4): the boot says so when archived data is
// on record, and says nothing while the store is there.
describe.skipIf(!hasDatabase)('archives missing at boot', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('without a store, recorded archives and stored mod files are a warning; with one, nothing', async () => {
    await h.db.insert(schema.storedArtifacts).values({
      sha512: randomBytes(64).toString('hex'),
      key: 'artifacts/test.jar',
      sizeBytes: 1,
      source: 'upload',
      verifiedAt: new Date(),
    })
    const [archives] = await h.db
      .select({ n: count() })
      .from(schema.backups)
      .where(and(eq(schema.backups.tier, 'archive'), inArray(schema.backups.status, ['pending', 'ready'])))
    const [artifacts] = await h.db.select({ n: count() }).from(schema.storedArtifacts)

    const warning = await archivesMissing(h.db, { archives: null, billing: null })
    expect(warning).toContain(`${archives?.n} archive backup`)
    expect(warning).toContain(`${artifacts?.n} stored mod file`)
    expect(warning).toContain('ARCHIVE_S3_')
    expect(await archivesMissing(h.db, { archives: {} as ArchiveStore, billing: null })).toBeNull()
  })
})
