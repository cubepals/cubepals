// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { ServerSettings } from '../../domain/revision/revision.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { listRevisions, loadRevision, loadRuntime } from '../servers/persistence.ts'

// Boot configuration changes end to end: revisions, apply, automatic and manual rollback.
describe.skipIf(!hasDatabase)('revisions', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterEach(() => {
    h.runtime.failBootWhen(() => null)
    h.minecraft.breakOn(() => null)
    h.minecraft.stallOn(() => false)
    h.minecraft.refuseCommands(null)
  })

  afterAll(async () => {
    await h.close()
  })

  const running = async (name = 'Test server', request: { gameVersion?: string } = {}) => {
    const owner = await h.user()
    const server = await h.create(owner, { name, ...request })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }
  const settingsOf = async (id: string) =>
    (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings
  const property = async (id: string, key: string) =>
    new RegExp(`^${key}=(.*)$`, 'm').exec((await h.minecraft.file(id, 'server.properties')) ?? '')?.[1]
  const change = (owner: UserActor, id: string, patch: Partial<ServerSettings>) =>
    settingsOf(id).then((current) =>
      h.app.revisions.changeSettings(owner, id, { ...current, ...patch }, randomUUID()),
    )
  const lastApply = async (id: string) => (await h.operations(id)).filter((op) => op.kind === 'apply').at(-1)

  test('a revision pins its loader build, keeps it through other changes, and a new version pins anew', async () => {
    h.loaderBuilds.builds.set('fabric', '0.19.5')
    const owner = await h.user('Steve', 'plus')
    const { id } = await h.create(owner, { name: 'Pinned', loader: 'fabric', gameVersion: '26.2' })
    await h.until(id, 'running')
    await h.settled(id)
    const desired = async () => loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect((await desired()).loaderVersion).toBe('0.19.5')
    expect(h.runtime.machine(id)?.spec.env.FABRIC_LOADER_VERSION).toBe('0.19.5')
    // A newer build is out: a settings change still boots the build the server had.
    h.loaderBuilds.builds.set('fabric', '0.19.6')
    await change(owner, id, { motd: 'Same build' })
    await h.until(id, (s) => s.lifecycle.status === 'running')
    await h.settled(id)
    expect((await desired()).loaderVersion).toBe('0.19.5')
    expect(h.runtime.machine(id)?.spec.env.FABRIC_LOADER_VERSION).toBe('0.19.5')
    // A new game version is a new choice, and takes the build that is current now.
    const before = await h.server(id)
    await h.app.mods.changeVersion(owner, id, { gameVersion: '26.3', loader: 'fabric' }, [], randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id)
    expect(await desired()).toMatchObject({ gameVersion: '26.3', loaderVersion: '0.19.6' })
    expect(h.runtime.machine(id)?.spec.env.FABRIC_LOADER_VERSION).toBe('0.19.6')
    // Vanilla has no build of its own.
    const plain = await running('Plain')
    expect((await loadRevision(h.db, (await h.server(plain.id)).desiredRevisionId)).loaderVersion).toBeNull()
    expect(
      Object.keys(h.runtime.machine(plain.id)?.spec.env ?? {}).filter((k) => k.endsWith('_VERSION')),
    ).toEqual([])
    await h.app.servers.deleteServer(owner, id, 'Pinned')
    await h.app.servers.deleteServer(plain.owner, plain.id, 'Plain')
  }, 60_000)

  test('a server type with no stable build, or a build list that is down, stops the choice with nothing made', async () => {
    const owner = await h.user('Steve', 'plus')
    h.loaderBuilds.builds.set('paper', null)
    h.loaderBuilds.down.add('fabric')
    try {
      await expect(
        h.create(owner, { name: 'No Build', loader: 'paper', gameVersion: '26.2' }),
      ).rejects.toThrow('Paper has no stable build for Minecraft 26.2 yet.')
      await expect(h.create(owner, { name: 'Down', loader: 'fabric', gameVersion: '26.2' })).rejects.toThrow(
        "Fabric's list of builds can't be reached right now.",
      )
      const made = await h.db
        .select()
        .from(schema.minecraftServers)
        .where(eq(schema.minecraftServers.ownerId, owner.userId))
      expect(made).toEqual([])
    } finally {
      h.loaderBuilds.builds.set('paper', '60')
      h.loaderBuilds.down.clear()
    }
  })

  test('a revision drafted from one made before builds were pinned takes the current build', async () => {
    h.loaderBuilds.builds.set('fabric', '0.19.5')
    const owner = await h.user('Steve', 'plus')
    const { id } = await h.create(owner, { name: 'Old Pin', loader: 'fabric', gameVersion: '26.2' })
    await h.until(id, 'running')
    await h.settled(id)
    // As revisions made before this change are: no build recorded.
    const server = await h.server(id)
    await h.db
      .update(schema.serverRevisions)
      .set({ loaderVersion: null })
      .where(eq(schema.serverRevisions.id, server.desiredRevisionId))
    h.loaderBuilds.builds.set('fabric', '0.19.7')
    await change(owner, id, { motd: 'Pinned now' })
    await h.until(id, 'running')
    await h.settled(id)
    expect((await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).loaderVersion).toBe('0.19.7')
    await h.app.servers.deleteServer(owner, id, 'Old Pin')
  }, 30_000)

  test('a change made on a server that changed since it was shown is refused, and changes nothing (§4)', async () => {
    const { owner, id } = await running('Two Tabs')
    const shown = await h.server(id)
    const current = await settingsOf(id)
    // Another tab changes the difficulty; this one still shows the server as it was.
    await h.app.revisions.changeSettings(owner, id, { ...current, difficulty: 'hard' }, randomUUID(), {
      version: shown.version,
    })
    await h.until(id, 'running')
    await h.settled(id)
    await expect(
      h.app.revisions.changeSettings(owner, id, { ...current, motd: 'Stale tab' }, randomUUID(), {
        version: shown.version,
      }),
    ).rejects.toThrow('changed since you looked')
    expect(await settingsOf(id)).toMatchObject({ difficulty: 'hard', motd: current.motd })
    // Shown again, the change goes through, on top of the other tab's.
    const again = await h.server(id)
    await h.app.revisions.changeSettings(
      owner,
      id,
      { ...current, difficulty: 'hard', motd: 'Fresh tab' },
      randomUUID(),
      {
        version: again.version,
      },
    )
    expect(await settingsOf(id)).toMatchObject({ difficulty: 'hard', motd: 'Fresh tab' })
    // Running servers count against the platform's cap, which the later tests need room under.
    await h.app.servers.deleteServer(owner, id, 'Two Tabs')
  }, 30_000)

  test('a running server restarts into settings the game reads as it starts, with no snapshot to wait for', async () => {
    const { owner, id } = await running()
    const before = await h.server(id)
    await change(owner, id, { spawnProtection: 4, difficulty: 'hard', pvp: false })
    await h.until(
      id,
      (s) => s.lifecycle.status === 'running' && s.desiredRevisionId !== before.desiredRevisionId,
    )
    await h.settled(id)
    expect((await lastApply(id))?.status).toBe('succeeded')
    expect(await property(id, 'spawn-protection')).toBe('4')
    expect(await property(id, 'difficulty')).toBe('hard')
    // PvP is a game rule the world keeps on 26.3, which the start sets.
    expect(h.minecraft.playing(id).pvp).toBe(false)
    const binding = await loadRuntime(h.db, id, ['fake'])
    const after = await h.server(id)
    expect(binding.applied?.revisionId).toBe(after.desiredRevisionId)
    const revision = await loadRevision(h.db, after.desiredRevisionId)
    expect(revision).toMatchObject({
      number: 2,
      reason: 'settings_changed',
      basedOnRevisionId: before.desiredRevisionId,
    })
    // Settings leave the disk as they found it, and going back puts back the settings: a snapshot
    // would only keep the change waiting on it.
    expect(await h.db.select().from(schema.backups).where(eq(schema.backups.serverId, id))).toEqual([])
  })

  test('a stopped server keeps the change for its next start', async () => {
    const { owner, id } = await running()
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await change(owner, id, { difficulty: 'peaceful', pvp: false })
    await h.settled(id)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    expect(await lastApply(id)).toBeUndefined()
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(await property(id, 'difficulty')).toBe('peaceful')
    expect(h.minecraft.playing(id)).toMatchObject({ difficulty: 'peaceful', pvp: false })
    expect((await loadRuntime(h.db, id, ['fake'])).applied?.revisionId).toBe(
      (await h.server(id)).desiredRevisionId,
    )
  })

  test('a running server takes difficulty, game mode and PvP as people play, without a restart', async () => {
    const { owner, id } = await running()
    const alex = { uuid: randomUUID(), name: 'Alex' }
    h.minecraft.join(id, alex)
    const before = await h.server(id)
    const ran = (await loadRuntime(h.db, id, ['fake'])).applied
    await change(owner, id, { difficulty: 'hard', defaultGameMode: 'creative', pvp: false })
    await h.until(
      id,
      (s) => s.lifecycle.status === 'running' && s.desiredRevisionId !== before.desiredRevisionId,
    )
    await h.settled(id)
    expect((await lastApply(id))?.status).toBe('succeeded')
    // Whoever is on moves to the new game mode, and nobody was sent away.
    expect(h.minecraft.playing(id)).toEqual({
      difficulty: 'hard',
      defaultGameMode: 'creative',
      pvp: false,
      modes: { Alex: 'creative' },
    })
    expect(await h.db.select().from(schema.backups).where(eq(schema.backups.serverId, id))).toEqual([])
    expect(h.runtime.machine(id)?.spec.env.DIFFICULTY).toBe('normal')
    const applied = (await loadRuntime(h.db, id, ['fake'])).applied
    expect(applied?.revisionId).toBe((await h.server(id)).desiredRevisionId)
    expect(applied?.specDigest).toBe(ran?.specDigest)
    // Drift leaves it be, and the next start boots the new settings, so the change holds.
    h.minecraft.leave(id, alex.uuid)
    const applies = (await h.operations(id)).filter((op) => op.kind === 'apply').length
    await h.app.schedules.drift()
    expect((await h.operations(id)).filter((op) => op.kind === 'apply')).toHaveLength(applies)
    await h.app.servers.restart(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 3)
    await h.settled(id)
    expect(await property(id, 'difficulty')).toBe('hard')
    expect(await property(id, 'gamemode')).toBe('creative')
    expect(h.minecraft.playing(id)).toMatchObject({
      difficulty: 'hard',
      defaultGameMode: 'creative',
      pvp: false,
    })
    expect((await loadRuntime(h.db, id, ['fake'])).applied?.specDigest).not.toBe(ran?.specDigest)
    await h.app.servers.deleteServer(owner, id, 'Test server')
  })

  test('a setting the game turns down, or one its release reads only as it starts, restarts the server into it', async () => {
    const turnedDown = await running()
    h.minecraft.refuseCommands(/^difficulty/)
    await change(turnedDown.owner, turnedDown.id, { difficulty: 'hard' })
    await h.settled(turnedDown.id)
    expect((await lastApply(turnedDown.id))?.status).toBe('succeeded')
    expect(await property(turnedDown.id, 'difficulty')).toBe('hard')
    const snapshots = (serverId: string) =>
      h.db.select().from(schema.backups).where(eq(schema.backups.serverId, serverId))
    // A restart for settings alone waits on no snapshot.
    expect(await snapshots(turnedDown.id)).toEqual([])
    h.minecraft.refuseCommands(null)
    // Before 1.21.9, PvP is a property the game reads only as it starts.
    const older = await running('Older', { gameVersion: '1.21.8' })
    await change(older.owner, older.id, { pvp: false })
    await h.settled(older.id)
    expect(await property(older.id, 'pvp')).toBe('false')
    expect(h.minecraft.playing(older.id).pvp).toBe(false)
    expect(await snapshots(older.id)).toEqual([])
    await h.app.servers.deleteServer(turnedDown.owner, turnedDown.id, 'Test server')
    await h.app.servers.deleteServer(older.owner, older.id, 'Older')
  })

  test('renaming a server moves a message still in Blockly’s words to the new name, at its next start', async () => {
    const { owner, id } = await running('Old name')
    const before = await h.server(id)
    await h.app.servers.saveIdentity(owner, id, { name: 'New name' })
    expect((await settingsOf(id)).motd).toBe('"New name", a server created by Cubepals')
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(revision).toMatchObject({
      reason: 'settings_changed',
      basedOnRevisionId: before.desiredRevisionId,
    })
    // Nothing restarts for it, drift included; the server list shows it from the next start.
    await h.app.schedules.drift()
    await h.settled(id)
    expect(await lastApply(id)).toBeUndefined()
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await property(id, 'motd')).toBe('"Old name", a server created by Cubepals')
    await h.app.servers.restart(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 3)
    await h.settled(id)
    expect(await property(id, 'motd')).toBe('"New name", a server created by Cubepals')
    // A message the owner wrote stays theirs.
    await change(owner, id, { motd: 'Our place' })
    await h.settled(id)
    await h.app.servers.saveIdentity(owner, id, { name: 'Third name' })
    expect((await settingsOf(id)).motd).toBe('Our place')
    await h.app.servers.deleteServer(owner, id, 'Third name')
  })

  test('the same settings again change nothing; settings out of bounds are refused', async () => {
    const { owner, id } = await running()
    await change(owner, id, {})
    expect(await listRevisions(h.db, id, 10)).toHaveLength(1)
    await expect(change(owner, id, { maxPlayers: 50 })).rejects.toThrow(/holds up to 5 players/)
    await expect(change(owner, id, { viewDistance: 99 })).rejects.toThrow(/View distance/)
    expect(await listRevisions(h.db, id, 10)).toHaveLength(1)
  })

  test("a change that won't boot goes back to the configuration before it, which runs again", async () => {
    const { owner, id } = await running()
    const before = await h.server(id)
    h.runtime.failBootWhen((spec) =>
      spec.env.SPAWN_PROTECTION === '4' ? 'the server refused to start' : null,
    )
    await change(owner, id, { spawnProtection: 4 })
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1)
    await h.settled(id)
    const apply = await lastApply(id)
    expect(apply?.status).toBe('failed')
    expect(apply?.error).toContain("didn't start")
    // Going back shows as one step: the boot it repeats is not the change being applied.
    expect(apply?.step).toBe('rolling_back')
    const after = await h.server(id)
    expect(after.desiredRevisionId).toBe(before.desiredRevisionId)
    expect((await loadRuntime(h.db, id, ['fake'])).applied?.revisionId).toBe(before.desiredRevisionId)
    expect(await property(id, 'spawn-protection')).toBe('0')
    // The failed attempt stays in the history; nothing points at it.
    expect((await listRevisions(h.db, id, 10)).map((r) => r.reason)).toEqual(['settings_changed', 'created'])
  })

  test('an upgrade that breaks after opening the world goes back with the world from before it', async () => {
    const { owner, id } = await running('Old Town', { gameVersion: '26.2' })
    const world = await h.db.select().from(schema.worlds).where(eq(schema.worlds.serverId, id))
    const levelDat = `${world[0]?.levelName}/level.dat`
    expect(await h.minecraft.file(id, levelDat)).toBe('opened by 26.2\n')
    h.minecraft.breakOn((env) => (env.VERSION === '26.3' ? 'this world needs a newer mod' : null))
    await h.app.mods.changeVersion(owner, id, { gameVersion: '26.3', loader: 'vanilla' }, [], randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > 3)
    await h.settled(id)
    expect((await lastApply(id))?.status).toBe('failed')
    // A new Minecraft rewrites the world, so it waited for a snapshot of the one before it.
    const [snapshot] = await h.db.select().from(schema.backups).where(eq(schema.backups.serverId, id))
    expect(snapshot).toMatchObject({ trigger: 'pre_apply', tier: 'snapshot', status: 'ready' })
    // The snapshot came back: the world never saw 26.3, and runs on 26.2 again.
    expect(await h.minecraft.file(id, levelDat)).toBe('opened by 26.2\nopened by 26.2\n')
    expect((await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).gameVersion).toBe('26.2')
    // The restored world runs on a new runtime, and the server keeps working on it.
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    expect(await h.minecraft.file(id, levelDat)).toBe('opened by 26.2\nopened by 26.2\nopened by 26.2\n')
  })

  test('going back to the snapshot keeps an in-game ban made during the failed upgrade', async () => {
    const { owner, id } = await running('Ban Town', { gameVersion: '26.2' })
    // The upgrade runs but its world never finishes loading. Meanwhile an operator bans someone in
    // game: the ban lands in files the snapshot is about to replace.
    h.minecraft.stallOn((env) => env.VERSION === '26.3')
    await h.app.mods.changeVersion(owner, id, { gameVersion: '26.3', loader: 'vanilla' }, [], randomUUID())
    const deadline = Date.now() + 10_000
    while (h.runtime.machine(id)?.spec.env.VERSION !== '26.3' || h.runtime.machine(id)?.state !== 'running') {
      if (Date.now() > deadline) throw new Error('The upgrade never started')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(await h.minecraft.inGame(id, 'ban Troll griefing')).toContain('Banned Troll')
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > 3, 20_000)
    await h.settled(id)
    expect((await lastApply(id))?.status).toBe('failed')
    expect((await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).gameVersion).toBe('26.2')
    // The world is the snapshot's; the ban is the players', kept first and put back on the files.
    expect(await h.minecraft.file(id, 'banned-players.json')).toContain('Troll')
    const bans = await h.db
      .select()
      .from(schema.serverAccessEntries)
      .where(and(eq(schema.serverAccessEntries.serverId, id), eq(schema.serverAccessEntries.list, 'ban')))
    expect(bans.map((b) => b.playerName)).toEqual(['Troll'])
  }, 40_000)

  test('when going back fails too the server is failed, and a manual rollback brings it up', async () => {
    const { owner, id } = await running()
    const first = (await h.server(id)).desiredRevisionId
    h.runtime.failBootWhen(() => 'the host is out of disk')
    await change(owner, id, { spawnProtection: 4 })
    const failed = await h.until(id, 'failed', 30_000)
    expect(failed.lifecycle.failure?.during).toBe('updating')
    expect(failed.lifecycle.failure?.message).toContain('going back to the previous one failed too')
    h.runtime.failBootWhen(() => null)
    // Trying the update again brings a failed server up: a start, refused while starts are paused.
    await h.db.update(schema.platformControls).set({ startsEnabled: false })
    try {
      const refused = await h.app.servers.retry(owner, id, randomUUID()).then(
        () => null,
        (error: { code?: string }) => error.code,
      )
      expect(refused).toBe('platform_paused')
    } finally {
      await h.db.update(schema.platformControls).set({ startsEnabled: true })
    }
    await h.app.revisions.rollback(owner, id, first, randomUUID())
    await h.until(id, 'running')
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(revision).toMatchObject({ reason: 'rollback', basedOnRevisionId: first })
    expect(await property(id, 'spawn-protection')).toBe('0')
  }, 40_000)

  test('versions only move forward, and only to what Blockly offers', async () => {
    const { owner, id } = await running()
    await expect(
      h.app.mods.changeVersion(owner, id, { gameVersion: '26.2', loader: 'vanilla' }, [], randomUUID()),
    ).rejects.toThrow(/older version/)
    await expect(
      h.app.mods.changeVersion(owner, id, { gameVersion: '26.3', loader: 'forge' }, [], randomUUID()),
    ).rejects.toThrow(/does not offer/)
  })

  test('resizing is entitlement-checked, splits the power interval, and fits max players', async () => {
    // Paid: the free plan has one size, so only a paid account has sizes to move between.
    const owner = await h.user('Steve', 'plus')
    const { id } = await h.create(owner, { name: 'Resized' })
    await h.until(id, 'running')
    await h.settled(id)
    await expect(h.app.revisions.resize(owner, id, '2g', randomUUID())).rejects.toThrow(
      /plan does not include/,
    )
    await h.app.revisions.resize(owner, id, '4g', randomUUID())
    await h.until(id, (s) => s.memoryTier === '4g' && s.lifecycle.status === 'running')
    await h.settled(id)
    expect(h.runtime.machine(id)?.spec.resources.memoryMb).toBe(4096)
    const intervals = await h.db
      .select()
      .from(schema.powerIntervals)
      .where(eq(schema.powerIntervals.serverId, id))
      .orderBy(asc(schema.powerIntervals.startedAt))
    expect(intervals.map((i) => [i.memoryTier, i.stoppedAt === null])).toEqual([
      ['3g', false],
      ['4g', true],
    ])
    await change(owner, id, { maxPlayers: 10 })
    await h.settled(id)
    await h.app.revisions.resize(owner, id, '3g', randomUUID())
    await h.until(id, (s) => s.memoryTier === '3g' && s.lifecycle.status === 'running')
    await h.settled(id)
    expect((await settingsOf(id)).maxPlayers).toBe(5)
  })

  test('renaming restarts nothing; a new address retires the old one for everyone else', async () => {
    const { owner, id } = await running('First Name')
    const server = await h.server(id)
    await h.app.servers.saveIdentity(owner, id, { name: 'Second Name' })
    expect((await h.server(id)).name).toBe('Second Name')
    await h.app.servers.changeAddress(owner, id, 'brand-new-address')
    expect(String((await h.server(id)).slug)).toBe('brand-new-address')
    const { routes } = await h.app.edge.routes()
    expect(routes.map((r) => r.hostname)).toContain('brand-new-address.play.test')
    expect(routes.map((r) => r.hostname)).not.toContain(`${server.slug}.play.test`)
    const other = await h.user()
    await expect(h.create(other, { name: 'Squatter', slug: server.slug })).rejects.toThrow(/taken/)
    await h.app.servers.changeAddress(owner, id, server.slug)
    expect((await h.server(id)).slug).toBe(server.slug)
    await h.settled(id)
    expect((await h.operations(id)).map((op) => op.kind)).toEqual(['provision'])
  })

  test('a running server whose spec drifted is updated, but not while someone is playing', async () => {
    const { id } = await running()
    await h.db
      .update(schema.serverRuntimes)
      .set({ applied: sql`jsonb_set(applied, '{driftDigest}', '"stale"')` })
      .where(eq(schema.serverRuntimes.serverId, id))
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
    await h.app.schedules.presenceSync()
    expect(await h.app.schedules.drift()).toBe(0)
    h.minecraft.leave(
      id,
      (await h.db.select().from(schema.serverPresence).where(eq(schema.serverPresence.serverId, id)))[0]
        ?.playerUuid ?? '',
    )
    await h.app.schedules.presenceSync()
    expect(await h.app.schedules.drift()).toBe(1)
    await h.settled(id)
    expect((await lastApply(id))?.status).toBe('succeeded')
    expect((await loadRuntime(h.db, id, ['fake'])).applied?.driftDigest).not.toBe('stale')
  })

  test('the audit log records every configuration change', async () => {
    const { owner, id } = await running()
    await change(owner, id, { difficulty: 'easy' })
    await h.settled(id)
    const entries = await h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'server.settings_changed')))
    expect(entries[0]?.data).toMatchObject({ changes: [{ field: 'difficulty', from: 'normal', to: 'easy' }] })
  })
})
