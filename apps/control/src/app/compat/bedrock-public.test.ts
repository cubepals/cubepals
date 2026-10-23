// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a server's public page and its directory card say about Bedrock: that Bedrock players join
 * a Paper server that lets them in, and nothing for one that has them off or plays mods.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { FakeGeyserMc } from '../../infra/fake/fake-geysermc.ts'
import { VIAVERSION } from '../../minecraft/mods.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'

let h: Harness
const geyser = new FakeGeyserMc()
/** A key for tests: 16 bytes as base64, nothing a deployment uses. */
const TEST_FLOODGATE_KEY = Buffer.alloc(16, 7).toString('base64')
const cdn = new Cdn()

beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  h = await startHarness({
    capabilities: { archives: null, billing: null, bedrock: { floodgateKey: TEST_FLOODGATE_KEY, geyser } },
  })
  h.catalog.publish(
    {
      projectId: VIAVERSION,
      slug: VIAVERSION,
      name: 'ViaVersion',
      summary: '',
      iconUrl: null,
      environments: ['server_only'],
      downloads: 1,
    },
    [
      {
        versionId: `${VIAVERSION}-1`,
        projectId: VIAVERSION,
        versionLabel: '5.0',
        channel: 'release',
        state: 'listed',
        environment: 'server_only',
        loaders: ['paper', 'spigot'],
        gameVersions: offeredVersions().map((offered) => offered.id),
        publishedAt: new Date(Date.UTC(2026, 0, 1)),
        file: cdn.file(`${VIAVERSION}-1`),
        dependencies: [],
      },
    ],
  )
  geyser.floodgate = { version: '2.2.5', build: 141, ...cdn.file('floodgate-spigot') }
  expect(await h.app.setups.compat.refresh()).toBeGreaterThan(0)
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  cdn.close()
})

/** A server made public once it has booted, and what its page and its card say of Bedrock. */
const published = async (owner: UserActor, made: { id: string; slug: string }) => {
  await h.until(made.id, 'running')
  await h.settled(made.id)
  await h.app.listings.setPublic(owner, made.id, true)
  return made
}
const saidOf = async (made: { id: string; slug: string }) => ({
  page: (await h.app.sharingQueries.page(made.slug, null))?.bedrock,
  card: (await h.app.listingQueries.detail(made.id)).bedrock,
})

describe.skipIf(!hasDatabase)('Bedrock on a public page and its card', () => {
  test('a Paper server that lets Bedrock players in says so on both', async () => {
    const owner = await h.user('Fern')
    const made = await published(owner, await h.create(owner, { from: { kind: 'template', key: 'smooth' } }))
    expect(await saidOf(made)).toEqual({ page: true, card: true })
  }, 60_000)

  test('with Bedrock turned off, neither says it', async () => {
    const owner = await h.user('Gale')
    const made = await published(owner, await h.create(owner, { from: { kind: 'template', key: 'smooth' } }))
    await h.app.revisions.changeBedrock(owner, made.id, false, randomUUID())
    await h.until(made.id, 'running')
    await h.settled(made.id)
    expect(await saidOf(made)).toEqual({ page: false, card: false })
  }, 90_000)

  test('a modded server never says it', async () => {
    const owner = await h.user('Hollis', 'plus')
    const made = await published(owner, await h.create(owner, { loader: 'fabric' }))
    expect(await saidOf(made)).toEqual({ page: false, card: false })
  }, 60_000)
})
