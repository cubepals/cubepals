/**
 * The templates that are game modes: Paper and plugins from the catalog, on the newest release
 * where all of them run, offered with Plus as any plugin is, and Manhunt starting out as a server
 * for a day. OneBlock's game mode and its addons go where BentoBox reads them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'

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

    const server = await h.create(owner, { from: { kind: 'template', key: 'oneblock' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    expect(revision.settings).toMatchObject({ defaultGameMode: 'survival', difficulty: 'normal', pvp: false })
    expect(revision.mods.map((m) => [m.name, m.dir])).toEqual([
      ['AOneBlock', 'plugins/BentoBox/addons'],
      ['BentoBox', undefined],
      ['Level', 'plugins/BentoBox/addons'],
      ['Warps', 'plugins/BentoBox/addons'],
    ])
    const volume = h.runtime.machine(server.id)?.dir ?? ''
    expect(
      readdirSync(`${volume}/plugins/BentoBox/addons`).filter((name) => name.endsWith('.jar')),
    ).toHaveLength(3)
  }, 30_000)

  test('a game mode is Paper with a plugin, so it comes with Plus as Create does', async () => {
    const { templates } = await h.app.queries.createOptions(await h.user('Sam'))
    for (const key of ['create', 'lifesteal', 'manhunt', 'oneblock'])
      expect(templates.find((template) => template.key === key)?.fits).toEqual({
        allowed: false,
        reason: 'Mods and plugins come with Plus.',
        plan: 'plus',
      })
  }, 30_000)
})
