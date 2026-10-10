// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Two catalogs in one server (docs/architecture.md §15.2): a plugin from Hangar beside one from
 * Modrinth, resolved as one set, installed, and held to each catalog's own states.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { diskName } from '../../minecraft/jars.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'

describe.skipIf(!hasDatabase)('mods from two catalogs', () => {
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

  const publish = (projectId: string, name: string, versionId: string) =>
    h.catalog.publish(
      { projectId, slug: projectId, name, summary: name, iconUrl: null, environments: [], downloads: 1 },
      [
        {
          versionId,
          projectId,
          versionLabel: versionId,
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['fabric'],
          gameVersions: ['26.3'],
          publishedAt: new Date('2026-10-01'),
          file: cdn.file(versionId.replace(':', '-')),
          dependencies: [],
        },
      ],
    )

  test('a plugin from Hangar sits beside one from Modrinth: pinned to its catalog, installed, refreshed', async () => {
    publish('hangar:2087', 'OldCombatMechanics', 'hangar:31271')
    publish('chunky', 'Chunky', 'chunky-1')
    const owner = await h.user('Steve', 'plus')
    const { id } = await h.create(owner, { loader: 'fabric' })
    await h.until(id, 'running')
    await h.settled(id)

    const change = { add: [{ projectId: 'hangar:2087' }, { projectId: 'chunky' }] }
    const plan = await h.app.mods.plan(owner, id, change)
    if (plan.kind !== 'ok') throw new Error(`Conflicts: ${JSON.stringify(plan.conflicts)}`)
    const before = await h.server(id)
    const jars = plan.mods.map((m) => m.artifact.sha512)
    await h.app.mods.apply(owner, id, change, jars, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)

    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(revision.mods.map((m) => m.source)).toEqual([
      { catalog: 'modrinth', projectId: 'chunky', versionId: 'chunky-1' },
      { catalog: 'hangar', projectId: 'hangar:2087', versionId: 'hangar:31271' },
    ])
    // The start step installed both, and found each jar's bytes as pinned.
    expect(await h.minecraft.jars(id)).toEqual(revision.mods.map((m) => diskName(m.artifact)).sort())
    const cached = await h.db
      .select({ catalog: schema.catalogProjects.catalog, state: schema.catalogProjects.state })
      .from(schema.catalogProjects)
      .where(eq(schema.catalogProjects.projectId, 'hangar:2087'))
    expect(cached).toEqual([{ catalog: 'hangar', state: 'approved' }])

    // Hangar's states are refreshed under its own name, and a takedown there is followed.
    h.catalog.setProjectState('hangar:2087', 'withheld')
    const moved = await h.app.catalog.refresh()
    expect(moved.filter((t) => t.id === 'hangar:2087')).toEqual([
      { catalog: 'hangar', kind: 'project', id: 'hangar:2087', from: 'approved', to: 'withheld' },
    ])
    const list = await h.app.modQueries.list(owner, id)
    expect(list.mods.filter((m) => m.revoked).map((m) => m.name)).toEqual(['OldCombatMechanics'])
  }, 40_000)
})
