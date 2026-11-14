// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The updates Cubepals finds for a server's mods by itself, end to end through the catalog: checked
 * to run together, newer than what is pinned, and only ever offered.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'
import type { ModChange } from './service.ts'

describe.skipIf(!hasDatabase)('mod updates', () => {
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

  interface Release {
    id: string
    channel?: CatalogVersion['channel']
    incompatible?: string[]
  }
  /** A project on the catalog, its versions listed newest first, their files on the CDN. */
  const publish = (projectId: string, releases: Release[]) =>
    h.catalog.publish(
      {
        projectId,
        slug: projectId,
        name: projectId,
        summary: `${projectId}, for tests`,
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      releases.map(
        (release, i): CatalogVersion => ({
          versionId: release.id,
          projectId,
          versionLabel: release.id,
          channel: release.channel ?? 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['fabric'],
          gameVersions: ['26.3'],
          publishedAt: new Date(Date.UTC(2026, 0, 1 + releases.length - i)),
          file: cdn.file(`${projectId}-${release.id}`),
          dependencies: (release.incompatible ?? []).map((p) => ({
            projectId: p,
            versionId: null,
            kind: 'incompatible',
          })),
        }),
      ),
    )

  /** A running Fabric server with these mods added, as its owner would add them. */
  const serverWith = async (add: NonNullable<ModChange['add']>) => {
    const owner = await h.user('Alex', 'plus')
    const created = await h.create(owner, { loader: 'fabric' })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await apply(owner, created.id, { add })
    return { owner, id: created.id }
  }
  const apply = async (owner: UserActor, id: string, change: ModChange) => {
    const plan = await h.app.mods.plan(owner, id, change)
    if (plan.kind !== 'ok') throw new Error(`Conflicts: ${JSON.stringify(plan.conflicts)}`)
    const before = await h.server(id)
    await h.app.mods.apply(
      owner,
      id,
      change,
      plan.mods.map((m) => m.artifact.sha512),
      randomUUID(),
    )
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)
  }
  const offered = async (owner: UserActor, id: string) => {
    const { versions } = await h.app.modQueries.updates(owner, id)
    const { mods } = await h.app.modQueries.list(owner, id)
    return mods.map((mod) => [mod.name, mod.versionLabel, versions[mod.id] ?? null])
  }
  const pinned = async (id: string) =>
    (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).mods.map((m) => m.versionLabel)

  test('a newer version is found and offered, and goes on only when applied', async () => {
    publish('pickaxe', [{ id: 'pickaxe-1' }])
    const { owner, id } = await serverWith([{ projectId: 'pickaxe' }])
    publish('pickaxe', [{ id: 'pickaxe-2' }, { id: 'pickaxe-1' }])

    expect(await offered(owner, id)).toEqual([['pickaxe', 'pickaxe-1', 'pickaxe-2']])
    expect(await pinned(id)).toEqual(['pickaxe-1'])

    await apply(owner, id, { upgrade: ['pickaxe'] })
    expect(await offered(owner, id)).toEqual([['pickaxe', 'pickaxe-2', null]])
  })

  test('a beta is never offered an older release as its update', async () => {
    publish('shovel', [{ id: 'shovel-2-beta', channel: 'beta' }, { id: 'shovel-1' }])
    publish('axe', [{ id: 'axe-1' }])
    const { owner, id } = await serverWith([
      { projectId: 'shovel', versionId: 'shovel-2-beta' },
      { projectId: 'axe' },
    ])
    publish('axe', [{ id: 'axe-2' }, { id: 'axe-1' }])

    // Updating everything would move the shovel back to its last release: only the axe is offered.
    expect(await offered(owner, id)).toEqual([
      ['axe', 'axe-1', 'axe-2'],
      ['shovel', 'shovel-2-beta', null],
    ])
  })

  test('updates that can’t run together: the ones that can are offered, the rest wait', async () => {
    publish('hoe', [{ id: 'hoe-1' }])
    publish('sword', [{ id: 'sword-1' }])
    const { owner, id } = await serverWith([{ projectId: 'hoe' }, { projectId: 'sword' }])
    publish('hoe', [{ id: 'hoe-2', incompatible: ['sword'] }, { id: 'hoe-1' }])
    publish('sword', [{ id: 'sword-2' }, { id: 'sword-1' }])

    expect(await offered(owner, id)).toEqual([
      ['hoe', 'hoe-1', null],
      ['sword', 'sword-1', 'sword-2'],
    ])
  })

  test('a catalog that can’t be asked shows no updates, and the list still answers', async () => {
    publish('bow', [{ id: 'bow-1' }])
    const { owner, id } = await serverWith([{ projectId: 'bow' }])
    publish('bow', [{ id: 'bow-2' }, { id: 'bow-1' }])
    h.catalog.outage(true)
    const seen = await offered(owner, id).finally(() => h.catalog.outage(false))
    expect(seen).toEqual([['bow', 'bow-1', null]])
  })
})
