// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The runtime download service authorizes only the live check's exact pinned files. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { validationScope } from '../../testing/validation-scope.ts'
import { singleKey } from '../secrets.ts'
import { ArtifactLinks } from './links.ts'
import { ArtifactNotFound } from './service.ts'

describe.skipIf(!hasDatabase)('validation downloads through the runtime service', () => {
  let h: Harness
  const cdn = new Cdn()
  const ring = singleKey('scoped-service-download-test-key-0123456789')
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness({ runtimeSecrets: ring })
  }, 30_000)
  afterAll(async () => {
    await h.close()
    cdn.close()
  })
  test('only pinned bytes are located, and an expired check loses its access', async () => {
    const { mod, companion, pack, runtimeId } = await validationScope(h, cdn)
    const links = new ArtifactLinks(h.artifactsUrl, ring)
    const token = new URL(links.forServer(runtimeId)(mod.artifact)).searchParams.get('t') ?? ''
    for (const entry of [mod, companion, pack])
      expect(await h.app.artifacts.locate(runtimeId, entry.artifact.sha512, token)).toMatchObject({
        artifact: entry.artifact,
        pinned: entry === pack ? null : entry,
      })
    const unrelated = cdn.publish('other-global-compat')
    await h.db.insert(schema.compatPlugins).values({
      gameVersion: '26.3',
      projectId: 'other-global-compat',
      pinned: unrelated,
      pinnedAt: new Date(),
    })
    await expect(h.app.artifacts.locate(runtimeId, unrelated.artifact.sha512, token)).rejects.toBeInstanceOf(
      ArtifactNotFound,
    )
    await expect(h.app.artifacts.locate(runtimeId, '0'.repeat(128), token)).rejects.toBeInstanceOf(
      ArtifactNotFound,
    )
    await h.db
      .update(schema.modValidationRuns)
      .set({ leaseUntil: new Date(Date.now() - MINUTE_MS) })
      .where(eq(schema.modValidationRuns.id, runtimeId))
    await expect(h.app.artifacts.locate(runtimeId, mod.artifact.sha512, token)).rejects.toBeInstanceOf(
      ArtifactNotFound,
    )
  }, 30_000)
})
