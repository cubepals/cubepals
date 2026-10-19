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
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
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
import { VIABACKWARDS, VIAREWIND, VIAVERSION } from '../../minecraft/mods.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { VOID_LEVEL } from '../../minecraft/worlds.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { CHAT_FILTER } from '../moderation/chat-filter.ts'
import { loadRevision } from '../servers/persistence.ts'
import { listWorlds } from '../worlds/persistence.ts'
import { DUELS_STRUCTURES } from './duels-structures.ts'

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
    expect(revision.files).toEqual([
      ...DUELS_FILES,
      ...WAITING_FILES,
      ...DUELS_STRUCTURES,
      ...moderationFiles(CHAT_FILTER),
    ])
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
      expect(readFileSync(`${volume}/${file.path}`, file.encoding ?? 'utf8')).toBe(file.content)
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

  test('its server starts with the Via plugins, ViaRewind too, none of them among its plugins', async () => {
    // As Modrinth listed them on 2026-10-12: Paper, from 1.8.9 to 26.3.
    const releases = offeredVersions().map((offered) => offered.id)
    plugin(VIAVERSION, 'ViaVersion', releases, '5WgnasGG')
    plugin(VIABACKWARDS, 'ViaBackwards', releases)
    plugin(VIAREWIND, 'ViaRewind', releases)
    await h.app.setups.compat.refresh()
    const owner = await h.user('Noa', 'plus')
    expect(await h.app.queries.setupPreview(owner, { kind: 'template', key: 'duels' })).toMatchObject({
      gameVersion: '1.21.11',
      joins: { oldest: '1.7.2', newer: true },
      mods: ['ChatSentinel', 'Duels', 'Grim Anticheat', 'LibertyBans', 'LuckPerms', 'OldCombatMechanics'],
    })
    const server = await h.create(owner, { from: { kind: 'template', key: 'duels' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const { spec } = await h.app.specs.desired(h.db, await h.server(server.id))
    // ViaVersion, ViaBackwards and ViaRewind, placed by Cubepals' own step.
    expect(spec.env.BLOCKLY_JARS?.split('\n').filter((line) => line.startsWith('plugins/'))).toHaveLength(3)
    // 1.8 PvP players get in: down to 1.7.
    expect((await h.app.queries.get(owner, server.id)).joins).toEqual({
      oldest: '1.7.2',
      newer: true,
      otherVersions: 'oldest',
    })
  }, 30_000)
})

describe.skipIf(!hasDatabase)('a Duels server asleep', () => {
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
    h.runtime.sleeps.on = true
    plugin('pZyHIvCK', 'Duels', ['1.21.11'])
    plugin('hangar:2087', 'OldCombatMechanics', ['1.21.11'], 'hangar:31271')
    plugin(LIBERTYBANS, 'LibertyBans', ['1.21.11'], '7WLjonzv')
    plugin(LUCKPERMS, 'LuckPerms', ['1.21.11'], 'b0mk8uS6')
    plugin(CHATSENTINEL, 'ChatSentinel', ['1.21.11'], 'uWt04znt')
    plugin('LJNGWSvH', 'Grim Anticheat', ['1.21.11'], '1FIGlM6Q')
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  // Production, 2026-10-14: Duels, put to sleep, was booted again at its wake rather than resumed.
  test('asleep with nothing changed, it wakes as it slept, and a new message waits for its next boot', async () => {
    const owner = await h.user('Ola', 'plus')
    const server = await h.create(owner, { from: { kind: 'template', key: 'duels' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const sleepAndWake = async (between = async () => {}) => {
      await h.app.servers.stop(owner, server.id, randomUUID(), 'idle')
      await h.until(server.id, 'stopped')
      await h.settled(server.id)
      expect(h.runtime.machine(server.id)?.state).toBe('suspended')
      await between()
      await h.app.servers.start(owner, server.id, randomUUID())
      await h.until(server.id, 'running')
      await h.settled(server.id)
      const [start] = await h.db
        .select({ steps: schema.serverOperations.steps })
        .from(schema.serverOperations)
        .where(
          and(eq(schema.serverOperations.serverId, server.id), eq(schema.serverOperations.kind, 'start')),
        )
        .orderBy(desc(schema.serverOperations.createdAt))
        .limit(1)
      return (start?.steps ?? []).map((entry) => entry.step)
    }
    const booted = h.runtime.machine(server.id)?.spec.env.MOTD
    expect(await sleepAndWake()).toContain('resuming')
    expect(await sleepAndWake()).not.toContain('booting')

    // Its message, changed while it slept: the server list shows it from the next boot, and the
    // wake doesn't wait for one.
    const steps = await sleepAndWake(async () => {
      const settings = (await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)).settings
      await h.app.revisions.changeSettings(owner, server.id, { ...settings, motd: 'Back soon' }, randomUUID())
      await h.settled(server.id)
    })
    expect(steps).toContain('resuming')
    expect(steps).not.toContain('booting')
    expect(h.runtime.machine(server.id)?.spec.env.MOTD).toBe(booted)
    await h.app.servers.restart(owner, server.id, randomUUID())
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect(h.runtime.machine(server.id)?.spec.env.MOTD).toBe('Back soon')
  }, 60_000)
})
