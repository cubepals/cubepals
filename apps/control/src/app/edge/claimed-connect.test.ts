// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edge's session events are what the client claims: a login start names any player it likes,
 * and the edge reports `connect` once it has dialled the server, before the server lets anyone in.
 * Only the server's own reading keeps it awake: a client that keeps connecting under any name buys
 * at most one more reading, and a woken run nobody joins sleeps after its probation all the same.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { IDLE_GRACE_MS, WAKE_PROBATION_MS } from '../operations/schedules.ts'

describe.skipIf(!hasDatabase)('a claimed connect keeps no server awake', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a woken run nobody joined sleeps after the probation, however often a client claims to connect', async () => {
    const owner = await h.user()
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)

    // A connection wakes it: a woken run, on probation.
    expect((await h.app.edge.wake(`${slug}.play.test`)).outcome).toBe('ready')
    await h.settled(id)

    // The "player" is whatever the client's login start claimed; nobody ever gets in.
    const claimed = { name: 'Nobody', uuid: randomUUID() }
    const connect = () =>
      h.app.edge.recordSession({
        edgeId: 'e1',
        hostname: `${slug}.play.test`,
        event: 'connect',
        player: claimed,
        at: new Date().toISOString(),
      })
    // Past the grace a fresh control plane gives presence, past the probation and past the free
    // plan's whole idle window.
    const late = new Date(Date.now() + IDLE_GRACE_MS + WAKE_PROBATION_MS + 30 * MINUTE_MS)

    // Each minute while it runs: the server's own reading says nobody is on (and drops the hint),
    // then the client connects again before the idle check, as one reconnecting every few seconds
    // does.
    for (let round = 0; round < 3; round++) {
      if ((await h.server(id)).lifecycle.status !== 'running') break
      await h.app.schedules.presenceSync()
      const rows = await h.db
        .select()
        .from(schema.serverPresence)
        .where(eq(schema.serverPresence.serverId, id))
      expect(rows).toHaveLength(0)
      await connect()
      await h.app.schedules.idleCheck(late)
    }
    // The server itself never saw anyone: nothing marks it played.
    expect(
      await h.db.select().from(schema.serverActivity).where(eq(schema.serverActivity.serverId, id)),
    ).toEqual([])
    // Asleep after the probation, as `domain/server/idle.ts` promises.
    expect((await h.server(id)).lifecycle.status).not.toBe('running')
  }, 60_000)

  test('without a claimed connect, the same check puts the same kind of run to sleep', async () => {
    const owner = await h.user()
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)
    expect((await h.app.edge.wake(`${slug}.play.test`)).outcome).toBe('ready')
    await h.settled(id)
    await h.app.schedules.presenceSync()
    await h.app.schedules.idleCheck(new Date(Date.now() + IDLE_GRACE_MS + WAKE_PROBATION_MS + 30 * MINUTE_MS))
    expect((await h.until(id, 'stopped')).lifecycle.stopReason).toBe('idle')
  }, 60_000)
})
