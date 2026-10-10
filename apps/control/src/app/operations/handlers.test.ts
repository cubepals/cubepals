// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { asc, eq, sql } from 'drizzle-orm'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'
import type { DomainEvent } from '../ports/events.ts'
import { RuntimeFull } from '../ports/runtime.ts'
import { loadRuntime } from '../servers/persistence.ts'
import { HOST_LOSS_GRACE_MS } from './schedules.ts'

// What each operation tells the web app it is doing, step by step, and the power intervals it
// leaves behind: what people see while it runs, and what they are billed for once it has. These
// pin what the handlers do today, so a change to how they are put together can't move either.
const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}
const DAY = 86_400_000

/** Every operation's steps as the web app hears them, in order, until it ends. */
const follow = async (h: Harness) => {
  const seen = new Map<string, { steps: string[]; ended: boolean }>()
  const stop = await h.events.subscribe((event: DomainEvent) => {
    if (event.type !== 'operation_progress') return
    const op = seen.get(event.operationId) ?? { steps: [], ended: false }
    seen.set(event.operationId, op)
    if (event.step !== null) op.steps.push(event.step)
    if (event.status === 'succeeded' || event.status === 'failed' || event.status === 'cancelled')
      op.ended = true
  })
  /** The steps of the server's latest operation of `kind`, once its end has been heard. */
  const steps = async (serverId: string, kind: string) => {
    const op = (await h.operations(serverId)).filter((o) => o.kind === kind).at(-1)
    if (op === undefined) throw new Error(`No ${kind} operation`)
    const deadline = Date.now() + 10_000
    while (!seen.get(op.id)?.ended) {
      if (Date.now() > deadline) throw new Error(`The end of ${kind} was never heard`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return seen.get(op.id)?.steps ?? []
  }
  return { steps, stop }
}

/** A server's power intervals, oldest first: what its owner is billed for. */
const intervalsOf = async (h: Harness, serverId: string) =>
  (
    await h.db
      .select()
      .from(schema.powerIntervals)
      .where(eq(schema.powerIntervals.serverId, serverId))
      .orderBy(asc(schema.powerIntervals.startedAt))
  ).map((i) => ({ provider: i.provider, open: i.stoppedAt === null, woken: i.woken }))

const closed = { provider: 'fake', open: false, woken: false }
const open = { provider: 'fake', open: true, woken: false }

describe.skipIf(!hasDatabase)('operation steps and power intervals', () => {
  let h: Harness
  let progress: Awaited<ReturnType<typeof follow>>

  beforeAll(async () => {
    h = await startHarness()
    progress = await follow(h)
  }, 30_000)

  afterEach(() => {
    h.minecraft.breakOn(() => null)
  })

  afterAll(async () => {
    await progress.stop()
    await h.close()
  })

  const running = async (request: { gameVersion?: string } = {}) => {
    const owner = await h.user()
    const server = await h.create(owner, request)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }
  const stopped = async (request: { gameVersion?: string } = {}) => {
    const { owner, id } = await running(request)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    return { owner, id }
  }
  const backUp = async (owner: UserActor, id: string) => {
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [newest] = (await listBackups(h.db, id)).filter((b) => b.status === 'ready')
    if (newest === undefined) throw new Error('No backup was taken')
    return newest
  }
  const upgrade = (owner: UserActor, id: string) =>
    h.app.mods.changeVersion(owner, id, { gameVersion: '26.3', loader: 'vanilla' }, [], randomUUID())
  const breaksOnUpgrade = () =>
    h.minecraft.breakOn((env) => (env.VERSION === '26.3' ? 'this world needs a newer mod' : null))

  test('provision, stop, start and restart report their steps, and count from each start', async () => {
    const { owner, id } = await running()
    expect(await progress.steps(id, 'provision')).toEqual([
      'allocating',
      'storage',
      'compute',
      'booting',
      'access',
    ])
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    expect(await progress.steps(id, 'stop')).toEqual(['saving', 'stopping'])
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(await progress.steps(id, 'start')).toEqual([
      'allocating',
      'storage',
      'compute',
      'booting',
      'access',
    ])
    await h.app.servers.restart(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running')
    await h.settled(id)
    expect(await progress.steps(id, 'restart')).toEqual(['saving', 'stopping', 'booting', 'access'])
    expect(await intervalsOf(h, id)).toEqual([closed, closed, open])
  }, 40_000)

  test('an update takes its snapshot, and one that fails goes back as a single step', async () => {
    const { owner, id } = await running({ gameVersion: '26.2' })
    await upgrade(owner, id)
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > 3)
    await h.settled(id)
    expect(await progress.steps(id, 'apply')).toEqual(['saving', 'compute', 'booting', 'access'])

    const other = await running({ gameVersion: '26.2' })
    breaksOnUpgrade()
    await upgrade(other.owner, other.id)
    await h.until(other.id, (s) => s.lifecycle.status === 'running' && s.version > 3)
    await h.settled(other.id)
    expect(await progress.steps(other.id, 'apply')).toEqual(['saving', 'compute', 'booting', 'rolling_back'])
    // It ran all along: the interval it had is the one it keeps.
    expect(await intervalsOf(h, other.id)).toEqual([open])
  }, 60_000)

  test('a backup, a restore and a move to another region report their steps', async () => {
    const { owner, id } = await running()
    const backup = await backUp(owner, id)
    expect(await progress.steps(id, 'backup')).toEqual(['saving'])
    await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false })
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect(await progress.steps(id, 'restore')).toEqual(['saving', 'storage', 'compute', 'booting', 'access'])
    await h.app.servers.relocate(owner, id, 'far', randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.regionKey === 'far', 20_000)
    await h.settled(id)
    expect(await progress.steps(id, 'relocate')).toEqual([
      'saving',
      'storage',
      'storage',
      'booting',
      'access',
    ])
    expect(await intervalsOf(h, id)).toEqual([open])
  }, 60_000)

  test('a lost host refused for room stops counting, and is rebuilt stopped from its snapshot', async () => {
    const { owner, id } = await running()
    await backUp(owner, id)
    await h.runtime.loseHost(id)
    await h.app.schedules.presenceSync()
    const lost = (await loadRuntime(h.db, id, ['fake'])).observed
    const later = new Date(Date.parse(lost?.at ?? '') + HOST_LOSS_GRACE_MS + 1_000)
    const relocate = spyOn(h.runtime, 'relocate').mockImplementationOnce(async () => {
      throw new RuntimeFull('fake', 'no room just now')
    })
    try {
      await h.app.schedules.relocations(later)
      await h.until(id, 'stopped', 20_000)
      await h.settled(id, 20_000)
    } finally {
      relocate.mockRestore()
    }
    expect(await progress.steps(id, 'relocate')).toEqual(['storage'])
    expect(await intervalsOf(h, id)).toEqual([closed])

    await h.app.schedules.relocations(later)
    await h.settled(id, 20_000)
    expect(await progress.steps(id, 'relocate')).toEqual(['storage', 'storage', 'compute'])
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    expect(await intervalsOf(h, id)).toEqual([closed])
  }, 60_000)

  test('a server sent to the trash stops counting as it is decommissioned', async () => {
    const { owner, id } = await running()
    await h.app.servers.deleteServer(owner, id, (await h.server(id)).name)
    await h.settled(id)
    expect(await progress.steps(id, 'decommission')).toEqual([])
    expect(await intervalsOf(h, id)).toEqual([closed])
  }, 30_000)

  test('a start a connection asked for counts as woken', async () => {
    const { id } = await stopped()
    const { slug } = await h.server(id)
    await h.app.edge.wake(`${slug}.play.test`)
    await h.until(id, 'running', 20_000)
    await h.settled(id)
    expect(await progress.steps(id, 'start')).toEqual([
      'allocating',
      'storage',
      'compute',
      'booting',
      'access',
    ])
    expect(await intervalsOf(h, id)).toEqual([closed, { ...open, woken: true }])
  }, 30_000)

  test('a start onto a change that fails goes back, runs on what it ran, and counts from then', async () => {
    const { owner, id } = await stopped({ gameVersion: '26.2' })
    await upgrade(owner, id)
    await h.settled(id)
    breaksOnUpgrade()
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status !== 'starting', 20_000)
    await h.settled(id, 20_000)
    expect(await progress.steps(id, 'start')).toEqual([
      'saving',
      'allocating',
      'storage',
      'compute',
      'booting',
      'rolling_back',
    ])
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect((await h.operations(id)).filter((o) => o.kind === 'start').at(-1)?.status).toBe('failed')
    expect(await intervalsOf(h, id)).toEqual([closed, open])
  }, 40_000)
})

