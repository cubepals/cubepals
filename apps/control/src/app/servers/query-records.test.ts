// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Owner read models preserve configuration and account boundaries in real database records. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { CreateOptions, ModpackHit, ServerView, SettingsOptions } from '@blockly/contracts'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { DEFAULT_GAME_VERSION } from '../../minecraft/versions.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import createOptions from './create-options.fixture.json' with { type: 'json' }
import { ServerQueries } from './queries.ts'
import settingsOptions from './settings-options.fixture.json' with { type: 'json' }
import { openRun } from './usage.ts'

let h: Harness
beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30 * SECOND_MS)
afterAll(async () => {
  await h?.close()
})
test.skipIf(!hasDatabase)(
  'owner pages preserve the complete running and stopped server',
  async () => {
    const owner = await h.user('Read owner', 'plus')
    const server = await h.create(owner, { name: 'Birch Meadow' })
    await h.until(server.id, 'running', 3 * SECOND_MS)
    await h.settled(server.id, 3 * SECOND_MS)
    expect(h.app.queries).toBeInstanceOf(ServerQueries)
    const q = h.app.queries
    const current = await h.server(server.id)
    const started = await openRun(h.db, server.id)
    if (!started) throw new Error('The fixture server must have an open run')
    const expected = runningView(server, current, started)
    expect(await q.get(owner, server.id)).toEqual(expected)
    expect(await q.list(owner)).toEqual([expected])
    expect(await q.settingsOptions(owner, server.id)).toEqual(settingsOptions as SettingsOptions)
    expect(await q.createOptions(owner)).toEqual(createOptions as CreateOptions)
    expect(await q.revisions(owner, server.id)).toEqual([
      {
        id: current.desiredRevisionId,
        number: 1,
        reason: 'created',
        gameVersion: DEFAULT_GAME_VERSION,
        loader: 'vanilla',
        createdAt: server.createdAt.toISOString(),
        byOwner: true,
        changes: [],
        fromCurrent: [],
        desired: true,
        applied: true,
      },
    ])
    const stranger = await h.user('Read stranger', 'free')
    expect(await q.list(stranger)).toEqual([])
    const freeChoices = await q.createOptions(stranger)
    expect(freeChoices.defaults).toEqual({
      gameVersion: DEFAULT_GAME_VERSION,
      loader: 'vanilla',
      regionKey: 'local',
    })
    expect(freeChoices.partySizes.map((x) => ({ value: x.value, allowed: x.allowed }))).toEqual([
      { value: '5', allowed: true },
      { value: '10', allowed: false },
      { value: '20', allowed: false },
      { value: '50', allowed: false },
      { value: 'more', allowed: false },
    ])
    for (const id of [server.id, crypto.randomUUID()]) {
      await expect(q.get(stranger, id)).rejects.toMatchObject({ name: 'NotFound' })
      await expect(q.settingsOptions(stranger, id)).rejects.toMatchObject({ name: 'NotFound' })
      await expect(q.revisions(stranger, id)).rejects.toMatchObject({ name: 'NotFound' })
      await expect(q.access(stranger, id)).rejects.toMatchObject({ name: 'NotFound' })
    }
    expect(await q.trash(owner)).toEqual([])
    expect(await q.purgedArchives(owner)).toEqual([])
    const player = { name: 'MossPlayer', uuid: crypto.randomUUID() }
    h.minecraft.join(server.id, player)
    await h.app.schedules.presenceSync()
    expect(await q.get(owner, server.id)).toEqual({
      ...expected,
      players: { online: 1, people: [player] },
      sleepsAt: null,
      everPlayed: true,
    })
    const [access] = await h.db
      .select()
      .from(schema.serverAccess)
      .where(eq(schema.serverAccess.serverId, server.id))
    expect(await q.access(owner, server.id)).toEqual({
      whitelistEnabled: false,
      pendingWhitelistEnabled: null,
      entries: [],
      syncedAt: access?.syncedAt?.toISOString() ?? null,
      syncError: null,
      version: 1,
      liftedIpBans: [],
      players: [{ ...player, online: true }],
    })
    h.minecraft.leave(server.id, player.uuid)
    await h.app.schedules.presenceSync()
    await h.app.servers.stop(owner, server.id, crypto.randomUUID())
    await h.until(server.id, 'stopped', 3 * SECOND_MS)
    await h.settled(server.id, 3 * SECOND_MS)
    expect(await q.get(owner, server.id)).toEqual({
      ...expected,
      status: 'stopped',
      stopReason: 'user',
      version: (await h.server(server.id)).version,
      players: null,
      sleepsAt: null,
      everPlayed: true,
    })
    await accessRecords(q, owner, server.id)
    await operationRecords(q, owner, await h.server(server.id))
    expect(await q.setupPreview(owner, { kind: 'template', key: 'survival' })).toEqual({
      from: 'Survival',
      copying: null,
      gameVersion: '26.2',
      loader: 'vanilla',
      loaderLabel: 'Vanilla',
      joins: { oldest: '1.9', newer: true },
      bedrock: false,
      mods: [],
      modpack: null,
      size: { label: '3 GB', allowed: true },
    })
  },
  30 * SECOND_MS,
)

