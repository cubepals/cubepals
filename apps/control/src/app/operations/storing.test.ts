import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { countServers } from '../accounts/persistence.ts'
import type { UserActor } from '../actor.ts'
import { listBackups, storedCopy } from '../backups/persistence.ts'
import { loadRuntime } from '../servers/persistence.ts'
import { openRun } from '../servers/usage.ts'

const DAY = 86_400_000

// Worlds nobody plays rest in the archive store, and their servers let go of compute and storage
//. Losing a world is the one thing this must never do, so most of these are
// about what happens when something fails, or happens at the same time, at every step. The store
// is a real S3 server; the provider is the fake, whose storage is real directories.
const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

describe.skipIf(!hasDatabase || !s3.endpoint || !s3.bucket)('stored worlds', () => {
  let h: Harness
  const store = new S3ArchiveStore({
    endpoint: s3.endpoint ?? '',
    bucket: s3.bucket ?? '',
    region: 'auto',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  })

  beforeAll(async () => {
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterEach(() => {
    h.runtime.failExports(null)
    h.runtime.failReleases(null)
    h.runtime.failRestores(null)
    h.runtime.failBootWhen(() => null)
  })

  afterAll(async () => {
    // What these tests put in the store goes with them.
    const keys = await h.db
      .select({ key: schema.backups.archiveKey })
      .from(schema.backups)
      .where(sql`${schema.backups.archiveKey} is not null`)
    for (const { key } of keys) if (key) await store.delete(key)
    await h.close()
  })

  /** A server someone built on, then left: stopped, with a file only its world holds. */
  const asleep = async (plan = 'free', name = 'Steve') => {
    const owner = await h.user(name, plan)
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await writeFile(h.minecraft.path(server.id, 'world/built.txt'), `${name}'s castle`)
    await h.app.servers.stop(owner, server.id, randomUUID())
    await h.until(server.id, 'stopped')
    await h.settled(server.id)
    return { owner, id: server.id }
  }
  /** As if nobody had played on it for `days`. */
  const idleFor = (id: string, days: number) =>
    h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - days * DAY) })
      .where(eq(schema.minecraftServers.id, id))
  const castle = (id: string) => readFile(h.minecraft.path(id, 'world/built.txt'), 'utf8')
  const rest = async (id: string, now?: Date) => {
    await h.app.schedules.storeSweep(now)
    await h.settled(id, 20_000)
    return h.server(id)
  }
  const copiesOf = async (id: string) =>
    (await listBackups(h.db, id)).filter((b) => b.tier === 'archive' && b.trigger === 'stored')
  const wake = async (owner: UserActor, id: string) => {
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    return h.server(id)
  }

  test('a world nobody plays rests, lets go of its machine and disk, and comes back whole', async () => {
    const { owner, id } = await asleep()
    await idleFor(id, 15)
    const rested = await rest(id)
    expect(rested.lifecycle.status).toBe('stored')
    expect(rested.storedAt).not.toBeNull()
    // Nothing that bills is left: no compute, no storage.
    expect(h.runtime.machine(id)).toMatchObject({ compute: false, released: true })
    // The world is in the store, read back whole, and kept with no end while it rests.
    const copy = await storedCopy(h.db, id)
    expect(copy).toMatchObject({ status: 'ready', expiresAt: null })
    expect((await store.head(copy?.archiveKey ?? ''))?.sizeBytes).toBe(copy?.sizeBytes ?? -1)
    // Its snapshots went with its disk, and say so.
    const snapshots = (await listBackups(h.db, id)).filter((b) => b.tier === 'snapshot')
    expect(snapshots.every((b) => b.status !== 'ready')).toBe(true)
    // Resting holds no compute, so it doesn't count against what the provider can hold; the
    // owner's own count still has it, against their plan's servers.
    const everyone = await countServers(h.db)
    expect(await countServers(h.db, owner.userId)).toEqual({ servers: 1, running: 0 })
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'stopped' })
      .where(eq(schema.minecraftServers.id, id))
    expect((await countServers(h.db)).servers).toBe(everyone.servers + 1)
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'stored' })
      .where(eq(schema.minecraftServers.id, id))

    // Waking brings the same world back: what was built is there.
    const woke = await wake(owner, id)
    expect(woke.lifecycle.status).toBe('running')
    expect(woke.storedAt).toBeNull()
    expect(await castle(id)).toBe("Steve's castle")
    expect(h.runtime.machine(id)).toMatchObject({ compute: true, released: false, state: 'running' })
    // The copy it rested in is an ordinary download for a week, then goes.
    const kept = await storedCopy(h.db, id)
    const days = ((kept?.expiresAt?.getTime() ?? 0) - Date.now()) / DAY
    expect(Math.round(days)).toBe(7)
  }, 60_000)

  test('the copy a world rests in keeps its sha256, and a wake hands it on to be checked', async () => {
    const { owner, id } = await asleep('free', 'Hazel')
    await idleFor(id, 15)
    expect((await rest(id)).lifecycle.status).toBe('stored')
    const copy = await storedCopy(h.db, id)
    // What the store holds hashes to what the runtime said it wrote.
    const download = await store.presignGet(copy?.archiveKey ?? '', 600, 'runtime')
    const bytes = Buffer.from(await (await fetch(download.url)).arrayBuffer())
    expect(copy?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    // A runtime that can check what it downloads is given the hash to check it against.
    const restore = spyOn(h.runtime, 'restore')
    try {
      expect((await wake(owner, id)).lifecycle.status).toBe('running')
      expect(restore.mock.calls[0]?.[1]).toMatchObject({ kind: 'archive', sha256: copy?.sha256 })
    } finally {
      restore.mockRestore()
    }
    expect(await castle(id)).toBe("Hazel's castle")
  }, 60_000)

  test('free rests after two weeks, Plus after a month', async () => {
    const free = await asleep('free', 'Fiona')
    const plus = await asleep('plus', 'Paul')
    await idleFor(free.id, 13)
    await idleFor(plus.id, 15)
    expect((await rest(free.id)).lifecycle.status).toBe('stopped')
    expect((await rest(plus.id)).lifecycle.status).toBe('stopped')
    await idleFor(free.id, 15)
    expect((await rest(free.id)).lifecycle.status).toBe('stored')
    expect((await rest(plus.id)).lifecycle.status).toBe('stopped')
    await idleFor(plus.id, 31)
    expect((await rest(plus.id)).lifecycle.status).toBe('stored')
  }, 90_000)

  test('a friend joining wakes a resting world, and a second join waits for the same wake', async () => {
    const { id } = await asleep('free', 'Wren')
    await idleFor(id, 15)
    expect((await rest(id)).lifecycle.status).toBe('stored')
    const { slug, inviteCode } = await h.server(id)
    // The address still resolves while it rests: a join is what wakes it.
    expect((await h.app.edge.routes()).routes.map((r) => r.hostname)).toContain(`${slug}.play.test`)
    // Friends are told it's asleep like any other, and that this wake takes a little longer.
    expect(await h.app.sharingQueries.invite(inviteCode)).toMatchObject({ awake: false, wakesSlowly: true })
    const [first, second] = await Promise.all([
      h.app.edge.wake(`${slug}.play.test`),
      h.app.edge.wake(`${slug}.play.test`),
    ])
    expect([first.outcome, second.outcome].every((o) => o === 'ready' || o === 'starting')).toBe(true)
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    expect(await castle(id)).toBe("Wren's castle")
    // One wake, not two.
    const wakes = (await h.operations(id)).filter((op) => op.kind === 'unstore')
    expect(wakes).toHaveLength(1)
    // A join is a wake on probation, as any is.
    expect((await openRun(h.db, id))?.woken).toBe(true)
  }, 60_000)

  test('a friend joining while the world is being put to rest waits for it, then wakes it', async () => {
    const { id } = await asleep('free', 'Late')
    await idleFor(id, 15)
    const letGo = h.runtime.holdReleases(1)
    await h.app.schedules.storeSweep()
    await h.until(id, 'storing', 20_000)
    const { slug } = await h.server(id)
    // The join arrives mid-rest: it isn't turned away, and it doesn't cut the rest short.
    const joining = h.app.edge.wake(`${slug}.play.test`)
    letGo()
    expect(['ready', 'starting']).toContain((await joining).outcome)
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    expect(await castle(id)).toBe("Late's castle")
    const kinds = (await h.operations(id)).map((op) => `${op.kind}:${op.status}`)
    expect(kinds).toContain('store:succeeded')
    expect(kinds).toContain('unstore:succeeded')
  }, 60_000)

  test('a wake nobody joined rests again without making a second copy', async () => {
    const { id } = await asleep('free', 'Knock')
    await idleFor(id, 15)
    await rest(id)
    const { slug } = await h.server(id)
    await h.app.edge.wake(`${slug}.play.test`)
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    // Nobody joined: probation stops it, and nothing marks it played. (Ten minutes on, past the
    // grace a freshly started control plane gives presence.)
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(Date.now() - 6 * 60_000) })
      .where(and(eq(schema.powerIntervals.serverId, id), sql`${schema.powerIntervals.stoppedAt} is null`))
    expect(await h.app.schedules.evaluateIdle(await h.server(id), new Date(Date.now() + 10 * 60_000))).toBe(
      'nobody_joined',
    )
    await h.until(id, 'stopped')
    await h.settled(id)
    // Still idle for as long as before: it rests again, from the copy it already had.
    expect((await rest(id)).lifecycle.status).toBe('stored')
    expect(await copiesOf(id)).toHaveLength(1)
  }, 60_000)

  test('a copy that fails lets go of nothing, and a sweep a day later tries again', async () => {
    const { owner, id } = await asleep('free', 'Ferris')
    await idleFor(id, 15)
    h.runtime.failExports('the store is down')
    const after = await rest(id)
    expect(after.lifecycle.status).toBe('stopped')
    expect(h.runtime.machine(id)).toMatchObject({ released: false })
    expect(await castle(id)).toBe("Ferris's castle")
    // The attempt is recorded as the failure it was, and nothing half-made is offered.
    expect((await copiesOf(id)).every((b) => b.status === 'failed')).toBe(true)
    expect(await storedCopy(h.db, id)).toBeNull()

    h.runtime.failExports(null)
    // Not within the hour: every try snapshots and packs the whole world.
    await rest(id)
    expect((await h.operations(id)).filter((op) => op.kind === 'store')).toHaveLength(1)
    expect((await rest(id, new Date(Date.now() + DAY))).lifecycle.status).toBe('stored')
    expect((await wake(owner, id)).lifecycle.status).toBe('running')
    expect(await castle(id)).toBe("Ferris's castle")
  }, 60_000)

  test('a world too big to pack is tried once, not again and again', async () => {
    const { id } = await asleep('free', 'Atlas')
    await idleFor(id, 15)
    h.runtime.failExports('its archive is 6.0 GB, and one upload carries at most 5.0 GB', {
      unsupported: true,
    })
    const exports = spyOn(h.runtime, 'exportSnapshot')
    try {
      expect((await rest(id)).lifecycle.status).toBe('stopped')
      // Packed once: a retry would pack it whole again, and be refused the same way.
      expect(exports).toHaveBeenCalledTimes(1)
      const [store] = (await h.operations(id)).filter((op) => op.kind === 'store')
      expect(store).toMatchObject({
        status: 'failed',
        error: 'This world is too big to pack into one archive.',
      })
      expect(h.runtime.machine(id)).toMatchObject({ released: false })
      expect(await castle(id)).toBe("Atlas's castle")
    } finally {
      exports.mockRestore()
      h.runtime.failExports(null)
    }
  }, 60_000)

  test('a release that stops partway leaves the world resting in its copy, and waking clears the rest', async () => {
    const { owner, id } = await asleep('free', 'Parker')
    await idleFor(id, 15)
    h.runtime.failReleases('the provider went away', { partway: true })
    const after = await rest(id)
    // Its retries ran out partway: the copy was verified before anything was let go, so the
    // world rests in it; whatever the release left behind is still named by its handle.
    expect(after.lifecycle.status).toBe('stored')
    expect(await storedCopy(h.db, id)).toMatchObject({ status: 'ready', expiresAt: null })
    const audit = await h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'server.store_incomplete')))
    expect(audit).toHaveLength(1)

    h.runtime.failReleases(null)
    expect((await wake(owner, id)).lifecycle.status).toBe('running')
    expect(await castle(id)).toBe("Parker's castle")
  }, 60_000)

  test('a wake that fails puts the world back to rest, whole, with nothing half-made kept', async () => {
    const { owner, id } = await asleep('free', 'Blair')
    await idleFor(id, 15)
    await rest(id)
    for (const failure of ['storage', 'compute'] as const) {
      h.runtime.failRestores('the region is full', failure)
      const failed = await wake(owner, id)
      expect(failed.lifecycle.status).toBe('stored')
      expect(failed.storedAt).not.toBeNull()
      // The copy is the world, untouched; what the attempt made is let go again.
      expect(await storedCopy(h.db, id)).toMatchObject({ status: 'ready', expiresAt: null })
      expect(h.runtime.machine(id)).toMatchObject({ compute: false, released: true })
      h.runtime.failRestores(null)
    }
    // A world that won't boot is put back the same way.
    h.runtime.failBootWhen(() => 'exit 1')
    expect((await wake(owner, id)).lifecycle.status).toBe('stored')
    h.runtime.failBootWhen(() => null)

    expect((await wake(owner, id)).lifecycle.status).toBe('running')
    expect(await castle(id)).toBe("Blair's castle")
    const failures = await h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'server.wake_failed')))
    expect(failures).toHaveLength(3)
  }, 90_000)

  test('someone playing while the copy is made keeps the world where it is', async () => {
    const { id } = await asleep('free', 'Morgan')
    await idleFor(id, 15)
    const release = h.runtime.holdExports(1)
    await h.app.schedules.storeSweep()
    // The copy is on its way; somebody plays meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 200))
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() + 1000) })
      .where(eq(schema.minecraftServers.id, id))
    release()
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    expect(h.runtime.machine(id)).toMatchObject({ released: false })
    expect(await castle(id)).toBe("Morgan's castle")
    // The copy it made stays a while, as a backup of how the world was.
    const copy = await storedCopy(h.db, id)
    expect(copy?.expiresAt).not.toBeNull()
  }, 60_000)

  test('a start asked for while the copy is made wins: the world never leaves its disk', async () => {
    const { owner, id } = await asleep('free', 'Quinn')
    await idleFor(id, 15)
    const release = h.runtime.holdExports(1)
    await h.app.schedules.storeSweep()
    await new Promise((resolve) => setTimeout(resolve, 200))
    await h.app.servers.start(owner, id, randomUUID())
    release()
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    expect(h.runtime.machine(id)).toMatchObject({ released: false, state: 'running' })
    expect(await castle(id)).toBe("Quinn's castle")
    const stores = (await h.operations(id)).filter((op) => op.kind === 'store')
    expect(stores.map((op) => op.status)).toEqual(['cancelled'])
  }, 60_000)

  test('the copy a world rests in outlives every sweep, and only the server’s end ends it', async () => {
    const { owner, id } = await asleep('free', 'Keeper')
    await idleFor(id, 15)
    await rest(id)
    const copy = await storedCopy(h.db, id)
    // The backup sweeps expire and erase what has ended; this hasn't.
    await h.app.schedules.backups(new Date(Date.now() + 400 * DAY))
    expect(await storedCopy(h.db, id)).toMatchObject({ id: copy?.id, status: 'ready' })
    expect(await store.head(copy?.archiveKey ?? '')).not.toBeNull()
    // Nobody can delete it by hand while it is the world.
    const refused = await h.app.backups.deleteBackup(owner, id, copy?.id ?? '').catch((e: Error) => e.message)
    expect(refused).toBe('This is the world itself while it rests. Wake the server first.')
    // Sweeping twice queues nothing more for a world already resting.
    await h.app.schedules.storeSweep()
    expect((await h.operations(id)).filter((op) => op.kind === 'store')).toHaveLength(1)
  }, 60_000)

  test('a resting world deleted and brought back from the trash comes back resting, never empty', async () => {
    const { owner, id } = await asleep('free', 'Trash')
    await idleFor(id, 15)
    await rest(id)
    const { name } = await h.server(id)
    await h.app.servers.deleteServer(owner, id, name)
    await h.settled(id)
    const back = await h.app.servers.undeleteServer(owner, id)
    expect(back.lifecycle.status).toBe('stored')
    expect((await wake(owner, id)).lifecycle.status).toBe('running')
    expect(await castle(id)).toBe("Trash's castle")
  }, 60_000)

  test('purging a resting server takes its copy out of the store', async () => {
    const { owner, id } = await asleep('free', 'Gone')
    await idleFor(id, 15)
    await rest(id)
    const copy = await storedCopy(h.db, id)
    const { name } = await h.server(id)
    await h.app.servers.deleteServer(owner, id, name)
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ purgeAfter: new Date(Date.now() - 1000) })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.schedules.purgeSweep()
    await h.until(id, 'purged', 20_000)
    await h.settled(id)
    await h.app.backups.eraseArchives()
    expect(await store.head(copy?.archiveKey ?? '')).toBeNull()
  }, 60_000)

  test('settings wait for the world to wake; its name and who may join do not', async () => {
    const { owner, id } = await asleep('free', 'Patient')
    await idleFor(id, 15)
    await rest(id)
    const restart = await h.app.servers.restart(owner, id, randomUUID()).catch((e: Error) => e.message)
    // Restarting a resting world is waking it.
    expect(typeof restart === 'string' ? restart : restart.lifecycle.status).toBe('restoring')
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    expect(await castle(id)).toBe("Patient's castle")
    // And once it rests again, its identity still changes without waking it.
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await idleFor(id, 15)
    await rest(id)
    const renamed = await h.app.servers.saveIdentity(owner, id, { name: 'Patient World' })
    expect(renamed).toMatchObject({ name: 'Patient World' })
    expect((await h.server(id)).lifecycle.status).toBe('stored')
    const binding = await loadRuntime(h.db, id, ['fake'])
    expect(binding.handle).not.toBeNull()
  }, 90_000)
})
