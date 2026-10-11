// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The templates that are game modes: Paper and plugins from the catalog, on the newest release
 * where all of them run, offered with Plus as any plugin is, and Manhunt starting out as a server
 * for a day. Skyblock's and OneBlock's game modes and their addons go where BentoBox reads them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'

const ADDONS = 'plugins/BentoBox/addons'

/**
 * A server of an island game mode, made and started: BentoBox among the plugins, the game mode
 * (`AOneBlock`, `BSkyBlock`) with Level and Warps where BentoBox reads them, and the game mode's
 * own settings carried whole, but for an island made for each friend as they first join. Gives
 * those settings as the server has them.
 */
async function islands(
  h: Harness,
  owner: Awaited<ReturnType<Harness['user']>>,
  key: string,
  gameMode: string,
) {
  const server = await h.create(owner, { from: { kind: 'template', key } })
  await h.until(server.id, 'running')
  await h.settled(server.id)
  const revision = await loadRevision(h.db, server.desiredRevisionId)
  expect(revision.settings).toMatchObject({ defaultGameMode: 'survival', difficulty: 'normal', pvp: false })
  expect(Object.fromEntries(revision.mods.map((m) => [m.name, m.dir]))).toEqual({
    BentoBox: undefined,
    [gameMode]: ADDONS,
    Level: ADDONS,
    Warps: ADDONS,
  })
  const volume = h.runtime.machine(server.id)?.dir ?? ''
  expect(readdirSync(`${volume}/${ADDONS}`).filter((name) => name.endsWith('.jar'))).toHaveLength(3)
  expect(revision.files.map((file) => file.path)).toEqual([`${ADDONS}/${gameMode}/config.yml`])
  const config = readFileSync(`${volume}/${ADDONS}/${gameMode}/config.yml`, 'utf8')
  expect(config).toMatch(/create-island-on-first-login:\n(\s+#.*\n)+\s+enable: true\n/)
  return config
}

describe.skipIf(!hasDatabase)('game modes', () => {
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

  /**
   * A Paper plugin on the catalog, under its real project id, at one version for these releases:
   * `<projectId>-1`, or the real version id where a test needs Cubepals' own boot test to count.
   */
  const plugin = (projectId: string, name: string, gameVersions: string[], versionId = `${projectId}-1`) =>
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
          file: cdn.file(versionId),
          dependencies: [],
        },
      ],
    )

  test('a game mode brings its plugin on the newest Paper it runs on, and Manhunt lasts a day', async () => {
    // As Modrinth listed them on 2026-10-09: LifeStealZ to 26.2, Manhunt+ to 26.3.
    plugin('l8Uv7FzS', 'LifeStealZ', ['26.1.2', '26.2'])
    plugin('V67rIXws', 'Manhunt', ['26.1.2', '26.2', '26.3'])
    const owner = await h.user('Kai', 'plus')
    for (const [key, mod] of [
      ['lifesteal', 'LifeStealZ'],
      ['manhunt', 'Manhunt'],
    ] as const) {
      const preview = await h.app.queries.setupPreview(owner, { kind: 'template', key })
      // Paper's newest build is 26.2, so Manhunt+ running on 26.3 doesn't lift it there.
      expect(preview).toMatchObject({ loader: 'paper', gameVersion: '26.2', mods: [mod], modpack: null })
    }
    const { templates } = await h.app.queries.createOptions(owner)
    expect(templates.filter((template) => template.forADay).map((template) => template.key)).toEqual([
      'manhunt',
    ])
  }, 30_000)

  test('OneBlock runs on the newest Paper its addons list, with them where BentoBox reads them', async () => {
    // As Modrinth listed them on 2026-10-09: BentoBox to 26.3; AOneBlock, Level and Warps to 26.1.2.
    plugin('aBVLHiAW', 'BentoBox', ['26.1.2', '26.2', '26.3'])
    plugin('qq7CK8U4', 'AOneBlock', ['26.1', '26.1.1', '26.1.2'])
    plugin('OWzL9XSJ', 'Level', ['26.1', '26.1.1', '26.1.2'])
    plugin('P08aFayx', 'Warps', ['26.1', '26.1.1', '26.1.2'])
    const owner = await h.user('Ren', 'plus')
    const preview = await h.app.queries.setupPreview(owner, { kind: 'template', key: 'oneblock' })
    expect(preview).toMatchObject({ loader: 'paper', gameVersion: '26.1.2', modpack: null })
    expect([...preview.mods].sort()).toEqual(['AOneBlock', 'BentoBox', 'Level', 'Warps'])
    const config = await islands(h, owner, 'oneblock', 'AOneBlock')
    expect(config).toContain('  world-name: oneblock_world\n')
  }, 30_000)

  test('Skyblock runs where Cubepals booted its addons, with them where BentoBox reads them', async () => {
    // As Modrinth listed them on 2026-10-11, under their real version ids: BentoBox to 26.3;
    // BSkyBlock to 26.1.1; Level and Warps to 26.1.2. Cubepals' boot test ran all four on 26.2
    // (`curation/tested.ts`), so Skyblock gets 26.2 rather than the 26.1.1 the catalog alone allows.
    plugin('aBVLHiAW', 'BentoBox', ['26.1.2', '26.2', '26.3'], 'Wm9asg4I')
    plugin('ASGn77Qd', 'BSkyBlock', ['1.21.11', '26.1', '26.1.1'], '3kLVOQCM')
    plugin('OWzL9XSJ', 'Level', ['26.1', '26.1.1', '26.1.2'], '55hL6XOg')
    plugin('P08aFayx', 'Warps', ['26.1', '26.1.1', '26.1.2'], '4yAHWSTz')
    const owner = await h.user('Ivy', 'plus')
    const preview = await h.app.queries.setupPreview(owner, { kind: 'template', key: 'skyblock' })
    expect(preview).toMatchObject({ from: 'Skyblock', loader: 'paper', gameVersion: '26.2', modpack: null })
    expect([...preview.mods].sort()).toEqual(['BSkyBlock', 'BentoBox', 'Level', 'Warps'])
    const config = await islands(h, owner, 'skyblock', 'BSkyBlock')
    expect(config).toContain('  world-name: bskyblock_world\n')
  }, 30_000)

  test('a game mode is Paper with a plugin, so it comes with Plus as Create does', async () => {
    const { templates } = await h.app.queries.createOptions(await h.user('Sam'))
    for (const key of ['create', 'lifesteal', 'manhunt', 'skyblock', 'oneblock'])
      expect(templates.find((template) => template.key === key)?.fits).toEqual({
        allowed: false,
        reason: 'Mods and plugins come with Plus.',
        plan: 'plus',
      })
  }, 30_000)

  test('RPG survival brings AuraSkills on the newest Paper it runs on, with Plus', async () => {
    // As Modrinth listed AuraSkills 2.4.0 (`9rSJ3THD`) on 2026-10-09: 26.1 to 26.3.
    plugin('uDdZAVls', 'AuraSkills', ['26.1.2', '26.2', '26.3'])
    const owner = await h.user('Ari', 'plus')
    const preview = await h.app.queries.setupPreview(owner, { kind: 'template', key: 'rpg' })
    // The create page names it: "the newest that everything in RPG survival runs on".
    expect(preview).toMatchObject({
      from: 'RPG survival',
      loader: 'paper',
      gameVersion: '26.2',
      mods: ['AuraSkills'],
      modpack: null,
    })
    const { templates } = await h.app.queries.createOptions(await h.user('Noor'))
    expect(templates.find((template) => template.key === 'rpg')).toMatchObject({
      title: 'RPG survival',
      icon: 'rpg',
      forADay: false,
      fits: { allowed: false, reason: 'Mods and plugins come with Plus.', plan: 'plus' },
    })
  }, 30_000)
})