test.skipIf(!hasDatabase)(
  'pack search and pasted links preserve catalogue facts and version choices',
  async () => {
    const owner = await h.user('Pack reader', 'plus')
    const q = h.app.queries
    const projects = [
      {
        projectId: 'forest-pack',
        slug: 'forest-pack',
        name: 'Forest Pack',
        summary: 'Build in the woods',
        iconUrl: 'https://images.example.test/forest.png',
        environments: ['client_and_server' as const],
        downloads: 137,
        categories: ['fabric'],
        gameVersions: ['1.20.1', '1.21.1'],
      },
      {
        projectId: 'client-pack',
        slug: 'client-pack',
        name: 'Client Pack',
        summary: 'Player graphics',
        iconUrl: null,
        environments: ['client_only' as const],
        downloads: 61,
        categories: [],
        gameVersions: ['1.21.1'],
      },
    ]
    for (const project of projects) {
      const environment = project.environments[0]
      if (!environment) throw new Error('A fixture project must name its environment')
      h.catalog.publishModpack(project, [
        {
          versionId: `${project.projectId}-v1`,
          projectId: project.projectId,
          versionLabel: 'Release One',
          channel: 'release',
          state: 'listed',
          environment,
          loaders: ['fabric'],
          gameVersions: ['1.20.1', '1.21.1'],
          publishedAt: new Date('2026-01-02T00:00:00Z'),
          file: {
            url: 'https://files.example.test/pack.mrpack',
            sha512: 'a'.repeat(128),
            sizeBytes: 120,
            fileName: 'pack.mrpack',
          },
          dependencies: [],
        },
      ])
      await h.db
        .insert(schema.packChecks)
        .values({ catalog: 'modrinth', projectId: project.projectId, refusal: null, checkedAt: new Date() })
    }
    const hit: ModpackHit = {
      projectId: 'forest-pack',
      name: 'Forest Pack',
      summary: 'Build in the woods',
      iconUrl: 'https://images.example.test/forest.png',
      downloads: 137,
      gameVersion: '1.21.1',
      runsOnServers: true,
      refusal: null,
      fits: { allowed: true },
    }
    expect(await q.searchModpacks(owner, { text: '', offset: 0, limit: 10 })).toEqual([hit])
    expect(await q.searchModpacks(owner, { text: 'Forest', offset: 0, limit: 10 })).toEqual([hit])
    expect(await q.searchModpacks(owner, { text: '', offset: 1, limit: 1 })).toEqual([])
    expect(await q.searchModpacks(owner, { text: 'Client', offset: 0, limit: 10 })).toEqual([
      {
        projectId: 'client-pack',
        name: 'Client Pack',
        summary: 'Player graphics',
        iconUrl: null,
        downloads: 61,
        gameVersion: '1.21.1',
        runsOnServers: false,
        refusal: null,
        fits: { allowed: true },
      },
    ])
    expect(await q.packFromLink(owner, 'https://catalog.test/modpack/forest-pack')).toEqual({
      kind: 'pack',
      hit,
      versionId: null,
      versionLabel: null,
    })
    for (const version of ['forest-pack-v1', 'Release%20One']) {
      const link = version === 'Release%20One' ? 'Release One' : version
      expect(await q.packFromLink(owner, `https://catalog.test/modpack/forest-pack/version/${link}`)).toEqual(
        { kind: 'pack', hit, versionId: 'forest-pack-v1', versionLabel: 'Release One' },
      )
    }
    expect(await q.packVersions('forest-pack')).toEqual([
      {
        versionId: 'forest-pack-v1',
        label: 'Release One',
        gameVersion: '1.21.1',
        loaderLabel: 'Fabric',
        publishedAt: '2026-01-02T00:00:00.000Z',
      },
    ])
    expect(await q.packFromLink(owner, 'https://catalog.test/modpack/forest-pack/version/missing')).toEqual({
      kind: 'refused',
      message:
        'That version of Forest Pack doesn’t run as a server Cubepals can make. Search for Forest Pack to get the newest one that does.',
      page: null,
    })
    expect(await q.packFromLink(owner, 'https://catalog.test/modpack/absent')).toEqual({
      kind: 'refused',
      message: 'Cubepals couldn’t find that pack. Check the link, or search for it by name.',
      page: null,
    })
    expect(await q.packFromLink(owner, 'https://catalog.test/mod/forest-pack')).toEqual({
      kind: 'refused',
      message: 'That’s a single mod, not a modpack. Make the server first, then add it from its Mods page.',
      page: null,
    })
  },
  30 * SECOND_MS,
)

