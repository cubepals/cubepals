// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade template: Paper on the newest release the moderation tools run on, with them, the
 * chat filter and the Grim anticheat, and Cubepals' Via plugins beside them, never among them; offered
 * with Plus; and a server of it starting on the Arcade's world, fetched through its own link,
 * with the games' datapack and the moderation files, the datapack following the server onto a fresh world,
 * and no resource pack offered as a player joins, the one Cubepals' own Arcade offered cleared.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { TEMPLATE_CARDS } from '@blockly/contracts'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import { onLevel } from '../../domain/revision/carried.ts'
import { ARCADE_WORLD } from '../../minecraft/arcade/maps.ts'
import { ARCADE_DATAPACK, ARCADE_FILES } from '../../minecraft/arcade.ts'
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
import { CHAT_FILTER } from '../moderation/chat-filter.ts'
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
      joins: { oldest: '1.9', newer: true },
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
      expect(readFileSync(`${volume}/${file.path}`, file.encoding ?? 'utf8')).toBe(file.content)

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

describe.skipIf(!hasDatabase)('an Arcade made before its games changed', () => {
  beforeAll(begin, 30_000)
  afterAll(end)

  test('an Arcade made before its games changed plays them as they are now from its next start, and nothing else of it changes', async () => {
    const owner = await h.user('Ines', 'plus')
    if (ARCADE_WORLD.ref.kind !== 'stored') throw new Error('The Arcade world is kept in the store')
    store.objects.set(ARCADE_WORLD.ref.key, Buffer.from('the arcade world'))
    const server = await h.create(owner, { from: { kind: 'template', key: 'arcade' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    // As a server made on an earlier day has it: the datapack as it was then, a function since
    // gone among it and one since added missing, and its owner's chat filter turned off.
    const pack = `${ARCADE_DATAPACK}/data/arcade/function/`
    const then = [
      ...ARCADE_FILES.filter((file) => !file.path.startsWith(`${pack}play/`)).map((file) =>
        file.path.endsWith('/hub/back.mcfunction') ? { ...file, content: 'say an older hub\n' } : file,
      ),
      { path: `${pack}gone.mcfunction`, content: 'say gone\n' },
      ...moderationFiles(null),
    ]
    const revisionId = (await h.server(server.id)).desiredRevisionId
    await h.db
      .update(schema.serverRevisions)
      .set({ files: then })
      .where(eq(schema.serverRevisions.id, revisionId))
    const running = await h.app.specs.desired(h.db, await h.server(server.id))
    const drift = running.driftDigest
    await h.app.servers.restart(owner, server.id, randomUUID())
    await h.until(server.id, 'running')
    await h.settled(server.id)

    const volume = h.runtime.machine(server.id)?.dir ?? ''
    const now = [...ARCADE_FILES, ...moderationFiles(null)].map((file) => onLevel(file, 'world'))
    for (const file of now)
      expect(readFileSync(`${volume}/${file.path}`, file.encoding ?? 'utf8')).toBe(file.content)
    // What only the older datapack had is gone; the chat filter stays off, as its owner left it.
    expect(
      existsSync(`${volume}/${onLevel({ path: `${pack}gone.mcfunction`, content: '' }, 'world').path}`),
    ).toBe(false)
    expect(existsSync(`${volume}/plugins/ChatSentinel/config.yml`)).toBe(false)
    // Its revision, its world and its drift are as they were: nothing restarts a running server
    // for Cubepals' files, and nothing of the owner's moves.
    expect((await loadRevision(h.db, revisionId)).files).toEqual(then)
    expect((await h.server(server.id)).desiredRevisionId).toBe(revisionId)
    expect((await listWorlds(h.db, server.id)).map((w) => w.levelName)).toEqual(['world'])
    expect((await h.app.specs.desired(h.db, await h.server(server.id))).driftDigest).toBe(drift)
  }, 30_000)
})

describe.skipIf(!hasDatabase)("Cubepals' resource pack on an Arcade", () => {
  beforeAll(begin, 30_000)
  afterAll(end)

  test('no Arcade offers a resource pack as a player joins, and each clears one it offered, official or not', async () => {
    const admin: Actor = { kind: 'admin', userId: (await h.user('Admin')).userId }
    await h.db.insert(schema.platformAdmins).values({ userId: admin.userId, grantedBy: 'test' })
    const owner = await h.user('Noor', 'plus')
    if (ARCADE_WORLD.ref.kind !== 'stored') throw new Error('The Arcade world is kept in the store')
    store.objects.set(ARCADE_WORLD.ref.key, Buffer.from('the arcade world'))
    const server = await h.create(owner, { from: { kind: 'template', key: 'arcade' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const env = async () => (await h.app.specs.desired(h.db, await h.server(server.id))).spec.env
    // Written empty, not left out: the image keeps a setting it is no longer given, so a world that
    // offered the pack once goes on offering it until the setting is written again.
    const cleared = async () => {
      const { RESOURCE_PACK, RESOURCE_PACK_SHA1, RESOURCE_PACK_ID, RESOURCE_PACK_PROMPT } = await env()
      expect([RESOURCE_PACK, RESOURCE_PACK_SHA1, RESOURCE_PACK_ID, RESOURCE_PACK_PROMPT]).toEqual([
        '',
        '',
        '',
        '',
      ])
    }
    // A player's server from the template: the games and labels, and no pack offered.
    expect((await loadRevision(h.db, server.desiredRevisionId)).files).toEqual(
      expect.arrayContaining([...ARCADE_FILES]),
    )
    await cleared()
    // Marked official, as `ops.ts official on` marks it, as Cubepals' own Arcade that offered it was.
    await h.app.listings.markOfficial(admin, server.id, true, 'Cubepals runs it')
    await cleared()
    // No longer official, it still clears the pack it offered while it was.
    await h.app.listings.markOfficial(admin, server.id, false, 'Not ours any more')
    await cleared()
  }, 30_000)
})

describe.skipIf(!hasDatabase)('an Arcade that only sleeps and wakes', () => {
  beforeAll(async () => {
    await begin()
    h.runtime.sleeps.on = true
  }, 30_000)
  afterAll(end)

  test('asleep on older games, its next wake boots once to place them, and it wakes as it slept after that', async () => {
    const owner = await h.user('Remy', 'plus')
    if (ARCADE_WORLD.ref.kind !== 'stored') throw new Error('The Arcade world is kept in the store')
    store.objects.set(ARCADE_WORLD.ref.key, Buffer.from('the arcade world'))
    const server = await h.create(owner, { from: { kind: 'template', key: 'arcade' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    /** Put to sleep, then woken: the steps its start took. */
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
    // With its games as Cubepals has them, a wake is a resume, as for any server.
    expect(await sleepAndWake()).toContain('resuming')

    // Cubepals' games change while it sleeps, as a deploy changes them, its revision as it was:
    // as production's Arcade was after #103, which woke on its old datapack without the play
    // functions. Its first wake after places them with a boot.
    const changed = ARCADE_FILES.find((file) => file.path.endsWith('/hub/back.mcfunction'))
    if (changed === undefined) throw new Error('The Arcade has no hub/back function')
    const before = changed.content
    try {
      const first = await sleepAndWake(async () => {
        ;(changed as { content: string }).content = `${before}say a newer hub\n`
      })
      expect(first).toContain('booting')
      expect(first).not.toContain('resuming')
      const volume = h.runtime.machine(server.id)?.dir ?? ''
      expect(readFileSync(`${volume}/${onLevel(changed, 'world').path}`, 'utf8')).toBe(
        `${before}say a newer hub\n`,
      )
      // And every wake after resumes again.
      const second = await sleepAndWake()
      expect(second).toContain('resuming')
      expect(second).not.toContain('booting')
    } finally {
      ;(changed as { content: string }).content = before
    }
  }, 60_000)
})
