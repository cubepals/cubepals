/**
 * The templates that are game modes: Paper and plugins from the catalog, on the newest release
 * where all of them run, offered with Plus as any plugin is, Manhunt starting out as a server for a
 * day, and Duels starting with its arena built.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { DUELS_FILES } from '../../minecraft/duels.ts'
import { VOID_LEVEL } from '../../minecraft/worlds.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'
import { listWorlds } from '../worlds/persistence.ts'

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

  /** A Paper plugin on the catalog, under its real project id, at one version for these releases. */
  const plugin = (projectId: string, name: string, gameVersions: string[]) =>
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
          versionId: `${projectId}-1`,
          projectId,
          versionLabel: '1.0',
          channel: 'release',
          state: 'listed',
          environment: 'server_only',
          loaders: ['paper', 'spigot'],
          gameVersions,
          publishedAt: new Date(Date.UTC(2026, 0, 1)),
          file: cdn.file(`${projectId}-1`),
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

  test('a game mode is Paper with a plugin, so it comes with Plus as Create does', async () => {
    const { templates } = await h.app.queries.createOptions(await h.user('Sam'))
    for (const key of ['create', 'lifesteal', 'manhunt'])
      expect(templates.find((template) => template.key === key)?.fits).toEqual({
        allowed: false,
        reason: 'Mods and plugins come with Plus.',
        plan: 'plus',
      })
  }, 30_000)

  test('Duels runs on Paper 1.21.11, and its server starts with the arena, the kit and a void world', async () => {
    // As Modrinth listed them on 2026-10-09: Duels 4.0.6 and PVPOneDotEight 2.5.1 stop at 1.21.11.
    plugin('pZyHIvCK', 'Duels', ['1.21.10', '1.21.11'])
    plugin('Tz6dxwG9', 'PVPOneDotEight', ['1.21.10', '1.21.11'])
    const owner = await h.user('Ana', 'plus')
    expect(await h.app.queries.setupPreview(owner, { kind: 'template', key: 'duels' })).toMatchObject({
      loader: 'paper',
      gameVersion: '1.21.11',
      mods: ['Duels', 'PVPOneDotEight'],
    })
    const { templates } = await h.app.queries.createOptions(await h.user('Lee'))
    expect(templates.find((template) => template.key === 'duels')?.fits).toEqual({
      allowed: false,
      reason: 'Mods and plugins come with Plus.',
      plan: 'plus',
    })

    const server = await h.create(owner, { from: { kind: 'template', key: 'duels' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    expect(revision.files).toEqual([...DUELS_FILES])
    expect(revision.settings).toMatchObject({ defaultGameMode: 'adventure', difficulty: 'easy', pvp: true })
    // The arena file names the world by its level name, so it has to be the first one Blockly makes.
    expect((await listWorlds(h.db, server.id)).map((w) => [w.levelName, w.levelType])).toEqual([
      ['world', VOID_LEVEL],
    ])
    const volume = h.runtime.machine(server.id)?.dir ?? ''
    for (const file of DUELS_FILES) expect(readFileSync(`${volume}/${file.path}`, 'utf8')).toBe(file.content)
  }, 30_000)
})