function runningView(
  server: MinecraftServer,
  current: MinecraftServer,
  started: NonNullable<Awaited<ReturnType<typeof openRun>>>,
): ServerView {
  return {
    id: server.id,
    name: 'Birch Meadow',
    description: '',
    icon: null,
    ownIcon: null,
    tags: [],
    slug: server.slug,
    joinAddress: `${server.slug}.play.test`,
    status: 'running',
    stopReason: null,
    crash: null,
    failure: null,
    notLoaded: [],
    gameVersion: DEFAULT_GAME_VERSION,
    joins: { oldest: DEFAULT_GAME_VERSION, newer: false, otherVersions: null },
    bedrock: false,
    loader: 'vanilla',
    loaderVersion: null,
    maxPlayers: 5,
    playStyle: 'survival',
    region: { key: 'local', label: 'This computer' },
    memoryTier: '3g',
    activeOperation: null,
    lastWakeSeconds: null,
    players: { online: 0, people: [] },
    createdAt: server.createdAt.toISOString(),
    version: current.version,
    settings: {
      pvp: true,
      motd: '"Birch Meadow", a server created by Cubepals',
      difficulty: 'normal',
      maxPlayers: 5,
      onlineMode: true,
      viewDistance: 10,
      defaultGameMode: 'survival',
      spawnProtection: 0,
      simulationDistance: 10,
    },
    partySize: '5',
    sessionEndsAt: null,
    sleepsAt: new Date(
      Math.max(started.startedAt.getTime(), started.readyAt?.getTime() ?? 0) + 15 * MINUTE_MS,
    ).toISOString(),
    playToday: null,
    playTotal: null,
    cameBy: [],
    movesToSize: null,
    roomier: { partySize: '10', label: '4 GB' },
    pendingRestart: false,
    onlyServer: true,
    expiresAt: null,
    deletesAt: null,
    modCount: 0,
    modpack: null,
    everPlayed: false,
    lastChange: null,
  }
}

test.skipIf(!hasDatabase)(
  'free settings, revision history and retained worlds keep their boundaries',
  async () => {
    const owner = await h.user('Free reader', 'free')
    const server = await h.create(owner, { name: 'Free Birch' })
    await h.until(server.id, 'running', 3 * SECOND_MS)
    await h.settled(server.id, 3 * SECOND_MS)
    const q = h.app.queries
    const options = await q.settingsOptions(owner, server.id)
    expect(options.bounds).toEqual({
      viewDistance: { min: 3, max: 8 },
      simulationDistance: { min: 3, max: 6 },
      spawnProtection: { min: 0, max: 64 },
      maxPlayers: 5,
    })
    expect(options.gameVersions).toEqual([
      {
        value: DEFAULT_GAME_VERSION,
        label: DEFAULT_GAME_VERSION,
        loaders: [
          { value: 'vanilla', label: 'Vanilla', allowed: true },
          { value: 'fabric', label: 'Fabric', allowed: false, reason: 'Fabric servers come with Plus.' },
        ],
      },
    ])
    const [initial] = await h.db
      .select()
      .from(schema.serverRevisions)
      .where(eq(schema.serverRevisions.id, server.desiredRevisionId))
    if (!initial) throw new Error('The initial revision must exist')
    await h.app.revisions.changeSettings(
      owner,
      server.id,
      { ...initial.settings, maxPlayers: 4 },
      crypto.randomUUID(),
    )
    await h.settled(server.id, 3 * SECOND_MS)
    const current = await h.server(server.id)
    const [changed] = await h.db
      .select()
      .from(schema.serverRevisions)
      .where(eq(schema.serverRevisions.id, current.desiredRevisionId))
    if (!changed) throw new Error('The changed revision must exist')
    expect(await q.revisions(owner, server.id)).toEqual([
      {
        id: changed.id,
        number: 2,
        reason: 'settings_changed',
        gameVersion: DEFAULT_GAME_VERSION,
        loader: 'vanilla',
        createdAt: changed.createdAt.toISOString(),
        byOwner: true,
        changes: [{ field: 'maxPlayers', from: 5, to: 4 }],
        fromCurrent: [],
        desired: true,
        applied: true,
      },
      {
        id: initial.id,
        number: 1,
        reason: 'created',
        gameVersion: DEFAULT_GAME_VERSION,
        loader: 'vanilla',
        createdAt: initial.createdAt.toISOString(),
        byOwner: true,
        changes: [],
        fromCurrent: [{ field: 'maxPlayers', from: 4, to: 5 }],
        desired: false,
        applied: false,
      },
    ])
    await retainedWorlds(q, owner, server, current, changed.id)
  },
  30 * SECOND_MS,
)

