// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a server's page says a player's game needs, end to end: each mod at the version the server
 * runs, linked to that version, and every other mod a game can carry, which a game that has one
 * must match to join.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import type { ModChange } from '../mods/service.ts'

let h: Harness
const cdn = new Cdn()

/** A Fabric mod on the catalog, its versions newest first, each with what it asks of players. */
const publish = (projectId: string, name: string, versions: Array<[string, CatalogVersion['environment']]>) =>
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
        loaders: ['fabric'],
        gameVersions: ['26.3'],
        publishedAt: new Date(Date.UTC(2026, 0, 1 + versions.length - i)),
        file: cdn.file(`${projectId}-${id}`),
        dependencies: [],
      }),
    ),
  )

/** A mod as the page names it: at that version, linked to that version's own page. */
const exactly = (name: string, projectId: string, version: string) => ({
  name,
  version,
  url: h.catalog.versionPage(projectId, version),
})

describe.skipIf(!hasDatabase)('what a server’s page says a player’s game needs', () => {
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  const server = async () => {
    const owner = await h.user('Steve', 'plus')
    const created = await h.create(owner, { loader: 'fabric' })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner, id: created.id, slug: (await h.server(created.id)).slug }
  }
  /** Applies exactly what the plan showed, and waits until the server runs it. */
  const change = async (owner: UserActor, id: string, requested: ModChange) => {
    const plan = await h.app.mods.plan(owner, id, requested)
    if (plan.kind !== 'ok') throw new Error(`Conflicts: ${JSON.stringify(plan.conflicts)}`)
    const before = await h.server(id)
    const expected = plan.mods.map((m) => m.artifact.sha512)
    await h.app.mods.apply(owner, id, requested, expected, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)
  }
  const needs = async (owner: UserActor, slug: string) =>
    (await h.app.sharingQueries.page(slug, owner))?.needs

  test('each mod at the version the server runs, the ones a game must have first', async () => {
    // Simple Voice Chat's own words: either side runs it, better on both. Create's: both must.
    publish('voice', 'Voice', [['voice-1', 'client_or_server_prefers_both']])
    publish('gears', 'Gears', [['gears-1', 'client_and_server']])
    publish('collective', 'Collective', [['collective-8.87', 'server_only']])
    const { owner, id, slug } = await server()

    // Plain Minecraft joins; a game that has either anyway is told the version the server runs.
    await change(owner, id, { add: [{ projectId: 'voice' }, { projectId: 'collective' }] })
    expect(await needs(owner, slug)).toMatchObject({
      loader: null,
      mods: [],
      ifCarried: [
        exactly('Voice', 'voice', 'voice-1'),
        exactly('Collective', 'collective', 'collective-8.87'),
      ],
    })

    await change(owner, id, { add: [{ projectId: 'gears' }] })
    expect(await needs(owner, slug)).toMatchObject({
      loader: { label: 'Fabric' },
      mods: [exactly('Gears', 'gears', 'gears-1'), exactly('Voice', 'voice', 'voice-1')],
      ifCarried: [exactly('Collective', 'collective', 'collective-8.87')],
    })
  })

  test('a mod its authors moved to the server alone is still named, at the version a game must match', async () => {
    // VeinMiner's own history: 2.13.0 was marked for both sides, 2.14.0 for the server alone.
    publish('veinminer', 'VeinMiner', [['veinminer-2.13.0', 'client_and_server']])
    const { owner, id, slug } = await server()
    await change(owner, id, { add: [{ projectId: 'veinminer' }] })
    expect(await needs(owner, slug)).toMatchObject({
      mods: [exactly('VeinMiner', 'veinminer', 'veinminer-2.13.0')],
      ifCarried: [],
    })

    publish('veinminer', 'VeinMiner', [
      ['veinminer-2.14.0', 'server_only'],
      ['veinminer-2.13.0', 'client_and_server'],
    ])
    await change(owner, id, { upgrade: 'all' })
    // Plain Minecraft joins now, and a game that kept 2.13.0 still finds the version to match.
    expect(await needs(owner, slug)).toMatchObject({
      loader: null,
      mods: [],
      ifCarried: [exactly('VeinMiner', 'veinminer', 'veinminer-2.14.0')],
    })
  })
})
