// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The releases a template runs on, as one answer: what the catalog lists, what Cubepals tested,
 * and what each jar asks of the Java the release runs. Creating, the create page's version picker
 * and adding a plugin to a server later all ask it, and all get the same answer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { pluginJar } from '../../testing/uploads.ts'

describe.skipIf(!hasDatabase)('the releases a template runs on', () => {
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

  /** A Paper plugin on the catalog, under its real project id, at one version, its jar served. */
  const plugin = (
    projectId: string,
    name: string,
    gameVersions: string[],
    versionId: string,
    jar?: Uint8Array,
  ) =>
    h.catalog.publish(
      {
        projectId,
        slug: projectId,
        name,
        summary: '',
        iconUrl: null,
        environments: ['server_only'],
        downloads: 1,
      },
      [
        {
          versionId,
          projectId,
          versionLabel: '1.0',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['paper', 'spigot'],
          gameVersions,
          publishedAt: new Date(Date.UTC(2026, 0, 1)),
          file: cdn.file(versionId, jar),
          dependencies: [],
        },
      ],
    )

  test('Skyblock is never put on a release whose Java its BentoBox doesn’t run on', async () => {
    // As production found it on 2026-10-11: Modrinth lists BentoBox 3.23.3 for 1.21.5 to 26.3, and
    // BSkyBlock for 1.21.11, yet BentoBox's classes are Java 25's and Paper 1.21.11 runs on Java 21.
    plugin(
      'aBVLHiAW',
      'BentoBox',
      ['1.21.11', '26.1.2', '26.2', '26.3'],
      'Wm9asg4I',
      pluginJar('BentoBox', 25),
    )
    plugin('ASGn77Qd', 'BSkyBlock', ['1.21.11', '26.1', '26.1.1'], '3kLVOQCM', pluginJar('BSkyBlock', 21))
    plugin('OWzL9XSJ', 'Level', ['1.21.11', '26.1', '26.1.1', '26.1.2'], '55hL6XOg')
    plugin('P08aFayx', 'Warps', ['1.21.11', '26.1', '26.1.1', '26.1.2'], '4yAHWSTz')
    const owner = await h.user('Lea', 'plus')
    const on1_21_11 = h.app.queries.setupPreview(owner, {
      kind: 'template',
      key: 'skyblock',
      gameVersion: '1.21.11',
    })
    await expect(on1_21_11).rejects.toThrow(
      "Cubepals can't run BentoBox on Minecraft 1.21.11: its builds for it need Minecraft 26.1.2 or newer. Skyblock runs on Minecraft 26.2.",
    )
    // The create page's version picker asks the same of every release before anyone picks one.
    const releases = new Map(
      (await h.app.queries.setupReleases('skyblock')).map((one) => [one.gameVersion, one]),
    )
    expect(releases.get('26.2')).toEqual({ gameVersion: '26.2', runs: true })
    expect(releases.get('1.21.11')).toEqual({
      gameVersion: '1.21.11',
      runs: false,
      reason:
        "Cubepals can't run BentoBox on Minecraft 1.21.11: its builds for it need Minecraft 26.1.2 or newer.",
    })
    // Paper is offered on 26.3, but these three list no build for it.
    expect(releases.get('26.3')).toMatchObject({
      runs: false,
      reason: "Cubepals can't run BSkyBlock, Level, Warps on Minecraft 26.3.",
    })
    // Adding it to a Paper server on that release later is held to the same answer.
    const paper = await h.create(owner, { from: { kind: 'template', key: 'smooth', gameVersion: '1.21.11' } })
    const plan = await h.app.mods.plan(owner, paper.id, { add: [{ projectId: 'aBVLHiAW' }] })
    expect(plan).toMatchObject({
      kind: 'conflicts',
      conflicts: [{ kind: 'needs_newer_java', mod: 'BentoBox', java: 25 }],
      movesTo: { gameVersion: '26.1.2' },
    })
  }, 30_000)
})
