/**
 * The templates that are game modes: Paper and one plugin from the catalog, on the newest release
 * where both run, offered with Plus as any plugin is, and Manhunt starting out as a server for a
 * day.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

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
