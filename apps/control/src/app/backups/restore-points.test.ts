// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Restore points: a server that goes to sleep after people played keeps that session to go back
 * to, once it is down; one woken and left with nobody on keeps nothing new, and the plan keeps its
 * last few. A start never waits for one. End to end, against the fake runtime.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, isNull } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { MinecraftRuntime } from '../ports/runtime.ts'
import { lockServer } from '../servers/persistence.ts'
import { listBackups } from './persistence.ts'

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterAll(async () => {
  await h?.close()
})

const running = async () => {
  const owner = await h.user()
  const server = await h.create(owner)
  await h.until(server.id, 'running')
  await h.settled(server.id)
  return { owner, id: server.id, slug: server.slug }
}
type Owner = Awaited<ReturnType<typeof running>>['owner']
const lastOf = async (id: string, kind: string) =>
  (await h.operations(id)).filter((op) => op.kind === kind).at(-1)
const restore = async (owner: Owner, id: string, backupId: string) => {
  await h.app.backups.restoreBackup(owner, id, backupId, randomUUID(), { withConfiguration: false })
  await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
  await h.settled(id, 20_000)
}
/** Someone on, as the server itself reads it, and gone again. */
const play = async (id: string) => {
  const uuid = randomUUID()
  h.minecraft.join(id, { uuid, name: 'Alex' })
  await h.app.schedules.presenceSync()
  h.minecraft.leave(id, uuid)
  await h.app.schedules.presenceSync()
}
const stop = async (owner: Owner, id: string, reason: 'idle' | 'user' | 'maintenance' = 'idle') => {
  await h.app.servers.stop(owner, id, randomUUID(), reason)
  await h.until(id, 'stopped')
}
/** A backup its owner asked for, recorded as taken `at`. */
const backUpAt = async (owner: Owner, id: string, at: Date) => {
  await h.app.backups.createBackup(owner, id, randomUUID())
  await h.settled(id)
  await h.db
    .update(schema.backups)
    .set({ createdAt: at })
    .where(and(eq(schema.backups.serverId, id), eq(schema.backups.trigger, 'manual')))
}
const points = async (id: string) =>
  (await listBackups(h.db, id)).filter((b) => b.trigger === 'sleep' && b.status === 'ready')

describe.skipIf(!hasDatabase)('restore points', () => {
  test('each sleep after play keeps that session to go back to; one nobody played keeps none', async () => {
    const { owner, id } = await running()
    const marker = () => h.minecraft.path(id, 'world/base.txt')
    const sleep = async (reason?: 'idle' | 'user' | 'maintenance') => {
      await stop(owner, id, reason)
      await h.settled(id)
    }
    const wake = async () => {
      await h.app.servers.start(owner, id, randomUUID())
      await h.until(id, 'running')
      await h.settled(id)
    }

    await play(id)
    await writeFile(marker(), 'the base')
    await sleep()
    const [evening] = await points(id)
    expect(evening).toMatchObject({ tier: 'snapshot', status: 'ready' })
    // Taken once it was down: nothing paused a game that had already saved and gone.
    expect((await lastOf(id, 'backup'))?.input).toEqual({ trigger: 'sleep' })

    // Woken and left again with nobody on: nothing changed, so nothing new is kept.
    await wake()
    await sleep()
    expect(await points(id)).toHaveLength(1)
    // The day's backup has nothing to add either: the session is already kept.
    await h.app.schedules.backups()
    await h.settled(id)
    expect((await listBackups(h.db, id)).filter((b) => b.trigger === 'scheduled')).toHaveLength(0)
    // A stop before maintenance isn't a sleep.
    await wake()
    await play(id)
    await sleep('maintenance')
    expect(await points(id)).toHaveLength(1)

    // Someone blew up the base; the evening before is one restore away.
    await wake()
    await play(id)
    await writeFile(marker(), 'a crater')
    await sleep('user')
    expect(await points(id)).toHaveLength(2)
    await restore(owner, id, (evening as NonNullable<typeof evening>).id)
    expect(await readFile(marker(), 'utf8')).toBe('the base')

    // Free keeps its last three sessions, newest first.
    for (let session = 0; session < 3; session++) {
      await wake()
      await play(id)
      await sleep()
    }
    const kept = await points(id)
    expect(kept).toHaveLength(3)
    expect(kept.map((b) => b.id)).not.toContain(evening?.id)
  }, 60_000)

  test('a server woken from a sleep keeps saving; its day’s backup waits a day into the run', async () => {
    const { owner, id } = await running()
    await play(id)
    await stop(owner, id)
    await h.settled(id)
    expect(await points(id)).toHaveLength(1)
    // Two days asleep: its restore point, and the run that point holds, are that old.
    const slept = new Date(Date.now() - 2 * DAY_MS)
    await h.db.update(schema.backups).set({ createdAt: slept }).where(eq(schema.backups.serverId, id))
    await h.db
      .update(schema.powerIntervals)
      .set({
        startedAt: new Date(slept.getTime() - HOUR_MS),
        stoppedAt: new Date(slept.getTime() - MINUTE_MS),
      })
      .where(eq(schema.powerIntervals.serverId, id))
    const scheduled = async () => (await listBackups(h.db, id)).filter((b) => b.trigger === 'scheduled')

    // Woken, and someone plays: everything before is in its restore point, so nothing pauses saving.
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    await play(id)
    await h.app.schedules.backups()
    await h.settled(id)
    expect(await scheduled()).toHaveLength(0)

    // A day into the run, still awake: the day's backup comes.
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(Date.now() - DAY_MS - HOUR_MS) })
      .where(and(eq(schema.powerIntervals.serverId, id), isNull(schema.powerIntervals.stoppedAt)))
    await h.app.schedules.backups()
    await h.settled(id)
    expect(await scheduled()).toHaveLength(1)
  }, 30_000)

  test('a server woken after a sleep that kept nothing is backed up as before', async () => {
    const { owner, id } = await running()
    // Its last restore point is two days old, and it was played after it: no sleep kept that play.
    const old = new Date(Date.now() - 2 * DAY_MS)
    await backUpAt(owner, id, old)
    await play(id)
    await stop(owner, id, 'maintenance')
    await h.settled(id)
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    await play(id)
    await h.app.schedules.backups()
    await h.settled(id)
    expect((await listBackups(h.db, id)).filter((b) => b.trigger === 'scheduled')).toHaveLength(1)
  }, 30_000)

  test('a login the server turned away is not play, and keeps no restore point', async () => {
    const { owner, id, slug } = await running()
    // A client that asked to log in and was refused (no account, not on the whitelist): the edge
    // saw it come and go, the server never had anyone on.
    const player = { name: 'StagingCheck', uuid: '00000000-0000-0000-0000-000000000000' }
    for (const event of ['connect', 'disconnect'] as const)
      await h.app.edge.recordSession({
        edgeId: 'e1',
        hostname: `${slug}.play.test`,
        event,
        player,
        at: new Date().toISOString(),
      })
    await stop(owner, id)
    await h.settled(id)
    expect(await points(id)).toHaveLength(0)
    expect((await h.operations(id)).filter((op) => op.kind === 'backup')).toHaveLength(0)
  }, 30_000)
})

