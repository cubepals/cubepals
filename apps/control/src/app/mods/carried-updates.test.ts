// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The updates a mod change's plan marks as carried: those a player's game can have, whatever their
 * authors say they ask of players, which a game that has one must match to join once it applies.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

let h: Harness
const cdn = new Cdn()

/** A project on the catalog, its versions newest first, each with what it asks of players. */
const publish = (
  projectId: string,
  name: string,
  versions: Array<[string, CatalogVersion['environment']]>,
  loaders = ['fabric'],
) =>
  h.catalog.publish(
    {
      projectId,
      slug: projectId,
      name,
      summary: `${name}, for tests`,
      iconUrl: null,
      environments: [...new Set(versions.map(([, environment]) => environment))],
      downloads: 1,
    },
    versions.map(
      ([id, environment], i): CatalogVersion => ({
        versionId: id,
        projectId,
        versionLabel: id,
        channel: 'release',
        state: 'listed',
        environment,
        loaders,
        gameVersions: ['26.3'],
        publishedAt: new Date(Date.UTC(2026, 0, 1 + versions.length - i)),
        file: cdn.file(`${projectId}-${id}`),
        dependencies: [],
      }),
    ),
  )

describe.skipIf(!hasDatabase)('updates a player’s game carries', () => {
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  test('an update is carried whatever its new version asks of players, and a datapack never', async () => {
    // VeinMiner's own history: 2.13.0 was marked for both sides, 2.14.0 for the server alone.
    publish('veinminer', 'VeinMiner', [['veinminer-2.13.0', 'client_and_server']])
    publish('collective', 'Collective', [['collective-8.86', 'server_only']])
    publish('terralith', 'Terralith', [['terralith-2.5.7', 'server_only']], ['datapack'])
    const owner = await h.user('Steve', 'plus')
    const { id } = await h.create(owner, { loader: 'fabric' })
    await h.until(id, 'running')
    await h.settled(id)
    const added = {
      add: [{ projectId: 'veinminer' }, { projectId: 'collective' }, { projectId: 'terralith' }],
    }
    const first = await h.app.mods.plan(owner, id, added)
    const expected = first.kind === 'ok' ? first.mods.map((m) => m.artifact.sha512) : []
    await h.app.mods.apply(owner, id, added, expected, randomUUID())
    await h.settled(id, 20_000)

    publish('veinminer', 'VeinMiner', [
      ['veinminer-2.14.0', 'server_only'],
      ['veinminer-2.13.0', 'client_and_server'],
    ])
    publish('collective', 'Collective', [
      ['collective-8.87', 'server_only'],
      ['collective-8.86', 'server_only'],
    ])
    publish(
      'terralith',
      'Terralith',
      [
        ['terralith-2.5.8', 'server_only'],
        ['terralith-2.5.7', 'server_only'],
      ],
      ['datapack'],
    )
    const plan = h.app.modQueries.planView(await h.app.mods.plan(owner, id, { upgrade: 'all' }))
    expect(
      plan.kind === 'ok' && plan.updated.map(({ to, carried }) => [to.name, to.versionLabel, carried]),
    ).toEqual([
      ['Collective', 'collective-8.87', true],
      ['Terralith', 'terralith-2.5.8', false],
      ['VeinMiner', 'veinminer-2.14.0', true],
    ])
  })
})
