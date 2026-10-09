/**
 * The Duels template: Paper 1.21.11 with Duels and PVPOneDotEight, offered with Plus, and a server of
 * it starting on a void world with the arena, the kit and the permissions Cubepals writes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { DUELS_FILES } from '../../minecraft/duels.ts'
import { VOID_LEVEL } from '../../minecraft/worlds.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'
import { listWorlds } from '../worlds/persistence.ts'

describe.skipIf(!hasDatabase)('duels', () => {
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
