// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Complete public read models keep owner, guest and invite privileges distinct in real records. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PublicServerView, ShareView } from '@blockly/contracts'
import { DAY_MS, HOUR_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { ConfiguredPlayAddressing } from '../../config/play-addressing.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { DEFAULT_GAME_VERSION } from '../../minecraft/versions.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { SharingQueries } from './queries.ts'

let h: Harness
beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30 * SECOND_MS)
afterAll(async () => {
  await h?.close()
})
test.skipIf(!hasDatabase)(
  'public and invited pages preserve complete player facts and access',
  async () => {
    const owner = await h.user('Page owner', 'plus')
    const server = await h.create(owner, { name: 'Moss Meadow' })
    await h.until(server.id, 'running', 3 * SECOND_MS)
    await h.settled(server.id, 3 * SECOND_MS)
    expect(h.app.sharingQueries).toBeInstanceOf(SharingQueries)
    const q = h.app.sharingQueries
    const stranger = await h.user('Another owner', 'plus')
    const expected = privatePage(server.slug)
    expect(await q.page(server.slug, owner)).toEqual(expected)
    for (const viewer of [null, stranger, { kind: 'system' as const, reason: 'policy' as const }]) {
      expect(await q.page(server.slug, viewer)).toBeNull()
      expect(await q.reach({ slug: server.slug }, viewer)).toBeNull()
    }
    expect(await q.reach({ slug: server.slug }, owner)).toEqual({
      server: await h.server(server.id),
      page: `/server/${server.slug}`,
    })
    expect(await q.invite(server.inviteCode)).toEqual({
      ...expected,
      invited: true,
      preview: false,
      yours: false,
    })
    expect(await q.invite(server.inviteCode, owner)).toEqual({ ...expected, invited: true, preview: false })
    expect(await q.reach({ code: server.inviteCode }, null)).toEqual({
      server: await h.server(server.id),
      page: `/join/${server.inviteCode}`,
    })
    const share: ShareView = {
      joinAddress: `${server.slug}.play.test`,
      inviteUrl: `http://localhost:3000/join/${server.inviteCode}`,
      pageUrl: `http://localhost:3000/server/${server.slug}`,
      public: false,
      listed: false,
      reasons: [],
      directoryPaused: false,
      moderation: 'clear',
      moderationNote: null,
      whitelistOnly: false,
      copying: { on: true, locked: false, why: null },
    }
    expect(await q.share(owner, server.id)).toEqual(share)
    await expect(q.share(stranger, server.id)).rejects.toMatchObject({ name: 'NotFound' })
    await expect(q.share(owner, crypto.randomUUID())).rejects.toMatchObject({ name: 'NotFound' })
    expect(await q.page('missing', null)).toBeNull()
    expect(await q.invite('missing')).toBeNull()
    expect(await q.reach({ slug: 'missing' }, owner)).toBeNull()
    expect(await q.reach({ code: 'missing' }, owner)).toBeNull()
    await h.app.servers.saveIdentity(owner, server.id, {
      name: 'Sunset Moss',
      description: 'Friends welcome',
      icon: 'grass',
      tags: ['survival'],
    })
    await h.app.listings.setPublic(owner, server.id, true)
    const published: PublicServerView = {
      ...expected,
      name: 'Sunset Moss',
      description: 'Friends welcome',
      icon: 'grass',
      tags: ['survival'],
      public: true,
      preview: false,
      yours: false,
    }
    for (const viewer of [null, stranger, { kind: 'system' as const, reason: 'policy' as const }, { kind: 'operator' as const, name: 'Fixture operator' }]) {
      expect(await q.page(server.slug, viewer)).toEqual(published)
    }
    expect(await q.page(server.slug, owner)).toEqual({ ...published, yours: true })
    expect(await q.share(owner, server.id)).toEqual({ ...share, public: true, listed: true })
    await publicVariants(q, owner, server, published, share)
    const opened = await q.page(server.slug, stranger, { reactions: true })
    expect(opened).toEqual({
      ...published,
      reactions: { serverId: server.id, stars: 0, notes: 0, starred: false, yours: false },
    })
    await h.db
      .update(schema.serverAccess)
      .set({ whitelistEnabled: false, whitelistEnabledPending: true })
      .where(eq(schema.serverAccess.serverId, server.id))
    expect(await q.share(owner, server.id)).toEqual({
      ...share,
      public: true,
      listed: true,
      whitelistOnly: true,
    })
    expect(await q.page(server.slug, null)).toEqual({ ...published, whitelistOnly: true })
    await h.app.servers.stop(owner, server.id, crypto.randomUUID())
    await h.until(server.id, 'stopped', 3 * SECOND_MS)
    await h.settled(server.id, 3 * SECOND_MS)
    expect(await q.page(server.slug, null)).toEqual({ ...published, whitelistOnly: true, awake: false })
    for (const status of ['stored', 'storing'] as const) {
      await h.db
        .update(schema.minecraftServers)
        .set({ status })
        .where(eq(schema.minecraftServers.id, server.id))
      expect(await q.page(server.slug, null)).toEqual({
        ...published,
        whitelistOnly: true,
        awake: false,
        wakesSlowly: true,
      })
    }
  },
  30 * SECOND_MS,
)

