// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world woken from rest and put to rest again comes back as it was when it last slept, though
 * nothing counted play in between: each rest makes its own copy, and the one before stays its
 * week as a backup. A restore in between is `resting-after-restore.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { DAY_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { listBackups, storedCopy } from '../backups/persistence.ts'

describe.skipIf(!hasDatabase)('resting again after a wake', () => {
  let h: Harness
  const store = new MemoryStore()

  beforeAll(async () => {
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    await h?.close()
    store.close()
  })

  const built = (id: string) => h.minecraft.path(id, 'world/built.txt')
  const copiesOf = async (id: string) =>
    (await listBackups(h.db, id)).filter((b) => b.tier === 'archive' && b.trigger === 'stored')

  /** A world built on, left a fortnight, rested, then woken by a join: its slug and owner. */
  const restedThenJoined = async (name: string) => {
    const owner = await h.user(name)
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await writeFile(built(id), 'the castle')
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - 15 * DAY_MS) })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.schedules.storeSweep()
    await h.until(id, 'stored', 20_000)
    await h.settled(id, 20_000)
    await h.app.edge.wake(`${slug}.play.test`)
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    return { owner, id, slug }
  }

  /** Asleep the ordinary way, as a probation's end puts it (past a fresh control plane's grace). */
  const sleeps = async (id: string) => {
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(Date.now() - 6 * MINUTE_MS) })
      .where(and(eq(schema.powerIntervals.serverId, id), sql`${schema.powerIntervals.stoppedAt} is null`))
    await h.app.schedules.idleCheck(new Date(Date.now() + 10 * MINUTE_MS))
    await h.until(id, 'stopped')
    await h.settled(id)
  }

  test('a wake nobody joined rests again in a copy of its own, the first kept its week', async () => {
    const { id } = await restedThenJoined('Knock')
    await sleeps(id)
    // Still idle for as long as before: it rests again. Nothing counted play, but the world may
    // have changed anyway, so the rest makes a new copy; the first goes when its week is up.
    await h.app.schedules.storeSweep()
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('stored')
    const [newest, first] = await copiesOf(id)
    expect(newest?.expiresAt).toBeNull()
    expect(first?.status).toBe('ready')
    expect(first?.expiresAt).not.toBeNull()
    expect((await storedCopy(h.db, id))?.id).toBe(newest?.id)
  }, 60_000)

  test('a short visit on a woken world survives its next rest', async () => {
    const { owner, id, slug } = await restedThenJoined('Quinn')
    // A friend is in for under a minute, between two presence readings, and builds a tower.
    const friend = { name: 'Rowan', uuid: randomUUID() }
    h.minecraft.join(id, friend)
    const hostname = `${slug}.play.test`
    const at = () => new Date().toISOString()
    await h.app.edge.recordSession({ edgeId: 'e1', hostname, event: 'connect', player: friend, at: at() })
    await writeFile(built(id), 'the castle, and a tower')
    h.minecraft.leave(id, friend.uuid)
    await h.app.edge.recordSession({ edgeId: 'e1', hostname, event: 'disconnect', player: friend, at: at() })
    await sleeps(id)
    expect(await readFile(built(id), 'utf8')).toBe('the castle, and a tower')

    // The hourly sweep rests it again.
    await h.app.schedules.storeSweep()
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('stored')
    expect(await copiesOf(id)).toHaveLength(2)

    // The owner wakes it later: the tower is there.
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status !== 'restoring' && s.lifecycle.status !== 'stored', 20_000)
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await readFile(built(id), 'utf8')).toBe('the castle, and a tower')
  }, 90_000)
})
