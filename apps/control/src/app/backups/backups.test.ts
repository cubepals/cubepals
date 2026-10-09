import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { access as exists, readFile, writeFile } from 'node:fs/promises'
import { schema } from '@blockly/db'
import { and, eq, isNull } from 'drizzle-orm'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision, loadRuntime } from '../servers/persistence.ts'
import { listBackups } from './persistence.ts'

// Backups, restores, worlds and moves, end to end (§9, §15.1, §15.5).
describe.skipIf(!hasDatabase)('backups and worlds', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterEach(() => {
    h.runtime.failBootWhen(() => null)
  })

  afterAll(async () => {
    await h.close()
  })

  const running = async (request: { gameVersion?: string } = {}) => {
    const owner = await h.user()
    const server = await h.create(owner, request)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }
  const backUp = async (owner: UserActor, id: string) => {
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [newest] = (await listBackups(h.db, id)).filter(
      (b) => b.trigger === 'manual' && b.status === 'ready',
    )
    if (newest === undefined) throw new Error('No backup was taken')
    return newest
  }
  const restore = async (owner: UserActor, id: string, backupId: string, withConfiguration = false) => {
    await h.app.backups.restoreBackup(owner, id, backupId, randomUUID(), { withConfiguration })
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
  }
  const lastOf = async (id: string, kind: string) =>
    (await h.operations(id)).filter((op) => op.kind === kind).at(-1)

  test('a restore rewinds the world, never who can join', async () => {
    const { owner, id } = await running()
    // The restore puts the world on new storage: the path is looked up each time.
    const marker = () => h.minecraft.path(id, 'world/built.txt')
    await writeFile(marker(), 'the castle before')
    const backup = await backUp(owner, id)
    expect(backup).toMatchObject({ trigger: 'manual', tier: 'snapshot', status: 'ready' })

    await writeFile(marker(), 'the castle, griefed')
    await h.app.access.add(owner, id, 'ban', 'Griefer', 'broke the castle')
    await h.settled(id)
    await restore(owner, id, backup.id)

    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await readFile(marker(), 'utf8')).toBe('the castle before')
    // The backup's ban list had no Griefer; the record did, and it was put back.
    expect(await h.minecraft.file(id, 'banned-players.json')).toContain('Griefer')
    const [record] = await h.db.select().from(schema.serverAccess).where(eq(schema.serverAccess.serverId, id))
    expect(record?.reseedRequired).toBe(false)
    const triggers = (await listBackups(h.db, id)).map((b) => b.trigger)
    expect(triggers).toContain('pre_restore')
  }, 30_000)

  test('a stopped server is booted while restoring, so access is back before anyone can join, and stopped again', async () => {
    const { owner, id } = await running()
    const backup = await backUp(owner, id)
    await h.app.access.add(owner, id, 'ban', 'Latecomer', 'not today')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await restore(owner, id, backup.id)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    expect(h.runtime.machine(id)?.state).toBe('stopped')
    // The record went back on the files during the restore, where no route reaches the server,
    // rather than at a later start, when it can be reached.
    const [record] = await h.db.select().from(schema.serverAccess).where(eq(schema.serverAccess.serverId, id))
    expect(record?.reseedRequired).toBe(false)
    expect(await h.minecraft.file(id, 'banned-players.json')).toContain('Latecomer')
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
  }, 30_000)

  test('a reseed that cannot be delivered stops the server: it never runs with access it cannot vouch for', async () => {
    const { owner, id } = await running()
    const backup = await backUp(owner, id)
    // A ban the server hasn't taken yet: neither the backup nor the files before the restore
    // have it, so either world can only come back with it by delivering it.
    h.minecraft.refuseCommands(/^ban /)
    try {
      await h.app.access.add(owner, id, 'ban', 'Vandal', 'broke things')
      await h.settled(id)
      // The server made the file empty as it started; the refused ban never reached it.
      expect(await h.minecraft.file(id, 'banned-players.json')).not.toContain('Vandal')
      await restore(owner, id, backup.id)
      const failed = await h.server(id)
      expect(failed.lifecycle).toMatchObject({ status: 'failed', failure: { during: 'restoring' } })
      expect(failed.lifecycle.failure?.message).toContain('Could not restore who can join')
      expect(h.runtime.machine(id)?.state).toBe('stopped')
      const [record] = await h.db
        .select()
        .from(schema.serverAccess)
        .where(eq(schema.serverAccess.serverId, id))
      expect(record?.reseedRequired).toBe(true)
    } finally {
      h.minecraft.refuseCommands(null)
    }
    // Once the ban can be delivered, a retry brings the server back with it.
    await h.app.servers.retry(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect(await h.minecraft.file(id, 'banned-players.json')).toContain('Vandal')
  }, 60_000)

  test('a backup that fails is recorded with its reason, and the server carries on (§9)', async () => {
    const { owner, id } = await running()
    h.runtime.failSnapshots('the volume is busy')
    try {
      await h.app.backups.createBackup(owner, id, randomUUID())
      const ops = await h.settled(id, 20_000)
      // What the provider said stays with the operation; its owner reads whose side it was on.
      expect(ops.at(-1)).toMatchObject({
        kind: 'backup',
        status: 'failed',
        detail: expect.stringContaining('the volume is busy'),
      })
    } finally {
      h.runtime.failSnapshots(null)
    }
    expect((await h.server(id)).lifecycle.status).toBe('running')
    const view = await h.app.backupQueries.list(owner, id)
    const [failed] = view.backups.filter((b) => b.status === 'failed')
    expect(failed).toMatchObject({
      tier: 'snapshot',
      trigger: 'manual',
      error: 'This one was on Cubepals’ side, not yours. Trying again usually works.',
    })
    // Dismissed, it's gone; the next one is made as usual.
    await h.app.backups.deleteBackup(owner, id, failed?.id ?? '')
    expect((await h.app.backupQueries.list(owner, id)).backups.filter((b) => b.status === 'failed')).toEqual(
      [],
    )
    const made = await backUp(owner, id)
    expect(made.status).toBe('ready')
  }, 60_000)

  test('backups and restores need good standing; a failed server restored is a start, counted as one', async () => {
    const { owner, id } = await running()
    const backup = await backUp(owner, id)
    const admin = { kind: 'admin' as const, userId: (await h.user('Admin')).userId }
    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: { code?: string }) => error.code ?? 'error',
      )

    await h.app.accounts.suspend(admin, owner.userId, 'testing backups')
    expect(await refusal(h.app.backups.createBackup(owner, id, randomUUID()))).toBe('account_suspended')
    expect(
      await refusal(
        h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false }),
      ),
    ).toBe('account_suspended')
    await h.app.accounts.reinstate(admin, owner.userId)
    await h.settled(id)
    if ((await h.server(id)).lifecycle.status !== 'running') {
      await h.app.servers.start(owner, id, randomUUID())
      await h.until(id, 'running')
    }

    // Failed while starting: its run is over, and bringing it back is a start.
    h.runtime.failBootWhen(() => 'the disk is full')
    await h.app.servers.restart(owner, id, randomUUID())
    await h.until(id, 'failed', 20_000)
    await h.settled(id, 20_000)
    h.runtime.failBootWhen(() => null)
    await h.app.schedules.usageClose()
    await h.db.update(schema.platformControls).set({ startsEnabled: false })
    try {
      expect(
        await refusal(
          h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false }),
        ),
      ).toBe('platform_paused')
    } finally {
      await h.db.update(schema.platformControls).set({ startsEnabled: true })
    }
    await restore(owner, id, backup.id)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    const [open] = await h.db
      .select()
      .from(schema.powerIntervals)
      .where(and(eq(schema.powerIntervals.serverId, id), isNull(schema.powerIntervals.stoppedAt)))
    expect(open).toBeDefined()
  }, 90_000)

  test('a boot from a failure the platform paused after accepting it restores the world, and stays off', async () => {
    const { owner, id } = await running()
    const backup = await backUp(owner, id)
    h.runtime.failBootWhen(() => 'the disk is full')
    await h.app.servers.restart(owner, id, randomUUID())
    await h.until(id, 'failed', 20_000)
    await h.settled(id, 20_000)
    h.runtime.failBootWhen(() => null)
    // Accepted as the service would, then starts are paused before the worker gets to it.
    await h.db.update(schema.platformControls).set({ startsEnabled: false })
    try {
      await h.db.transaction(async (tx) => {
        const server = await h.server(id)
        await h.app.transitions.command(
          tx,
          server,
          { type: 'restore' },
          {
            requestedBy: `user:${owner.userId}`,
            idempotencyKey: `restore:${randomUUID()}`,
            input: { backupId: backup.id, running: true, fromFailure: true },
          },
        )
      })
      await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
      const ops = await h.settled(id, 20_000)
      const server = await h.server(id)
      expect(server.lifecycle).toMatchObject({ status: 'stopped', stopReason: 'policy' })
      expect(ops.at(-1)).toMatchObject({
        kind: 'restore',
        status: 'failed',
        error: expect.stringContaining('stayed off'),
      })
      expect(h.runtime.machine(id)?.state).not.toBe('running')
    } finally {
      await h.db.update(schema.platformControls).set({ startsEnabled: true })
    }
  }, 90_000)

  test("a backup that won't start leaves the server as it was; retrying a failed restore uses the same backup", async () => {
    const { owner, id } = await running()
    const settingsOf = async () => (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings
    await h.app.revisions.changeSettings(
      owner,
      id,
      { ...(await settingsOf()), difficulty: 'peaceful' },
      randomUUID(),
    )
    await h.until(id, (s) => s.lifecycle.status === 'running')
    await h.settled(id)
    const peaceful = await backUp(owner, id)
    await h.app.revisions.changeSettings(
      owner,
      id,
      { ...(await settingsOf()), difficulty: 'hard' },
      randomUUID(),
    )
    await h.until(id, (s) => s.lifecycle.status === 'running')
    await h.settled(id)
    const before = (await h.server(id)).desiredRevisionId

    h.runtime.failBootWhen((spec) => (spec.env.DIFFICULTY === 'peaceful' ? 'the backup is broken' : null))
    await restore(owner, id, peaceful.id, true)
    const failed = await lastOf(id, 'restore')
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toContain('Your server is back as it was')
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect((await h.server(id)).desiredRevisionId).toBe(before)
    expect((await settingsOf()).difficulty).toBe('hard')

    // Going back fails too: the server is failed, and "Try again" restores the same backup.
    h.runtime.failBootWhen(() => 'the host is out of disk')
    await h.app.backups.restoreBackup(owner, id, peaceful.id, randomUUID(), { withConfiguration: true })
    const broken = await h.until(id, 'failed', 30_000)
    expect(broken.lifecycle.failure?.during).toBe('restoring')
    h.runtime.failBootWhen(() => null)
    await h.app.servers.retry(owner, id, randomUUID())
    await h.until(id, 'running', 20_000)
    await h.settled(id)
    expect((await settingsOf()).difficulty).toBe('peaceful')
  }, 60_000)

  test('a world from a newer game version comes back only with its configuration', async () => {
    const { owner, id } = await running({ gameVersion: '26.2' })
    const on262 = await backUp(owner, id)
    await h.app.mods.changeVersion(owner, id, { gameVersion: '26.3', loader: 'vanilla' }, [], randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running')
    await h.settled(id)
    const on263 = await backUp(owner, id)
    await restore(owner, id, on262.id, true)
    expect((await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).gameVersion).toBe('26.2')

    await expect(
      h.app.backups.restoreBackup(owner, id, on263.id, randomUUID(), { withConfiguration: false }),
    ).rejects.toThrow('ran on Minecraft 26.3')
    await restore(owner, id, on263.id, true)
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect([revision.gameVersion, revision.reason]).toEqual(['26.3', 'restore'])
  }, 60_000)

  test('bringing back a configuration with a mod taken down since needs the owner to say so', async () => {
    const cdn = new Cdn()
    await cdn.start()
    try {
      const owner = await h.user('Steve', 'plus')
      const created = await h.create(owner, { loader: 'fabric' })
      const id = created.id
      await h.until(id, 'running')
      await h.settled(id)
      const mod = cdn.publish('borrowed-mod')
      await h.app.revisions.changeMods(
        owner,
        id,
        { basedOn: (await h.server(id)).desiredRevisionId, mods: [mod] },
        randomUUID(),
      )
      await h.until(id, (s) => s.lifecycle.status === 'running')
      await h.settled(id)
      const withMod = await backUp(owner, id)
      await h.app.revisions.changeMods(
        owner,
        id,
        { basedOn: (await h.server(id)).desiredRevisionId, mods: [] },
        randomUUID(),
      )
      await h.until(id, (s) => s.lifecycle.status === 'running')
      await h.settled(id)
      await h.db.insert(schema.catalogProjects).values({
        catalog: 'modrinth',
        projectId: 'borrowed-mod-project',
        state: 'withheld',
        fetchedAt: new Date(),
        stateChangedAt: new Date(),
      })

      await expect(
        h.app.backups.restoreBackup(owner, id, withMod.id, randomUUID(), { withConfiguration: true }),
      ).rejects.toThrow('borrowed-mod was taken down')
      await h.app.backups.restoreBackup(owner, id, withMod.id, randomUUID(), {
        withConfiguration: true,
        acknowledgeRevoked: true,
      })
      await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
      await h.settled(id, 20_000)
      const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
      expect([revision.reason, revision.acknowledgedRevoked]).toEqual(['restore', [mod.artifact.sha512]])
      expect((await lastOf(id, 'restore'))?.status).toBe('succeeded')
    } finally {
      cdn.close()
    }
  }, 60_000)

  test('backups beyond what the plan keeps are deleted, snapshots and all', async () => {
    const { owner, id } = await running()
    const taken = []
    for (let i = 0; i < 4; i++) taken.push(await backUp(owner, id))
    const ready = (await listBackups(h.db, id)).filter((b) => b.trigger === 'manual' && b.status === 'ready')
    expect(ready.map((b) => b.id)).toEqual(
      taken
        .slice(1)
        .reverse()
        .map((b) => b.id),
    )
    const [oldest, ...kept] = taken.map((b) => b.snapshotHandle).filter((s) => s !== null)
    const gone = await h.runtime.goneSnapshots(
      taken.flatMap((b) => (b.snapshotHandle ? [b.snapshotHandle] : [])),
    )
    expect(oldest !== undefined && gone.has(oldest)).toBe(true)
    for (const snapshot of kept) expect(gone.has(snapshot)).toBe(false)
  }, 40_000)

  test('a new world, a switch back, and the old one deleted: its directories go while the server runs', async () => {
    const { owner, id } = await running()
    const first = (await h.server(id)).activeWorldId
    await h.app.worlds.createWorld(
      owner,
      id,
      { name: 'Skyblock', levelType: 'minecraft:flat', hardcore: false },
      randomUUID(),
    )
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.activeWorldId !== first)
    await h.settled(id)
    const worlds = await h.app.worldQueries.list(owner, id)
    expect(worlds.map((w) => [w.name, w.active, w.running])).toEqual([
      ['World', false, false],
      ['Skyblock', true, true],
    ])
    expect(h.runtime.machine(id)?.spec.env).toMatchObject({ LEVEL: 'world-2', LEVEL_TYPE: 'minecraft:flat' })
    await expect(h.app.worlds.deleteWorld(owner, id, worlds[1]?.id ?? '')).rejects.toThrow(
      'Switch to another world',
    )

    await h.app.worlds.switchWorld(owner, id, first, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.activeWorldId === first)
    await h.settled(id)
    await h.app.worlds.deleteWorld(owner, id, worlds[1]?.id ?? '')
    await h.settled(id)
    expect((await lastOf(id, 'prune_worlds'))?.status).toBe('succeeded')
    await expect(exists(h.minecraft.path(id, 'world-2'))).rejects.toThrow()
    await expect(exists(h.minecraft.path(id, 'world'))).resolves.toBeNull()
    expect((await h.app.worldQueries.list(owner, id)).map((w) => w.name)).toEqual(['World'])
  }, 40_000)

  test('a server moves to another region with a snapshot first, and comes back up there', async () => {
    const { owner, id } = await running()
    await h.app.servers.relocate(owner, id, 'far', randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.regionKey === 'far', 20_000)
    await h.settled(id)
    expect(h.runtime.machine(id)?.region).toBe('fake-2')
    const binding = await loadRuntime(h.db, id, ['fake'])
    expect([binding.placementRegionKey, binding.applied?.regionKey]).toEqual(['far', 'far'])
    expect((await listBackups(h.db, id)).map((b) => b.trigger)).toContain('pre_relocate')
    await expect(h.app.servers.relocate(owner, id, 'moon', randomUUID())).rejects.toThrow('not available')
  }, 30_000)

  test('without an archive store, archives are refused and kept for when it returns (§15.4)', async () => {
    const { owner, id } = await running()
    const snapshot = await backUp(owner, id)
    const refused = await h.app.backups.archiveBackup(owner, id, snapshot.id, randomUUID()).catch((e) => e)
    expect(refused).toMatchObject({ code: 'deployment_unsupported' })

    // An archive from when the deployment had a store: listed, but nothing can be done with it.
    const archiveId = randomUUID()
    await h.db.insert(schema.backups).values({
      id: archiveId,
      serverId: id,
      worldId: snapshot.worldId,
      revisionId: snapshot.revisionId,
      tier: 'archive',
      trigger: 'manual',
      status: 'ready',
      archiveKey: `archives/${id}/${archiveId}.tar.gz`,
      sizeBytes: 1024,
    })
    const view = await h.app.backupQueries.list(owner, id)
    expect(view.backups.find((b) => b.id === archiveId)?.tier).toBe('archive')
    expect(view.archives.create).toMatchObject({ available: false, code: 'deployment_unsupported' })
    expect(view.archives.restore).toMatchObject({ available: false, code: 'deployment_unsupported' })
    // One at a time: a refusal nobody is waiting for yet would go unhandled.
    for (const attempt of [
      () => h.app.backups.downloads.ask(owner, id, archiveId),
      () => h.app.backups.restoreBackup(owner, id, archiveId, randomUUID(), { withConfiguration: false }),
    ])
      expect(await attempt().catch((e) => e)).toMatchObject({ code: 'deployment_unsupported' })

    // Deleting it hides it now; the store forgets it once there is a store to ask.
    await h.app.backups.deleteBackup(owner, id, archiveId)
    const [row] = await h.db.select().from(schema.backups).where(eq(schema.backups.id, archiveId))
    expect(row).toMatchObject({ status: 'deleted', archiveKey: `archives/${id}/${archiveId}.tar.gz` })
    expect(await h.app.backups.eraseArchives()).toBe(0)
  }, 30_000)

  test('the schedule backs up servers played on, once a day; expired snapshots stop being offered', async () => {
    const { id } = await running()
    const uuid = randomUUID()
    h.minecraft.join(id, { uuid, name: 'Alex' })
    await h.app.schedules.presenceSync()
    h.minecraft.leave(id, uuid)
    await h.app.schedules.presenceSync()
    expect(await h.app.schedules.backups()).toBeGreaterThanOrEqual(1)
    await h.settled(id)
    const scheduled = (await listBackups(h.db, id)).filter((b) => b.trigger === 'scheduled')
    expect(scheduled).toHaveLength(1)
    await h.app.schedules.backups()
    await h.settled(id)
    expect((await listBackups(h.db, id)).filter((b) => b.trigger === 'scheduled')).toHaveLength(1)

    await h.db
      .update(schema.backups)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(schema.backups.serverId, id), eq(schema.backups.trigger, 'scheduled')))
    await h.app.schedules.backups()
    expect((await listBackups(h.db, id)).find((b) => b.trigger === 'scheduled')?.status).toBe('expired')
  }, 30_000)

  test('a snapshot the provider no longer has stops being offered at the next sweep', async () => {
    const { owner, id } = await running()
    const backup = await backUp(owner, id)
    expect(backup.snapshotHandle).toBeTruthy()
    // The provider lost it (its own retention, or someone deleted it by hand).
    await h.runtime.deleteSnapshot(backup.snapshotHandle as NonNullable<typeof backup.snapshotHandle>)
    expect((await listBackups(h.db, id)).find((b) => b.id === backup.id)?.status).toBe('ready')
    await h.app.schedules.backups()
    expect((await listBackups(h.db, id)).find((b) => b.id === backup.id)?.status).toBe('expired')
  }, 30_000)
})