describe.skipIf(!hasDatabase)('restore points and starts', () => {
  test('a start drops a restore point still waiting its turn', async () => {
    const { owner, id } = await running()
    await stop(owner, id, 'maintenance')
    await h.settled(id)
    // Asleep, its restore point queued, and a join arrives before the restore point has begun.
    await h.db.transaction(async (tx) => {
      const asleep = await lockServer(tx, id)
      if (asleep === null) throw new Error('The server is gone')
      await h.app.transitions.enqueue(tx, asleep, 'backup', {
        requestedBy: 'system:sleep',
        idempotencyKey: `backup:sleep:${randomUUID()}`,
        input: { trigger: 'sleep' },
      })
      await h.app.transitions.command(
        tx,
        asleep,
        { type: 'start' },
        { requestedBy: `user:${owner.userId}`, idempotencyKey: `start:${randomUUID()}` },
      )
    })
    await h.until(id, 'running')
    await h.settled(id)
    // Whichever the runner takes first, the restore point is dropped: before its turn, or on
    // finding the server already awake.
    const dropped = await lastOf(id, 'backup')
    expect(dropped).toMatchObject({ status: 'cancelled' })
    expect(await points(id)).toHaveLength(0)
  }, 30_000)

  test('a join while a restore point is being written wakes the server without waiting for it', async () => {
    const { owner, id, slug } = await running()
    // Fly takes a snapshot as it is asked, and writes it for a minute or so after.
    const runtime: Pick<MinecraftRuntime, 'snapshot'> = h.runtime
    const snapshot = runtime.snapshot
    const taken = Promise.withResolvers<void>()
    const written = Promise.withResolvers<void>()
    runtime.snapshot = async (handle, onTaken) => {
      const made = await snapshot.call(h.runtime, handle)
      onTaken?.()
      taken.resolve()
      await written.promise
      return made
    }
    try {
      await play(id)
      await stop(owner, id)
      await taken.promise
      expect((await lastOf(id, 'backup'))?.status).toBe('running')

      await h.app.edge.wake(`${slug}.play.test`)
      await h.until(id, 'running', 10_000)
      expect(await points(id)).toHaveLength(0)
    } finally {
      written.resolve()
      runtime.snapshot = snapshot
    }
    // Written, it is kept as the session it holds.
    for (const deadline = Date.now() + 10_000; (await points(id)).length === 0 && Date.now() < deadline; )
      await Bun.sleep(50)
    expect(await points(id)).toHaveLength(1)
    expect((await lastOf(id, 'backup'))?.status).toBe('succeeded')
  }, 30_000)
})