test.skipIf(!hasDatabase)(
  'a resting private server reveals only its name to a guest',
  async () => {
    const owner = await h.user('Trial owner', 'free')
    const server = await h.create(owner, { name: 'Resting Moss' })
    await h.until(server.id, 'running', 3 * SECOND_MS)
    await h.settled(server.id, 3 * SECOND_MS)
    await h.app.servers.stop(owner, server.id, crypto.randomUUID())
    await h.until(server.id, 'stopped', 3 * SECOND_MS)
    await h.settled(server.id, 3 * SECOND_MS)
    const stoppedAt = new Date(Date.now() - 2 * DAY_MS)
    await h.db.insert(schema.powerIntervals).values({
      serverId: server.id,
      memoryTier: '3g',
      plan: 'free',
      startedAt: new Date(stoppedAt.getTime() - 21 * HOUR_MS),
      stoppedAt,
    })
    const q = h.app.sharingQueries
    expect(await q.page(server.slug, null)).toBeNull()
    expect(await q.page(server.slug, null, { reactions: true })).toEqual({
      kind: 'resting',
      resting: { name: 'Resting Moss', yours: false },
    })
    const own = await q.page(server.slug, owner, { reactions: true })
    expect(own).toMatchObject({
      preview: true,
      yours: true,
      resting: { name: 'Resting Moss', yours: true, serverId: server.id },
    })
    expect(own && 'reactions' in own ? own.reactions : 'missing').toBeNull()
  },
  30 * SECOND_MS,
)

test.skipIf(!hasDatabase)(
  'each public read uses its own address key and refuses a spent limit',
  async () => {
    const calls: { key: string; limit: number }[] = []
    let allow = true
    const q = new SharingQueries({
      db: h.db,
      addressing: new ConfiguredPlayAddressing({ domain: 'play.test', aliases: [], port: 25565 }),
      catalog: h.catalog,
      limits: {
        async allow(key, limit) {
          calls.push({ key, limit })
          return allow
        },
      },
      webOrigin: 'https://share.test',
      providers: ['fake'],
      capabilities: { archives: null, billing: null },
    })
    await q.page('absent', null)
    await q.page('absent', null, { reactions: true, from: '203.0.113.2' })
    await q.invite('absent', null, '203.0.113.3')
    expect(calls).toEqual([
      { key: 'status:absent@unknown', limit: 240 },
      { key: 'page:absent@203.0.113.2', limit: 120 },
      { key: 'invite:absent@203.0.113.3', limit: 60 },
      { key: 'invites@203.0.113.3', limit: 1200 },
    ])
    allow = false
    await expect(q.page('absent', null)).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'Cubepals is busy for a moment. Try again shortly.',
    })
  },
  30 * SECOND_MS,
)

test.skipIf(!hasDatabase)(
  'installed mods and packs tell invitees exactly what to install and keep copying locked',
  async () => {
    const owner = await h.user('Mod owner', 'plus')
    const server = await h.create(owner, { name: 'Modded Moss', loader: 'fabric', gameVersion: '1.21.1' })
    await h.until(server.id, 'running', 3 * SECOND_MS)
    await h.settled(server.id, 3 * SECOND_MS)
    const current = await h.server(server.id)
    const artifact = {
      ref: { kind: 'remote' as const, url: 'https://files.example.test/mod.jar' },
      sha512: 'a'.repeat(128),
      sizeBytes: 100,
      fileName: 'mod.jar',
    }
    const mod = {
      source: { catalog: 'modrinth', projectId: 'moss', versionId: 'moss-v1' },
      name: 'Moss Blocks',
      versionLabel: '1',
      artifact,
      environment: 'both' as const,
      loaders: ['fabric'],
      gameVersions: ['1.21.1'],
      origin: 'user' as const,
      requiredBy: [],
    }
    const optional = {
      ...mod,
      source: { catalog: 'foreign', projectId: 'voice', versionId: 'voice-v1' },
      name: 'Optional Voice',
      environment: 'optional' as const,
      origin: 'dependency' as const,
    }
    const serverOnly = {
      ...mod,
      name: 'Server Tools',
      environment: 'server' as const,
      origin: 'dependency' as const,
    }
    await h.db
      .update(schema.serverRevisions)
      .set({ mods: [mod, optional, serverOnly] })
      .where(eq(schema.serverRevisions.id, current.desiredRevisionId))
    const q = h.app.sharingQueries
    const invited = await q.invite(server.inviteCode)
    expect(invited?.mods).toEqual(['Moss Blocks'])
    expect(invited?.needs).toEqual({
      gameVersion: '1.21.1',
      joins: { oldest: '1.21.1', newer: false },
      modpack: null,
      loader: { label: 'Fabric', version: '0.19.5' },
      mods: [
        { name: 'Moss Blocks', url: 'https://catalog.test/project/moss' },
        { name: 'Optional Voice', url: null },
      ],
    })
    expect((await q.share(owner, server.id)).copying).toEqual({
      on: false,
      locked: true,
      why: 'It runs mods Cubepals hasn’t checked yet.',
    })
    const pack = {
      catalog: 'upload',
      projectId: 'pack',
      versionId: 'pack-v1',
      name: 'Moss Pack',
      versionLabel: '2.3',
      artifact,
      page: 'https://packs.example.test/moss',
      environment: 'server' as const,
      icon: null,
    }
    for (const environment of ['server', 'both'] as const) {
      await h.db
        .update(schema.serverRevisions)
        .set({ mods: [], modpack: { ...pack, environment } })
        .where(eq(schema.serverRevisions.id, current.desiredRevisionId))
      expect((await q.invite(server.inviteCode))?.needs).toEqual({
        gameVersion: '1.21.1',
        joins: { oldest: '1.21.1', newer: false },
        modpack:
          environment === 'server'
            ? null
            : {
                name: 'Moss Pack',
                version: '2.3',
                icon: null,
                page: pack.page,
                file: artifact.ref.url,
                app: null,
                environment,
              },
        loader: null,
        mods: [],
      })
      expect((await q.share(owner, server.id)).copying).toEqual({
        on: false,
        locked: true,
        why: 'It plays a modpack, and Cubepals hasn’t checked every mod in it.',
      })
    }
  },
  30 * SECOND_MS,
)