async function retainedWorlds(
  q: ServerQueries,
  owner: UserActor,
  server: MinecraftServer,
  current: MinecraftServer,
  revisionId: string,
) {
  await h.app.servers.stop(owner, server.id, crypto.randomUUID())
  await h.until(server.id, 'stopped', 3 * SECOND_MS)
  await h.settled(server.id, 3 * SECOND_MS)
  await h.db.update(schema.platformControls).set({ expiringEnabled: true })
  const now = new Date()
  const lastActiveAt = new Date(now.getTime() - 340 * 24 * 60 * MINUTE_MS)
  const expiresAt = new Date(now.getTime() + 24 * 60 * MINUTE_MS)
  await h.db
    .update(schema.minecraftServers)
    .set({
      stopReason: 'crash',
      failure: {
        during: 'start',
        message: 'Fixture failure',
        operationId: crypto.randomUUID(),
        remedy: 'rebuild',
      },
      notLoaded: ['Old plugin'],
      regionKey: 'unknown-place',
      expiresAt,
      lastActiveAt,
    })
    .where(eq(schema.minecraftServers.id, server.id))
  await h.db
    .update(schema.serverRuntimes)
    .set({ observed: { state: 'crashed', at: now.toISOString(), detail: 'out of memory' } })
    .where(eq(schema.serverRuntimes.serverId, server.id))
  expect(await q.get(owner, server.id)).toMatchObject({
    stopReason: 'crash',
    failure: { during: 'start', message: 'Fixture failure', remedy: 'rebuild' },
    notLoaded: ['Old plugin'],
    region: { key: 'unknown-place', label: 'unknown-place' },
    expiresAt: expiresAt.toISOString(),
    crash: { outOfMemory: true, detail: 'out of memory', at: now.toISOString() },
    deletesAt: new Date(lastActiveAt.getTime() + 365 * 24 * 60 * MINUTE_MS).toISOString(),
    lastChange: { status: 'succeeded', error: null },
  })
  const purgeAfter = new Date(now.getTime() + 7 * 24 * 60 * MINUTE_MS)
  await h.db
    .update(schema.minecraftServers)
    .set({ status: 'deleted', deletedAt: now, purgeAfter })
    .where(eq(schema.minecraftServers.id, server.id))
  expect(await q.trash(owner)).toEqual([
    {
      id: server.id,
      name: 'Free Birch',
      slug: server.slug,
      deletedAt: now.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
      backups: { snapshots: 0, archives: 0 },
      lastsOnceRestored: 24 * 60 * MINUTE_MS,
    },
  ])
  expect(await q.list(owner)).toEqual([])
  await h.db
    .update(schema.minecraftServers)
    .set({ status: 'purged' })
    .where(eq(schema.minecraftServers.id, server.id))
  await h.db.insert(schema.backups).values({
    serverId: server.id,
    worldId: current.activeWorldId,
    revisionId,
    tier: 'archive',
    trigger: 'manual',
    status: 'ready',
    archiveKey: 'fixture/archive',
    expiresAt: purgeAfter,
  })
  expect(await q.purgedArchives(owner)).toEqual([
    { id: server.id, name: 'Free Birch', archives: 1, keptUntil: purgeAfter.toISOString() },
  ])
}

