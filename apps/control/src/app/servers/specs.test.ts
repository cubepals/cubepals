// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Proposed revisions and their platform companions use the same effective files as the next boot. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { VIAVERSION } from '../../minecraft/mods.ts'
import { GRIM } from '../../minecraft/stop-cheaters.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import { saveStopCheaters } from '../stop-cheaters/persistence.ts'
import { loadRevision } from './persistence.ts'

describe.skipIf(!hasDatabase)('effective runtime validation inputs', () => {
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
  test('a proposed revision includes its exact files and every next-boot companion', async () => {
    const owner = await h.user('Proposed runtime', 'plus')
    const created = await h.create(owner, { loader: 'vanilla' })
    const server = await h.server(created.id)
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    const plain = await h.app.specs.desired(h.db, server)
    expect(plain.validation.compat).toEqual([])
    const plugin = (projectId: string) => ({
      ...cdn.publish(
        projectId,
        Buffer.from(
          zipBytes({ 'plugin.yml': utf8(`name: ${projectId}\nversion: '1'\nmain: example.Main\n`) }),
        ),
      ),
      source: { catalog: 'modrinth' as const, projectId, versionId: `${projectId}-v1` },
      loaders: ['paper'],
    })
    const via = plugin(VIAVERSION),
      grim = plugin(GRIM),
      own = plugin('proposed-plugin')
    for (const mod of [via, grim])
      await h.db.insert(schema.compatPlugins).values({
        gameVersion: revision.gameVersion,
        projectId: mod.source.projectId,
        pinned: mod,
        pinnedAt: new Date(),
      })
    await saveStopCheaters(h.db, server.id, { setting: 'on' })
    const proposed = {
      ...revision,
      loader: 'paper' as const,
      loaderVersion: await h.loaderBuilds.current('paper', revision.gameVersion),
      settings: { ...revision.settings, otherVersions: 'on' as const, pvp: !revision.settings.pvp },
      mods: [own],
      files: [{ path: 'plugins/proposed/config.yml', content: 'enabled: true\n' }],
    }
    const desired = await h.app.specs.forRevision(h.db, server, proposed)
    expect(desired.revision).toMatchObject({ loader: 'paper', settings: { pvp: proposed.settings.pvp } })
    expect(desired.validation.mods).toEqual([own])
    expect(desired.validation.files).toEqual(proposed.files)
    for (const mod of [via, grim])
      expect(desired.validation.compat).toContainEqual(
        expect.objectContaining({ source: mod.source, artifact: mod.artifact }),
      )
    const plan = await h.app.configuration.plan(proposed)
    expect(plan).toMatchObject({
      loader: 'paper',
      settings: { pvp: proposed.settings.pvp },
      mods: desired.validation.mods,
      files: desired.validation.files,
      compat: desired.validation.compat,
    })
    expect((await h.server(server.id)).desiredRevisionId).toBe(revision.id)
    expect((await h.server(server.id)).activeWorldId).toBe(server.activeWorldId)
  }, 30_000)
})
