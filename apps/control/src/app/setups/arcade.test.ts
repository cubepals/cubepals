// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade template: Paper on the newest release the moderation tools run on, with them, the
 * chat filter and the Grim anticheat, and ViaVersion when that release isn't the newest; offered
 * with Plus; and a server of it starting on the Arcade's world, fetched through its own link,
 * with the games' datapack and the moderation files, the datapack following the server onto a fresh world.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { TEMPLATE_CARDS } from '@blockly/contracts'
import { DAY_MS } from '@blockly/contracts/durations'
import { onLevel } from '../../domain/revision/carried.ts'
import { ARCADE_WORLD } from '../../minecraft/arcade/maps.ts'
import { ARCADE_FILES } from '../../minecraft/arcade.ts'
import {
  CHATSENTINEL,
  filtersChat,
  LIBERTYBANS,
  LUCKPERMS,
  moderationFiles,
  runsModeration,
} from '../../minecraft/moderation.ts'
import { VIABACKWARDS, VIAVERSION } from '../../minecraft/mods.ts'
import { ARCADE_LEVEL, STARTER_STEP } from '../../minecraft/starter.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { recordStored } from '../artifacts/persistence.ts'
import { CHAT_FILTER } from '../moderation/service.ts'
import { loadRevision } from '../servers/persistence.ts'
import { listWorlds } from '../worlds/persistence.ts'

let h: Harness
const cdn = new Cdn()
const store = new MemoryStore()

/** A Paper plugin on the catalog, under its real project id, at one version for these releases. */
const plugin = (projectId: string, name: string, gameVersions: string[], versionId: string) =>
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

