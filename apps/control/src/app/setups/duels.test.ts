/**
 * The Duels template: Paper 1.21.11 with Duels from Modrinth and OldCombatMechanics from Hangar,
 * offered with Plus, and a server of it starting on a void world with the arena, the kit and the
 * permissions Cubepals writes, and the arena following it onto a fresh world.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { onLevel } from '../../domain/revision/carried.ts'
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
          file: cdn.file(versionId.replace(':', '-')),
          dependencies: [],
        },
      ],
    )

  test('Duels runs on Paper 1.21.11, and its server starts with the arena, the kit and a void world', async () => {
    // As the catalogs listed them on 2026-10-09: Duels 4.0.6 stops at 1.21.11, and
    // OldCombatMechanics 2.7.0 (Hangar's version 31271) runs from 1.9 to 26.3.
    plugin('pZyHIvCK', 'Duels', ['1.21.10', '1.21.11'])
    plugin('hangar:2087', 'OldCombatMechanics', ['1.21.10', '1.21.11', '26.2', '26.3'], 'hangar:31271')
    const owner = await h.user('Ana', 'plus')
    expect(await h.app.queries.setupPreview(owner, { kind: 'template', key: 'duels' })).toMatchObject({
      loader: 'paper',
      gameVersion: '1.21.11',
      mods: ['Duels', 'OldCombatMechanics'],
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
    expect(revision.mods.map((m) => m.source)).toEqual([
      { catalog: 'modrinth', projectId: 'pZyHIvCK', versionId: 'pZyHIvCK-1' },
      { catalog: 'hangar', projectId: 'hangar:2087', versionId: 'hangar:31271' },
    ])
    // OldCombatMechanics starts everyone on 1.8 combat by its own defaults, so it brings no file.
    expect(revision.files).toEqual([...DUELS_FILES])
    expect(revision.settings).toMatchObject({ defaultGameMode: 'adventure', difficulty: 'easy', pvp: true })
    // The arena file names the world by its level name, so it has to be the first one Blockly makes.
    expect((await listWorlds(h.db, server.id)).map((w) => [w.levelName, w.levelType])).toEqual([
      ['world', VOID_LEVEL],
    ])
    const volume = h.runtime.machine(server.id)?.dir ?? ''
    for (const file of DUELS_FILES)
      expect(readFileSync(`${volume}/${file.path}`, 'utf8')).toBe(onLevel(file, 'world').content)
  }, 30_000)

  test('after a fresh world, the arena is on the new world', async () => {
    const owner = await h.user('Kai', 'plus')
    const server = await h.create(owner, { from: { kind: 'template', key: 'duels' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.worlds.freshStart(owner, server.id, randomUUID())
    await h.until(
      server.id,
      (s) => s.lifecycle.status === 'running' && s.activeWorldId !== server.activeWorldId,
    )
    await h.settled(server.id)

    // A void world like the one it left, so the new one has the same platform.
    expect((await listWorlds(h.db, server.id)).map((w) => [w.levelName, w.levelType])).toEqual([
      ['world', VOID_LEVEL],
      ['world-2', VOID_LEVEL],
    ])
    const arena = readFileSync(`${h.runtime.machine(server.id)?.dir ?? ''}/plugins/Duels/config.yml`, 'utf8')
    const { Arenas } = Bun.YAML.parse(arena) as { Arenas: Record<string, Record<string, { World: string }>> }
    expect(Object.values(Arenas['1'] ?? {}).flatMap((place) => place.World ?? [])).toEqual([
      'world-2',
      'world-2',
      'world-2',
    ])
  }, 30_000)
})
