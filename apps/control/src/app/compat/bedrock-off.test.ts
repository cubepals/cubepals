// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A deployment without the Bedrock key (FLOODGATE_KEY unset, as production is until the edge takes
 * Bedrock players): no server is given Floodgate, the key or unsigned chat, and a server's view
 * says nothing of Bedrock, so no page tells anyone phones can join.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { FLOODGATE, FLOODGATE_KEY_ENV } from '../../minecraft/bedrock.ts'
import { VIAVERSION } from '../../minecraft/mods.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

let h: Harness
const cdn = new Cdn()

beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  h = await startHarness()
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
  expect(await h.app.setups.compat.refresh()).toBeGreaterThan(0)
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  cdn.close()
})

describe.skipIf(!hasDatabase)('a deployment with no Bedrock key', () => {
  test('gives no server Floodgate, the key or unsigned chat, and its view says nothing of Bedrock', async () => {
    const owner = await h.user('Wren')
    const server = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const { spec } = await h.app.specs.desired(h.db, await h.server(server.id))
    const jars = (spec.env.BLOCKLY_JARS ?? '').split('\n')
    // The Via plugins every Paper server has are still placed; Floodgate is not.
    expect(jars.some((line) => line.includes(VIAVERSION))).toBe(true)
    expect(jars.some((line) => line.includes(FLOODGATE))).toBe(false)
    expect(spec.secrets[FLOODGATE_KEY_ENV]).toBeUndefined()
    expect(spec.env.ENFORCE_SECURE_PROFILE).toBe('TRUE')
    expect(existsSync(`${h.runtime.machine(server.id)?.dir ?? ''}/plugins/floodgate/key.pem`)).toBe(false)
    // The settings page and the invite box read these two: nothing to say.
    const view = await h.app.queries.get(owner, server.id)
    expect(view.bedrock).toBe(false)
    // Nor do its public page and its directory card.
    await h.app.listings.setPublic(owner, server.id, true)
    expect((await h.app.sharingQueries.page(server.slug, null))?.bedrock).toBe(false)
    expect((await h.app.listingQueries.detail(server.id)).bedrock).toBe(false)
  }, 60_000)
})