describe.skipIf(!hasDatabase)('arcade', () => {
  beforeAll(async () => {
    await cdn.start()
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
    // As Modrinth listed them on 2026-10-14: ChatSentinel 2.0.3 and Grim 2.3.74 stop at 26.2,
    // LibertyBans and LuckPerms run on 26.3 too, and ViaVersion on every release offered.
    plugin(LIBERTYBANS, 'LibertyBans', ['1.21.11', '26.2', '26.3'], 'libertybans-1')
    plugin(LUCKPERMS, 'LuckPerms', ['1.21.11', '26.2', '26.3'], 'luckperms-1')
    plugin(CHATSENTINEL, 'ChatSentinel', ['1.21.11', '26.2'], 'chatsentinel-1')
    plugin('LJNGWSvH', 'Grim Anticheat', ['1.21.11', '26.2'], 'grim-1')
    const offered = offeredVersions().map((version) => version.id)
    plugin(VIAVERSION, 'ViaVersion', offered, 'viaversion-1')
    plugin(VIABACKWARDS, 'ViaBackwards', offered, 'viabackwards-1')
  }, 30_000)

  afterAll(async () => {
    await h.close()
    store.close()
    cdn.close()
  })

  test("it isn't offered until its world's archive is in the store, and the store keeps it", async () => {
    const owner = await h.user('Mo', 'plus')
    const offered = async () =>
      (await h.app.queries.createOptions(owner)).templates.some((template) => template.key === 'arcade')
    expect(await offered()).toBe(false)
    await expect(h.app.queries.setupPreview(owner, { kind: 'template', key: 'arcade' })).rejects.toThrow()
    if (ARCADE_WORLD.ref.kind !== 'stored') throw new Error('The Arcade world is kept in the store')
    // As `scripts/arcade-upload.ts` puts it there, and the control plane finds it on its own.
    store.objects.set(ARCADE_WORLD.ref.key, Buffer.from('the arcade world'))
    expect(await offered()).toBe(true)
    // Nothing pins the archive, yet the sweep for unused blobs never takes it.
    await recordStored(h.db, {
      sha512: ARCADE_WORLD.sha512,
      key: ARCADE_WORLD.ref.key,
      sizeBytes: 16,
      source: 'built',
    })
    await h.app.artifacts.collectGarbage(new Date(Date.now() + 30 * DAY_MS))
    expect(await store.head(ARCADE_WORLD.ref.key)).not.toBeNull()
  }, 30_000)

  test('it runs on the newest Paper the moderation tools do, with the Via plugins so other Minecraft joins', async () => {
    const owner = await h.user('Ana', 'plus')
    expect(await h.app.queries.setupPreview(owner, { kind: 'template', key: 'arcade' })).toMatchObject({
      from: 'Arcade',
      loader: 'paper',
      gameVersion: '26.2',
      joinsNewer: true,
      mods: ['ChatSentinel', 'Grim Anticheat', 'LibertyBans', 'LuckPerms', 'ViaBackwards', 'ViaVersion'],
    })
    const { templates } = await h.app.queries.createOptions(await h.user('Lee'))
    expect(templates.find((template) => template.key === 'arcade')?.fits).toEqual({
      allowed: false,
      reason: 'Mods and plugins come with Plus.',
      plan: 'plus',
    })
  }, 30_000)

  test("its server starts on the Arcade's world with the games, the boards and the moderation tools", async () => {
    const owner = await h.user('Kai', 'plus')
    const server = await h.create(owner, { from: { kind: 'template', key: 'arcade' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    // Every game is the datapack, so the only plugins are the ones for strangers, and the Via ones.
    expect(revision.mods.map((m) => ('projectId' in m.source ? m.source.projectId : '')).sort()).toEqual(
      [CHATSENTINEL, 'LJNGWSvH', LIBERTYBANS, LUCKPERMS, VIABACKWARDS, VIAVERSION].sort(),
    )
    expect(revision.files).toEqual([...ARCADE_FILES, ...moderationFiles(CHAT_FILTER)])
    expect(revision.settings).toMatchObject({
      defaultGameMode: 'adventure',
      difficulty: 'easy',
      pvp: true,
      motd: 'Arcade: parkour, falling floor and a pit, with high scores',
    })
    expect([runsModeration(revision.mods), filtersChat(revision.mods)]).toEqual([true, true])
    expect((await listWorlds(h.db, server.id)).map((w) => [w.levelName, w.levelType])).toEqual([
      ['world', ARCADE_LEVEL],
    ])
    // Its page credits the maps its world is built on, from the template's own card.
    const { slug } = await h.server(server.id)
    const page = await h.app.sharingQueries.page(slug, owner)
    expect(page?.credits).toEqual(TEMPLATE_CARDS.find((card) => card.key === 'arcade')?.credits ?? null)
    expect(page?.credits?.makers.map((maker) => maker.name)).toEqual(['NetherGames', 'Overcast Community'])
    const plain = await h.create(owner, { loader: 'vanilla' })
    expect((await h.app.sharingQueries.page((await h.server(plain.id)).slug, owner))?.credits).toBeNull()
    // The world's archive comes through the server's own link, as its jars do, checked by its hash.
    const { spec } = await h.app.specs.desired(h.db, await h.server(server.id))
    const [sha512, link = ''] = (spec.env.BLOCKLY_STARTER ?? '').split(' ')
    expect(sha512).toBe(ARCADE_WORLD.sha512)
    expect(spec.entrypoint?.[2]).toContain(STARTER_STEP)
    const head = await fetch(link, { method: 'HEAD' })
    expect([head.status, head.headers.get('content-length')]).toEqual([200, String(ARCADE_WORLD.sizeBytes)])
    // Only the archive its worlds start on.
    expect((await fetch(link.replace(ARCADE_WORLD.sha512, 'a'.repeat(128)), { method: 'HEAD' })).status).toBe(
      404,
    )
    const volume = h.runtime.machine(server.id)?.dir ?? ''
    for (const file of revision.files.map((carried) => onLevel(carried, 'world')))
      expect(readFileSync(`${volume}/${file.path}`, 'utf8')).toBe(file.content)

    // A fresh world starts on the Arcade's world again, and the games go into it.
    await h.app.worlds.freshStart(owner, server.id, randomUUID())
    await h.until(
      server.id,
      (s) => s.lifecycle.status === 'running' && s.activeWorldId !== server.activeWorldId,
    )
    await h.settled(server.id)
    expect((await listWorlds(h.db, server.id)).map((w) => [w.levelName, w.levelType])).toEqual([
      ['world', ARCADE_LEVEL],
      ['world-2', ARCADE_LEVEL],
    ])
    expect(readFileSync(`${volume}/world-2/datapacks/cubepals-arcade/pack.mcmeta`, 'utf8')).toContain(
      'Arcade',
    )
  }, 30_000)
})
