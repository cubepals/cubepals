// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade template: Paper on the newest release the moderation tools run on, with them, the
 * chat filter and the Grim anticheat, and Cubepals' Via plugins beside them, never among them; offered
 * with Plus; and a server of it starting on the Arcade's world, fetched through its own link,
 * with the games' datapack and the moderation files, the datapack following the server onto a fresh world,
 * and Cubepals' resource pack offered only where Cubepals runs it itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { TEMPLATE_CARDS } from '@blockly/contracts'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
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
import { ARCADE_LEVEL, STARTER_STEP } from '../../minecraft/starter.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import type { Actor } from '../actor.ts'
import { recordStored } from '../artifacts/persistence.ts'
import { CHAT_FILTER } from '../moderation/service.ts'
import { loadRevision } from '../servers/persistence.ts'
import { listWorlds } from '../worlds/persistence.ts'

let h: Harness
let cdn: Cdn
let store: MemoryStore

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

/** A deployment with an archive store, and the plugins the Arcade brings on its catalog. */
async function begin(): Promise<void> {
  cdn = new Cdn()
  store = new MemoryStore()
  await cdn.start()
  await store.start()
  h = await startHarness({ capabilities: { archives: store, billing: null } })
  // As Modrinth listed them on 2026-10-14: ChatSentinel 2.0.3 and Grim 2.3.74 stop at 26.2,
  // LibertyBans and LuckPerms run on 26.3 too.
  plugin(LIBERTYBANS, 'LibertyBans', ['1.21.11', '26.2', '26.3'], 'libertybans-1')
  plugin(LUCKPERMS, 'LuckPerms', ['1.21.11', '26.2', '26.3'], 'luckperms-1')
  plugin(CHATSENTINEL, 'ChatSentinel', ['1.21.11', '26.2'], 'chatsentinel-1')
  plugin('LJNGWSvH', 'Grim Anticheat', ['1.21.11', '26.2'], 'grim-1')
}

async function end(): Promise<void> {
  await h.close()
  store.close()
  cdn.close()
}

describe.skipIf(!hasDatabase)('arcade', () => {
  beforeAll(begin, 30_000)
  afterAll(end)

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
      mods: ['ChatSentinel', 'Grim Anticheat', 'LibertyBans', 'LuckPerms'],
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
    // Every game is the datapack, so the only plugins are the ones for strangers.
    expect(revision.mods.map((m) => ('projectId' in m.source ? m.source.projectId : '')).sort()).toEqual(
      [CHATSENTINEL, 'LJNGWSvH', LIBERTYBANS, LUCKPERMS].sort(),
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

describe.skipIf(!hasDatabase)("Cubepals' resource pack on an Arcade", () => {
  beforeAll(begin, 30_000)
  afterAll(end)

  test("only a server Cubepals runs itself offers Cubepals' resource pack; a player's Arcade never does", async () => {
    const admin: Actor = { kind: 'admin', userId: (await h.user('Admin')).userId }
    await h.db.insert(schema.platformAdmins).values({ userId: admin.userId, grantedBy: 'test' })
    const owner = await h.user('Noor', 'plus')
    if (ARCADE_WORLD.ref.kind !== 'stored') throw new Error('The Arcade world is kept in the store')
    store.objects.set(ARCADE_WORLD.ref.key, Buffer.from('the arcade world'))
    const server = await h.create(owner, { from: { kind: 'template', key: 'arcade' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const env = async () => (await h.app.specs.desired(h.db, await h.server(server.id))).spec.env
    // A player's server from the template: the games and labels, and no Cubepals look.
    expect((await loadRevision(h.db, server.desiredRevisionId)).files).toEqual(
      expect.arrayContaining([...ARCADE_FILES]),
    )
    expect((await env()).RESOURCE_PACK).toBeUndefined()
    expect((await env()).RESOURCE_PACK_SHA1).toBeUndefined()
    // Marked official, as `ops.ts official on` marks it: the pack, by its link and hash.
    await h.app.listings.markOfficial(admin, server.id, true, 'Cubepals runs it')
    expect((await env()).RESOURCE_PACK).toBe(h.app.specs.brandPack.url)
    expect((await env()).RESOURCE_PACK_SHA1).toBe(h.app.specs.brandPack.sha1)
    await h.app.listings.markOfficial(admin, server.id, false, 'Not ours any more')
    expect((await env()).RESOURCE_PACK).toBeUndefined()
  }, 30_000)
})
