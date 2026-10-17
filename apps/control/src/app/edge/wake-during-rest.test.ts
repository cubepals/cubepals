// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A join's wake reads the server's status, then asks for the start. A server that moves on in
 * between (its rest reaching `storing`, a move reaching `relocating`) still exists: the join waits
 * for that work as it would had it seen it first, and is never told there is no server there.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

describe.skipIf(!hasDatabase)('a join that meets a rest waits for it', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a server that reached storing between the wake’s read and its start is never "unknown"', async () => {
    const owner = await h.user()
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)

    // The store's own transaction (`stopped` → `storing`, stored-worlds.ts) commits just as the
    // join asks for its start: the transition alone, as that transaction writes it.
    const original = h.app.servers.start.bind(h.app.servers)
    const start = spyOn(h.app.servers, 'start').mockImplementation(async (actor, serverId, requestId) => {
      await h.db
        .update(schema.minecraftServers)
        .set({ status: 'storing' })
        .where(eq(schema.minecraftServers.id, serverId))
      return original(actor, serverId, requestId)
    })
    let woken: Awaited<ReturnType<typeof h.app.edge.wake>>
    try {
      woken = await h.app.edge.wake(`${slug}.play.test`)
    } finally {
      start.mockRestore()
      await h.db
        .update(schema.minecraftServers)
        .set({ status: 'stopped' })
        .where(eq(schema.minecraftServers.id, id))
    }
    expect(woken).not.toEqual({ outcome: 'denied', reason: 'unknown' })
  }, 60_000)
})