async function accessRecords(q: ServerQueries, owner: UserActor, serverId: string) {
  const player = { name: 'AllowedPlayer', uuid: crypto.randomUUID() }
  await h.db.insert(schema.serverAccessEntries).values({
    serverId,
    list: 'operator',
    playerUuid: player.uuid,
    playerName: player.name,
    state: 'pending_add',
    origin: 'blockly',
    details: { reason: 'Owner invitation' },
    error: 'Retry later',
  })
  await h.db
    .update(schema.serverAccess)
    .set({ whitelistEnabled: true, whitelistEnabledPending: false, syncError: 'Waiting on game', version: 7 })
    .where(eq(schema.serverAccess.serverId, serverId))
  expect(await q.access(owner, serverId)).toMatchObject({
    whitelistEnabled: true,
    pendingWhitelistEnabled: false,
    syncError: 'Waiting on game',
    version: 7,
    entries: [
      {
        list: 'operator',
        player,
        state: 'pending_add',
        origin: 'blockly',
        error: 'Retry later',
        reason: 'Owner invitation',
      },
    ],
  })
}

async function operationRecords(q: ServerQueries, owner: UserActor, server: MinecraftServer) {
  const [backup] = await h.db
    .insert(schema.backups)
    .values({
      serverId: server.id,
      worldId: server.activeWorldId,
      revisionId: server.desiredRevisionId,
      tier: 'archive',
      trigger: 'uploaded',
      status: 'ready',
      archiveKey: 'fixture/restored',
      sizeBytes: 12345,
    })
    .returning()
  if (!backup) throw new Error('The restore backup must exist')
  await h.db
    .update(schema.worlds)
    .set({ name: 'Brought Birch' })
    .where(eq(schema.worlds.id, server.activeWorldId))
  const [operation] = await h.db
    .insert(schema.serverOperations)
    .values({
      id: crypto.randomUUID(),
      serverId: server.id,
      kind: 'restore',
      status: 'running',
      requestedBy: `user:${owner.userId}`,
      idempotencyKey: crypto.randomUUID(),
      input: { backupId: backup.id },
      progress: { step: 'loading_world', at: new Date().toISOString() },
      startedAt: new Date(),
      error: 'Previous attempt',
    })
    .returning()
  if (!operation) throw new Error('The tracked restore must exist')
  const view = {
    id: operation.id,
    kind: 'restore' as const,
    change: null,
    worldBytes: 12345,
    broughtWorld: 'Brought Birch',
    status: 'running' as const,
    step: 'loading_world' as const,
    error: 'Previous attempt',
    createdAt: operation.createdAt.toISOString(),
    startedAt: operation.startedAt?.toISOString() ?? null,
  }
  expect((await q.get(owner, server.id)).activeOperation).toEqual(view)
  await h.db
    .update(schema.backups)
    .set({ tier: 'snapshot', trigger: 'manual', snapshotHandle: 'fixture-snapshot' })
    .where(eq(schema.backups.id, backup.id))
  expect((await q.get(owner, server.id)).activeOperation).toEqual({
    ...view,
    worldBytes: null,
    broughtWorld: null,
  })
  await h.db
    .update(schema.serverOperations)
    .set({ input: {}, progress: null, startedAt: null, error: null })
    .where(eq(schema.serverOperations.id, operation.id))
  const plain = { ...view, step: null, startedAt: null, error: null, worldBytes: null, broughtWorld: null }
  expect((await q.get(owner, server.id)).activeOperation).toEqual(plain)
  await h.db
    .update(schema.serverOperations)
    .set({ kind: 'apply' })
    .where(eq(schema.serverOperations.id, operation.id))
  expect((await q.get(owner, server.id)).activeOperation).toEqual({
    ...plain,
    kind: 'apply',
    change: 'settings',
  })
  await h.db
    .update(schema.serverRuntimes)
    .set({ applied: null })
    .where(eq(schema.serverRuntimes.serverId, server.id))
  expect((await q.get(owner, server.id)).activeOperation).toEqual({ ...plain, kind: 'apply' })
  await h.db
    .update(schema.serverOperations)
    .set({ kind: 'start' })
    .where(eq(schema.serverOperations.id, operation.id))
  expect((await q.get(owner, server.id)).activeOperation).toEqual({ ...plain, kind: 'start' })
  await h.db
    .update(schema.serverOperations)
    .set({ status: 'succeeded', finishedAt: new Date() })
    .where(eq(schema.serverOperations.id, operation.id))
}
