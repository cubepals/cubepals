// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Duels template: Paper 1.21.11 with Duels from Modrinth and OldCombatMechanics from Hangar,
 * the moderation tools with the chat filter and the Grim anticheat, offered with Plus, and a server
 * of it starting on a void world with the arena, the kit, the permissions, the parkour and pit and
 * the moderation files Cubepals writes, and all of it following the server onto a fresh world.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { onLevel } from '../../domain/revision/carried.ts'
import { DUELS_FILES } from '../../minecraft/duels.ts'
import { WAITING_FILES } from '../../minecraft/duels-waiting.ts'
import {
  CHATSENTINEL,
  filtersChat,
  LIBERTYBANS,
  LUCKPERMS,
  moderationFiles,
  runsModeration,
} from '../../minecraft/moderation.ts'
import { VIAVERSION } from '../../minecraft/mods.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { VOID_LEVEL } from '../../minecraft/worlds.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { CHAT_FILTER } from '../moderation/service.ts'
import { loadRevision } from '../servers/persistence.ts'
import { listWorlds } from '../worlds/persistence.ts'

let h: Harness
const cdn = new Cdn()

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

describe.skipIf(!hasDatabase)('duels', () => {
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  test('Duels runs on Paper 1.21.11, and its server starts with the arena, the kit and a void world', async () => {
    // As the catalogs listed them on 2026-10-09: Duels 4.0.6 stops at 1.21.11, and
    // OldCombatMechanics 2.7.0 (Hangar's version 31271) runs from 1.9 to 26.3.
    plugin('pZyHIvCK', 'Duels', ['1.21.10', '1.21.11'])
    plugin('hangar:2087', 'OldCombatMechanics', ['1.21.10', '1.21.11', '26.2', '26.3'], 'hangar:31271')
    // As Modrinth listed them on 2026-10-14, each a release that runs on 1.21.11 Paper.
    plugin(LIBERTYBANS, 'LibertyBans', ['1.21.10', '1.21.11', '26.2'], '7WLjonzv')
    plugin(LUCKPERMS, 'LuckPerms', ['1.21.10', '1.21.11', '26.3'], 'b0mk8uS6')
    plugin(CHATSENTINEL, 'ChatSentinel', ['1.21.10', '1.21.11', '26.2'], 'uWt04znt')
    plugin('LJNGWSvH', 'Grim Anticheat', ['1.21.10', '1.21.11'], '1FIGlM6Q')
    const owner = await h.user('Ana', 'plus')
    expect(await h.app.queries.setupPreview(owner, { kind: 'template', key: 'duels' })).toMatchObject({
      loader: 'paper',
      gameVersion: '1.21.11',
      mods: ['ChatSentinel', 'Duels', 'Grim Anticheat', 'LibertyBans', 'LuckPerms', 'OldCombatMechanics'],
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
      { catalog: 'modrinth', projectId: CHATSENTINEL, versionId: 'uWt04znt' },
      { catalog: 'modrinth', projectId: 'pZyHIvCK', versionId: 'pZyHIvCK-1' },
      { catalog: 'modrinth', projectId: 'LJNGWSvH', versionId: '1FIGlM6Q' },
      { catalog: 'modrinth', projectId: LIBERTYBANS, versionId: '7WLjonzv' },
      { catalog: 'modrinth', projectId: LUCKPERMS, versionId: 'b0mk8uS6' },
      { catalog: 'hangar', projectId: 'hangar:2087', versionId: 'hangar:31271' },
    ])
    // OldCombatMechanics and Grim play by their own defaults, so they bring no file.
    expect(revision.files).toEqual([...DUELS_FILES, ...WAITING_FILES, ...moderationFiles(CHAT_FILTER)])
    expect(revision.settings).toMatchObject({
      defaultGameMode: 'adventure',
      difficulty: 'easy',
      pvp: true,
      motd: 'Duels: one on one, with parkour and a pit while you wait',
    })
    // The moderation tools and chat filter are on, as the Players page reads them and can turn them off.
    expect([runsModeration(revision.mods), filtersChat(revision.mods)]).toEqual([true, true])
    // The arena file names the world by its level name, so it has to be the first one Blockly makes.
    expect((await listWorlds(h.db, server.id)).map((w) => [w.levelName, w.levelType])).toEqual([
      ['world', VOID_LEVEL],
    ])
    const volume = h.runtime.machine(server.id)?.dir ?? ''
    for (const file of revision.files.map((carried) => onLevel(carried, 'world')))
      expect(readFileSync(`${volume}/${file.path}`, 'utf8')).toBe(file.content)
    // The datapack is in the world the server runs.
    expect(readFileSync(`${volume}/world/datapacks/cubepals-duels/pack.mcmeta`, 'utf8')).toContain('Cubepals')
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
    // So is the parkour and the pit, whose datapack goes into the new world.
    const volume = h.runtime.machine(server.id)?.dir ?? ''
    expect(readFileSync(`${volume}/world-2/datapacks/cubepals-duels/pack.mcmeta`, 'utf8')).toContain(
      'Cubepals',
    )
  }, 30_000)

  test('on its older release, ViaVersion comes along so newer Minecraft joins too', async () => {
    // As Modrinth listed ViaVersion 5.12.1 on 2026-10-12: Paper, from 1.8.9 to 26.3.
    const releases = offeredVersions().map((offered) => offered.id)
    plugin(VIAVERSION, 'ViaVersion', releases, '5WgnasGG')
    const owner = await h.user('Noa', 'plus')
    expect(await h.app.queries.setupPreview(owner, { kind: 'template', key: 'duels' })).toMatchObject({
      gameVersion: '1.21.11',
      joinsNewer: true,
      mods: [
        'ChatSentinel',
        'Duels',
        'Grim Anticheat',
        'LibertyBans',
        'LuckPerms',
        'OldCombatMechanics',
        'ViaVersion',
      ],
    })
    const server = await h.create(owner, { from: { kind: 'template', key: 'duels' } })
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    expect(revision.mods.map((m) => m.source)).toContainEqual({
      catalog: 'modrinth',
      projectId: VIAVERSION,
      versionId: '5WgnasGG',
    })
    expect((await h.app.queries.get(owner, server.id)).joinsNewer).toBe(true)

    // Plain Paper has no plugins, and one would make it a plugin server, which plans judge apart.
    expect(await h.app.queries.setupPreview(owner, { kind: 'template', key: 'smooth' })).toMatchObject({
      mods: [],
      joinsNewer: false,
    })
  }, 30_000)
})