function privatePage(slug: string): PublicServerView {
  return {
    slug: slug,
    name: 'Moss Meadow',
    description: '',
    credits: null,
    icon: null,
    ownIcon: null,
    tags: [],
    joinAddress: `${slug}.play.test`,
    awake: true,
    wakesSlowly: false,
    online: 0,
    maxPlayers: 5,
    players: [],
    checksAccounts: true,
    gameVersion: DEFAULT_GAME_VERSION,
    loader: 'vanilla',
    needs: {
      gameVersion: DEFAULT_GAME_VERSION,
      joins: { oldest: DEFAULT_GAME_VERSION, newer: false },
      modpack: null,
      loader: null,
      mods: [],
    },
    bedrock: false,
    mods: [],
    whitelistOnly: false,
    invited: false,
    public: false,
    preview: true,
    official: false,
    copyable: true,
    yours: true,
    chipIn: null,
    reactions: null,
  }
}

async function publicVariants(
  q: SharingQueries,
  owner: UserActor,
  server: MinecraftServer,
  page: PublicServerView,
  share: ShareView,
) {
  const player = { uuid: crypto.randomUUID(), name: 'MossVisitor' }
  h.minecraft.join(server.id, player)
  await h.app.schedules.presenceSync()
  expect(await q.page(server.slug, null)).toEqual({ ...page, online: 1, players: ['MossVisitor'] })
  const [revision] = await h.db
    .select()
    .from(schema.serverRevisions)
    .where(eq(schema.serverRevisions.id, server.desiredRevisionId))
  if (!revision) throw new Error('The fixture revision must exist')
  await h.db
    .update(schema.serverRevisions)
    .set({ settings: { ...revision.settings, onlineMode: false } })
    .where(eq(schema.serverRevisions.id, server.desiredRevisionId))
  expect(await q.page(server.slug, null)).toEqual({ ...page, online: 1, checksAccounts: false })
  await h.db
    .update(schema.serverRevisions)
    .set({ settings: revision.settings })
    .where(eq(schema.serverRevisions.id, server.desiredRevisionId))
  h.minecraft.leave(server.id, player.uuid)
  await h.app.schedules.presenceSync()
  await h.db.update(schema.platformControls).set({ publicListingEnabled: false })
  expect(await q.share(owner, server.id)).toEqual({
    ...share,
    public: true,
    listed: false,
    directoryPaused: true,
  })
  await h.db.update(schema.platformControls).set({ publicListingEnabled: true })
  await h.db
    .update(schema.publicListings)
    .set({
      moderation: 'removed',
      moderationNote: 'Review pending',
      eligible: false,
      ineligibleReasons: [{ code: 'untrusted_mods', detail: 'An uploaded jar' }, { code: 'not_running_yet' }],
    })
    .where(eq(schema.publicListings.serverId, server.id))
  expect(await q.share(owner, server.id)).toEqual({
    ...share,
    public: true,
    listed: false,
    moderation: 'removed',
    moderationNote: 'Review pending',
    reasons: [{ code: 'untrusted_mods', detail: 'An uploaded jar' }, { code: 'not_running_yet' }],
  })
  await h.db
    .update(schema.publicListings)
    .set({ moderation: 'clear', moderationNote: null, eligible: true, ineligibleReasons: [] })
    .where(eq(schema.publicListings.serverId, server.id))
}
