// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The idle check walks the running servers one by one, and a player can join any of them while it
 * is busy with another. Each server's presence is read at its own turn, just before deciding, so a
 * player who joined during the pass keeps their server running.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { IDLE_GRACE_MS } from './schedules.ts'

describe.skipIf(!hasDatabase)('the idle check leaves a server a player just joined', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  /** Running for two hours with nobody seen: past the free plan's idle time. */
  const longIdle = async () => {
    const owner = await h.user()
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: sql`now() - interval '2 hours'` })
      .where(eq(schema.powerIntervals.serverId, id))
    await h.db.delete(schema.serverActivity).where(eq(schema.serverActivity.serverId, id))
    return { id, slug }
  }

  test('a join that lands while the pass is on another server keeps its server running', async () => {
    const servers = [await longIdle(), await longIdle()]
    const player = { name: 'Alex', uuid: randomUUID() }
    const original = h.app.servers.stop.bind(h.app.servers)
    let joined: { id: string; slug: string } | null = null
    const stops = spyOn(h.app.servers, 'stop').mockImplementation(
      async (actor, serverId, requestId, reason) => {
        if (joined === null) {
          // While the check stops the first idle server, Alex joins the other one: the server lets
          // them in, and the edge says so.
          joined = servers.find((s) => s.id !== serverId) ?? null
          if (joined !== null) {
            h.minecraft.join(joined.id, player)
            await h.app.edge.recordSession({
              edgeId: 'e1',
              hostname: `${joined.slug}.play.test`,
              event: 'connect',
              player,
              at: new Date().toISOString(),
            })
          }
        }
        return original(actor, serverId, requestId, reason)
      },
    )
    try {
      await h.app.schedules.idleCheck(new Date(Date.now() + IDLE_GRACE_MS + MINUTE_MS))
    } finally {
      stops.mockRestore()
    }
    const other = joined as { id: string; slug: string } | null
    expect(other).not.toBeNull()
    await h.settled(other?.id ?? '')
    // Still running, Alex playing.
    expect((await h.server(other?.id ?? '')).lifecycle.status).toBe('running')
  }, 60_000)

  test('an idle stop that finds someone in the game is called off, and says so', async () => {
    const { id } = await longIdle()
    const player = { name: 'Steve', uuid: randomUUID() }
    const original = h.app.servers.stop.bind(h.app.servers)
    // The check has decided; Steve is in the game before the stop runs, and nothing else said so.
    const stops = spyOn(h.app.servers, 'stop').mockImplementation(
      async (actor, serverId, requestId, reason) => {
        h.minecraft.join(serverId, player)
        return original(actor, serverId, requestId, reason)
      },
    )
    try {
      await h.app.schedules.idleCheck(new Date(Date.now() + IDLE_GRACE_MS + MINUTE_MS))
    } finally {
      stops.mockRestore()
    }
    await h.settled(id)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    const [stop] = await h.db
      .select()
      .from(schema.serverOperations)
      .where(and(eq(schema.serverOperations.serverId, id), eq(schema.serverOperations.kind, 'stop')))
    expect(stop).toMatchObject({ status: 'cancelled', requestedBy: 'system:idle' })
    expect(h.runtime.machine(id)?.state).toBe('running')
  }, 60_000)
})
