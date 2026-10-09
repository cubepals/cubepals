import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { downloaded } from '../../testing/downloads.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { AppError } from '../errors.ts'
import { listBackups, loadBackup } from './persistence.ts'

const run = promisify(execFile)

// Archives: a snapshot's world packed into the store, downloaded, restored, kept for the plan's
// retention and then deleted (§8, §9, §15.4, §15.5). The store is a real S3 server.
const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

describe.skipIf(!hasDatabase || !s3.endpoint || !s3.bucket)('archives', () => {
  let h: Harness
  const store = new S3ArchiveStore({
    endpoint: s3.endpoint ?? '',
    bucket: s3.bucket ?? '',
    region: 'auto',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  })
  const written: string[] = []

  beforeAll(async () => {
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterEach(() => {
    h.runtime.failExports(null)
    h.runtime.limitPuts(null)
  })

  afterAll(async () => {
    await h.close()
    for (const key of written) await store.delete(key)
  })

  /** A running server whose owner's plan keeps archives. */
  const running = async (plan = 'plus') => {
    const owner = await h.user()
    await h.db
      .update(schema.accountStanding)
      .set({ plan })
      .where(eq(schema.accountStanding.userId, owner.userId))
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }
  const snapshotOf = async (owner: UserActor, id: string) => {
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [newest] = (await listBackups(h.db, id)).filter(
      (b) => b.trigger === 'manual' && b.tier === 'snapshot',
    )
    if (newest === undefined) throw new Error('No backup was taken')
    return newest
  }
  const archiveOf = async (owner: UserActor, id: string, snapshotId: string) => {
    await h.app.backups.archiveBackup(owner, id, snapshotId, randomUUID())
    await h.settled(id)
    const [archive] = (await listBackups(h.db, id)).filter((b) => b.tier === 'archive')
    if (archive === undefined) throw new Error('No archive was recorded')
    if (archive.archiveKey) written.push(archive.archiveKey)
    return archive
  }

  test('an archive is made from a snapshot, downloads as a tarball of the world, and restores', async () => {
    const { owner, id } = await running()
    const marker = () => h.minecraft.path(id, 'world/built.txt')
    await writeFile(marker(), 'the castle before')
    const snapshot = await snapshotOf(owner, id)

    const archive = await archiveOf(owner, id, snapshot.id)
    expect(archive).toMatchObject({
      tier: 'archive',
      trigger: 'manual',
      status: 'ready',
      worldId: snapshot.worldId,
      revisionId: snapshot.revisionId,
    })
    // What the store holds is what the backup says, and it's kept for the plan's 30 days.
    expect((await store.head(archive.archiveKey ?? ''))?.sizeBytes).toBe(archive.sizeBytes ?? -1)
    const days = ((archive.expiresAt?.getTime() ?? 0) - archive.createdAt.getTime()) / 86_400_000
    expect(Math.round(days)).toBe(30)
    // Making an archive is background work: the server never left running.
    expect((await h.server(id)).lifecycle.status).toBe('running')

    // The download is the world as it was, under a name for the server and the time. A small
    // world's is ready by the time the ask answers.
    const state = await h.app.backups.downloads.ask(owner, id, archive.id)
    const response = await fetch(state.status === 'ready' ? state.url : `not ready: ${state.status}`)
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="?test-server-[-\d]+\.tar\.gz"?$/,
    )
    const scratch = await mkdtemp(join(tmpdir(), 'blockly-download-'))
    try {
      const bytes = Buffer.from(await response.arrayBuffer())
      await writeFile(join(scratch, 'world.tar.gz'), bytes)
      await run('tar', ['-xzf', join(scratch, 'world.tar.gz'), '-C', scratch])
      expect(await readFile(join(scratch, 'world', 'built.txt'), 'utf8')).toBe('the castle before')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }

    // Restoring it brings that world back, with a snapshot of the one it replaces. The runtime is
    // handed the archive's sha256, to check what it downloads against.
    await writeFile(marker(), 'the castle, griefed')
    const restore = spyOn(h.runtime, 'restore')
    try {
      await h.app.backups.restoreBackup(owner, id, archive.id, randomUUID(), { withConfiguration: false })
      await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
      await h.settled(id, 20_000)
      expect(restore.mock.calls[0]?.[1]).toMatchObject({ kind: 'archive', sha256: archive.sha256 })
    } finally {
      restore.mockRestore()
    }
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await readFile(marker(), 'utf8')).toBe('the castle before')
    expect((await listBackups(h.db, id)).map((b) => b.trigger)).toContain('pre_restore')

    const view = await h.app.backupQueries.list(owner, id)
    expect(view.archives).toEqual({ create: { available: true }, restore: { available: true } })
    expect(view.backups.find((b) => b.id === archive.id)).toMatchObject({ tier: 'archive', status: 'ready' })
  }, 40_000)

  test('an archive larger than one PUT carries goes to the store in parts, and downloads whole', async () => {
    const { owner, id } = await running()
    // 9 MiB that doesn't compress, from a runtime that puts no more than 1 MiB in one PUT: two
    // parts of 8 MiB, the least the plan makes, the second short.
    const region = randomBytes(9 * 1024 ** 2)
    await writeFile(h.minecraft.path(id, 'world/region.mca'), region)
    h.runtime.limitPuts(1024 ** 2)
    const snapshot = await snapshotOf(owner, id)
    const archive = await archiveOf(owner, id, snapshot.id)
    expect(archive.status).toBe('ready')
    expect((await store.head(archive.archiveKey ?? ''))?.sizeBytes).toBe(archive.sizeBytes ?? -1)
    expect(archive.sizeBytes ?? 0).toBeGreaterThan(9 * 1024 ** 2)
    // Whole as a restore reads it; what its owner downloads is made from it (downloads.test.ts).
    const { url } = await store.presignGet(archive.archiveKey ?? '', 60, 'runtime')
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer())
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(archive.sha256 ?? '')
    const scratch = await mkdtemp(join(tmpdir(), 'blockly-download-'))
    try {
      await writeFile(join(scratch, 'world.tar.gz'), bytes)
      await run('tar', ['-xzf', join(scratch, 'world.tar.gz'), '-C', scratch])
      expect((await readFile(join(scratch, 'world', 'region.mca'))).equals(region)).toBe(true)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }, 40_000)

  test('every plan downloads its world: Free makes one a day, kept a week', async () => {
    const { owner, id } = await running('free')
    const snapshot = await snapshotOf(owner, id)
    const archive = await archiveOf(owner, id, snapshot.id)
    expect(archive).toMatchObject({ tier: 'archive', trigger: 'manual', status: 'ready' })
    const days = ((archive.expiresAt?.getTime() ?? 0) - archive.createdAt.getTime()) / 86_400_000
    expect(Math.round(days)).toBe(7)
    expect((await downloaded(h.app, owner, id, archive.id)).byteLength).toBeGreaterThan(0)
    // A second the same day is refused, pointing at the one already made.
    const again = await h.app.backups.archiveBackup(owner, id, snapshot.id, randomUUID()).catch((e) => e)
    expect(again).toBeInstanceOf(AppError)
    expect((again as AppError).code).toBe('rate_limited')
    const view = await h.app.backupQueries.list(owner, id)
    expect(view.archives.create).toEqual({ available: true })
    expect(view.archives.restore).toEqual({ available: true })
  }, 30_000)

  test('an export that fails leaves a failed archive, which is cleared from the store', async () => {
    const { owner, id } = await running()
    const snapshot = await snapshotOf(owner, id)
    h.runtime.failExports('the archiver ran out of disk')
    await h.app.backups.archiveBackup(owner, id, snapshot.id, randomUUID())
    await h.settled(id, 30_000)
    const [archive] = (await listBackups(h.db, id)).filter((b) => b.tier === 'archive')
    expect(archive?.status).toBe('failed')
    const op = (await h.operations(id)).find((o) => o.kind === 'archive')
    // Its owner reads whose side it was on; what the provider said stays with the operation.
    expect(op).toMatchObject({
      status: 'failed',
      error: 'This one was on Cubepals’ side, not yours. Trying again usually works.',
      detail: 'the archiver ran out of disk',
    })
    expect(archive?.error).toBe('This one was on Cubepals’ side, not yours. Trying again usually works.')
    expect((await h.server(id)).lifecycle.status).toBe('running')

    // Shown for a while so its owner knows; the store keeps nothing of it.
    const view = await h.app.backupQueries.list(owner, id)
    expect(view.backups.find((b) => b.id === archive?.id)?.status).toBe('failed')
    await h.app.schedules.backups()
    expect((await loadBackup(h.db, archive?.id ?? ''))?.archiveKey).toBeNull()
  }, 40_000)

  test('an archive past its retention, or deleted, leaves the store', async () => {
    const { owner, id } = await running()
    const snapshot = await snapshotOf(owner, id)
    const expiring = await archiveOf(owner, id, snapshot.id)
    const deleted = await archiveOf(owner, id, snapshot.id).then(async () => {
      const [newest] = (await listBackups(h.db, id)).filter(
        (b) => b.tier === 'archive' && b.id !== expiring.id,
      )
      if (newest?.archiveKey) written.push(newest.archiveKey)
      return newest
    })
    if (deleted === undefined) throw new Error('No second archive')

    await h.db
      .update(schema.backups)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.backups.id, expiring.id))
    await h.app.schedules.backups()
    const expired = await loadBackup(h.db, expiring.id)
    expect(expired).toMatchObject({ status: 'expired', archiveKey: null })
    expect(await store.head(expiring.archiveKey ?? '')).toBeNull()

    await h.app.backups.deleteBackup(owner, id, deleted.id)
    expect(await loadBackup(h.db, deleted.id)).toMatchObject({ status: 'deleted', archiveKey: null })
    expect(await store.head(deleted.archiveKey ?? '')).toBeNull()
  }, 40_000)

  test('archives outlive a purged server, until their retention ends', async () => {
    const { owner, id } = await running()
    const snapshot = await snapshotOf(owner, id)
    const archive = await archiveOf(owner, id, snapshot.id)
    await h.app.servers.deleteServer(owner, id, 'Test server')
    await h.until(id, 'deleted')
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ purgeAfter: new Date(Date.now() - 1000) })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.schedules.purgeSweep()
    await h.until(id, 'purged')
    await h.settled(id)

    // The provider's snapshots went with the server; the archive is still whole.
    expect((await loadBackup(h.db, snapshot.id))?.status).toBe('deleted')
    expect(await loadBackup(h.db, archive.id)).toMatchObject({
      status: 'ready',
      archiveKey: archive.archiveKey,
    })
    expect((await store.head(archive.archiveKey ?? ''))?.sizeBytes).toBe(archive.sizeBytes ?? -1)
    // Its owner still finds it: gone from the servers and the trash, listed with its downloads.
    expect(await h.app.queries.purgedArchives(owner)).toEqual([
      { id, name: 'Test server', archives: 1, keptUntil: archive.expiresAt?.toISOString() ?? null },
    ])
    const [shown] = (await h.app.backupQueries.list(owner, id)).backups
    expect(shown).toMatchObject({ id: archive.id, tier: 'archive', status: 'ready' })

    await h.db
      .update(schema.backups)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.backups.id, archive.id))
    await h.app.schedules.backups()
    expect(await loadBackup(h.db, archive.id)).toMatchObject({ status: 'expired', archiveKey: null })
    expect(await store.head(archive.archiveKey ?? '')).toBeNull()
    expect(await h.app.queries.purgedArchives(owner)).toEqual([])
  }, 40_000)

  test('the schedule archives a played server weekly, for plans that keep archives', async () => {
    const { id } = await running()
    const free = await running('free')
    for (const server of [id, free.id]) {
      const uuid = randomUUID()
      h.minecraft.join(server, { uuid, name: 'Alex' })
      await h.app.schedules.presenceSync()
      h.minecraft.leave(server, uuid)
      await h.app.schedules.presenceSync()
    }
    const now = new Date()
    // The first run takes the daily snapshots; the next one archives the entitled server's.
    await h.app.schedules.backups(now)
    await h.settled(id)
    await h.settled(free.id)
    await h.app.schedules.backups(new Date(now.getTime() + 60_000))
    await h.settled(id)
    await h.settled(free.id)
    const archives = (await listBackups(h.db, id)).filter((b) => b.tier === 'archive')
    expect(archives.map((a) => [a.trigger, a.status])).toEqual([['scheduled', 'ready']])
    for (const a of archives) if (a.archiveKey) written.push(a.archiveKey)
    expect((await listBackups(h.db, free.id)).filter((b) => b.tier === 'archive')).toEqual([])

    // Within the week, nothing more.
    await h.app.schedules.backups(new Date(now.getTime() + 2 * 86_400_000))
    await h.settled(id)
    expect((await listBackups(h.db, id)).filter((b) => b.tier === 'archive')).toHaveLength(1)
  }, 60_000)

  test('a server another provider holds is never archived here, and its backups only stop being offered', async () => {
    const { owner, id } = await running()
    const uuid = randomUUID()
    h.minecraft.join(id, { uuid, name: 'Alex' })
    await h.app.schedules.presenceSync()
    h.minecraft.leave(id, uuid)
    await h.app.schedules.presenceSync()
    const now = new Date()
    await h.app.schedules.backups(now)
    await h.settled(id)
    const daily = (await listBackups(h.db, id)).find(
      (b) => b.trigger === 'scheduled' && b.tier === 'snapshot',
    )
    if (daily?.snapshotHandle == null) throw new Error('No daily snapshot was taken')
    // As when a control plane points at data another provider's deployment made.
    const bind = (provider: string) =>
      h.db.update(schema.serverRuntimes).set({ provider }).where(eq(schema.serverRuntimes.serverId, id))
    await bind('docker')
    try {
      await h.app.schedules.backups(new Date(now.getTime() + 60_000))
      await h.settled(id)
      expect((await listBackups(h.db, id)).filter((b) => b.tier === 'archive')).toEqual([])
      await h.app.backups.deleteBackup(owner, id, daily.id)
      expect((await loadBackup(h.db, daily.id))?.status).toBe('deleted')
      // Still where the provider that took it keeps it: nothing here could delete it.
      expect(await h.runtime.goneSnapshots([daily.snapshotHandle])).toEqual(new Set())
    } finally {
      await bind('fake')
    }
  }, 60_000)
})