describe.skipIf(!hasDatabase || !s3.endpoint || !s3.bucket)('operation steps with an archive store', () => {
  let h: Harness
  let progress: Awaited<ReturnType<typeof follow>>
  const store = new S3ArchiveStore({
    endpoint: s3.endpoint ?? '',
    bucket: s3.bucket ?? '',
    region: 'auto',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  })

  beforeAll(async () => {
    h = await startHarness({
      capabilities: { archives: store, billing: null },
      otherRuntimes: [{ provider: 'canary' }],
    })
    progress = await follow(h)
  }, 30_000)

  afterEach(() => {
    canary().failRestores(null)
  })

  afterAll(async () => {
    await progress.stop()
    const keys = await h.db
      .select({ key: schema.backups.archiveKey })
      .from(schema.backups)
      .where(sql`${schema.backups.archiveKey} is not null`)
    for (const { key } of keys) if (key) await store.delete(key)
    await h.close()
  })

  const canary = () => {
    const found = h.runtimes.get('canary')
    if (found === undefined) throw new Error('no canary runtime')
    return found
  }
  const running = async () => {
    const owner = await h.user(undefined, 'plus')
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }

  test('an archive, a rest and a wake report their steps, and the wake counts as woken', async () => {
    const { owner, id } = await running()
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [snapshot] = (await listBackups(h.db, id)).filter((b) => b.status === 'ready')
    await h.app.backups.archiveBackup(owner, id, snapshot?.id ?? '', randomUUID())
    await h.settled(id, 20_000)
    expect(await progress.steps(id, 'archive')).toEqual(['storage'])

    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - 60 * DAY) })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.schedules.storeSweep()
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('stored')
    expect(await progress.steps(id, 'store')).toEqual(['saving', 'storage'])

    const { slug } = await h.server(id)
    await h.app.edge.wake(`${slug}.play.test`)
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    expect(await progress.steps(id, 'unstore')).toEqual(['storage', 'compute', 'booting', 'access'])
    expect(await intervalsOf(h, id)).toEqual([closed, { ...open, woken: true }])
  }, 60_000)

  // This pins what the code does today, not what it should do: a running server moved to another
  // runtime keeps the interval it opened on the first one, still recorded against that provider,
  // since the move stops it there without closing it and the open that follows finds one open.
  // The owner has been told; until they decide, the move must not change it.
  test('a running server moved to another runtime keeps the interval it had, as it does today', async () => {
    const { id } = await running()
    expect(await intervalsOf(h, id)).toEqual([open])
    await h.app.placement.requestMove(id, 'canary', 'operator:test')
    await h.app.schedules.relocations()
    await h.settled(id, 20_000)
    expect(await progress.steps(id, 'relocate')).toEqual([
      'saving',
      'storage',
      'storage',
      'compute',
      'booting',
      'access',
    ])
    expect((await loadRuntime(h.db, id, [...h.runtimes.keys()])).provider).toBe('canary')
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await intervalsOf(h, id)).toEqual([open])
  }, 60_000)

  test('a move to another runtime that fails runs again where it was, on the interval it had', async () => {
    const { id } = await running()
    canary().failRestores('the disk filled')
    await h.app.placement.requestMove(id, 'canary', 'operator:test')
    await h.app.schedules.relocations()
    await h.settled(id, 20_000)
    expect(await progress.steps(id, 'relocate')).toEqual([
      'saving',
      'storage',
      'storage',
      'booting',
      'access',
    ])
    expect((await loadRuntime(h.db, id, [...h.runtimes.keys()])).provider).toBe('fake')
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await intervalsOf(h, id)).toEqual([open])
  }, 60_000)
})
