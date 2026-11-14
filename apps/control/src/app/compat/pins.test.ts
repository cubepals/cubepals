// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plugins Cubepals places on Paper are the releases its pins name and no other: not a newer
 * one the catalog publishes, not one whose file hashes to something else, and Floodgate the pinned
 * build whatever GeyserMC lists as newest. Also the real pins file's shape.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { FakeGeyserMc } from '../../infra/fake/fake-geysermc.ts'
import { COMPAT_PINS, type CompatPins } from '../../minecraft/compat-pins.ts'
import { COMPAT, VIABACKWARDS, VIAREWIND, VIAVERSION } from '../../minecraft/mods.ts'
import { GRIM } from '../../minecraft/stop-cheaters.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

let h: Harness
const cdn = new Cdn()
const geyser = new FakeGeyserMc()

/** One release of a plugin on the catalog, for every release Cubepals offers, published on `day`. */
const release = (projectId: string, versionId: string, label: string, day: number) => ({
  versionId,
  projectId,
  versionLabel: label,
  channel: 'release' as const,
  state: 'listed' as const,
  environment: 'server_only' as const,
  loaders: ['paper'],
  gameVersions: offeredVersions().map((offered) => offered.id),
  publishedAt: new Date(Date.UTC(2026, 0, day)),
  file: cdn.file(versionId),
  dependencies: [],
})

const project = (projectId: string, name: string) => ({
  projectId,
  slug: projectId,
  name,
  summary: '',
  iconUrl: null,
  environments: ['server_only' as const],
  downloads: 1,
})

/** What the compat job pinned, as `project version` for each release it pinned for. */
const pinned = async () =>
  (await h.db.select().from(schema.compatPlugins)).map((row) => {
    const source = (row.pinned as { source: { versionId: string } }).source
    return `${row.projectId} ${source.versionId}`
  })

beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  h = await startHarness({
    capabilities: {
      archives: null,
      billing: null,
      bedrock: { floodgateKey: Buffer.alloc(16, 7).toString('base64'), geyser },
    },
  })
  h.catalog.publish(project(VIAVERSION, 'ViaVersion'), [
    release(VIAVERSION, 'vv-old', '5.0', 1),
    release(VIAVERSION, 'vv-new', '5.1', 2),
  ])
  h.catalog.publish(project(VIABACKWARDS, 'ViaBackwards'), [release(VIABACKWARDS, 'vb-old', '5.0', 1)])
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  cdn.close()
})

/** Pins naming the older ViaVersion and its ViaBackwards, with these files' hashes. */
const olderPins = (sha: (versionId: string) => string): CompatPins => ({
  plugins: [
    { name: 'ViaVersion', projectId: VIAVERSION, versionId: 'vv-old', label: '5.0', sha512: sha('vv-old') },
    {
      name: 'ViaBackwards',
      projectId: VIABACKWARDS,
      versionId: 'vb-old',
      label: '5.0',
      sha512: sha('vb-old'),
    },
  ],
  floodgate: null,
})

describe.skipIf(!hasDatabase)('the compat job', () => {
  test('pins the release the pins name, though the catalog publishes a newer one', async () => {
    await h.db.delete(schema.compatPlugins)
    await h.app.setups.compat.refresh(olderPins((id) => cdn.file(id).sha512))
    const rows = await pinned()
    expect(rows).toContain(`${VIAVERSION} vv-old`)
    expect(rows).not.toContain(`${VIAVERSION} vv-new`)
  })

  test("pins nothing for a plugin whose file doesn't hash to its pin, and keeps what it had", async () => {
    await h.db.delete(schema.compatPlugins)
    await h.app.setups.compat.refresh(olderPins((id) => cdn.file(id).sha512))
    const before = await pinned()
    await h.db.delete(schema.compatPlugins)
    await h.app.setups.compat.refresh(olderPins(() => 'f'.repeat(128)))
    expect(await pinned()).toEqual([])
    await h.app.setups.compat.refresh(olderPins((id) => cdn.file(id).sha512))
    expect((await pinned()).sort()).toEqual(before.sort())
  })

  test('places the pinned Floodgate build, not the newest GeyserMC lists', async () => {
    await h.db.delete(schema.compatPlugins)
    geyser.floodgate = { version: '2.2.6', build: 150, ...cdn.file('floodgate-150') }
    const floodgate = { version: '2.2.5', build: 141, ...cdn.file('floodgate-141') }
    await h.app.setups.compat.refresh({ ...olderPins((id) => cdn.file(id).sha512), floodgate })
    const rows = await pinned()
    expect(rows).toContain('floodgate 2.2.5-141')
    expect(rows).not.toContain('floodgate 2.2.6-150')
  })
})

describe('the pins file', () => {
  test('names each plugin Cubepals places on Paper once, by version and a SHA-512', () => {
    const projects = COMPAT_PINS.plugins.map((pin) => pin.projectId)
    expect(projects.sort()).toEqual([...new Set([...Object.values(COMPAT).flat(), VIAREWIND, GRIM])].sort())
    for (const pin of COMPAT_PINS.plugins) {
      expect(pin.versionId).toMatch(/^\w+$/)
      expect(pin.sha512).toMatch(/^[0-9a-f]{128}$/)
    }
    expect(COMPAT_PINS.floodgate?.sha512).toMatch(/^[0-9a-f]{128}$/)
    expect(COMPAT_PINS.floodgate?.url).toStartWith('https://download.geysermc.org/')
  })
})
