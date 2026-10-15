// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** When a running server reads as running: once every edge seen lately holds its route. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import type { DomainEvent } from '../ports/events.ts'
import { EDGE_SEEN_MS } from './routed.ts'

// Until then it is still starting, to its owner and to anyone told (routed.ts).
describe.skipIf(!hasDatabase)('a running server, as the edges hold it', () => {
  let h: Harness
  const told: DomainEvent[] = []

  beforeAll(async () => {
    h = await startHarness()
    await h.events.subscribe((event) => void told.push(event))
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  beforeEach(async () => {
    await h.db.delete(schema.edges)
  })

  const running = async (owner: UserActor) => {
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return created.id
  }
  const shown = async (owner: UserActor, id: string) => (await h.app.queries.get(owner, id)).status

  /** An edge asks for routes; holding what it is handed, it is synced to that list's read. */
  const asks = async (edgeId: string, holds: boolean) => {
    const { from } = await h.app.edge.listed()
    await h.app.edge.seen(edgeId, holds ? from : null)
  }

  test('with no edge seen, as where none runs, it reads as running at once', async () => {
    const owner = await h.user()
    const id = await running(owner)
    expect(await shown(owner, id)).toBe('running')
  }, 30_000)

  test('it reads as starting until the edge says it holds a list naming it, and its page is told', async () => {
    const owner = await h.user()
    await asks('e1', false)
    const id = await running(owner)
    expect(await shown(owner, id)).toBe('starting')
    // A list read before the server was named running doesn't cover it.
    await asks('e1', false)
    expect(await shown(owner, id)).toBe('starting')

    const before = (await h.server(id)).version
    await asks('e1', true)
    expect(await shown(owner, id)).toBe('running')
    expect((await h.server(id)).version).toBe(before + 1)
    await Bun.sleep(200)
    expect(told).toContainEqual({
      type: 'server_changed',
      serverId: id,
      ownerId: owner.userId,
      status: 'running',
      version: before + 1,
    })
  }, 30_000)

  test('every edge seen lately has to hold it; one not seen for a while no longer counts', async () => {
    const owner = await h.user()
    await asks('holds', false)
    await asks('lags', false)
    const id = await running(owner)
    await asks('holds', true)
    await asks('holds', true)
    expect(await shown(owner, id)).toBe('starting')

    await h.db
      .update(schema.edges)
      .set({ seenAt: new Date(Date.now() - EDGE_SEEN_MS - 1_000) })
      .where(eq(schema.edges.edgeId, 'lags'))
    expect(await shown(owner, id)).toBe('running')
  }, 30_000)

  test('a server that stops and starts again waits for its route again', async () => {
    const owner = await h.user()
    await asks('e1', false)
    const id = await running(owner)
    await asks('e1', true)
    await asks('e1', true)
    expect(await shown(owner, id)).toBe('running')

    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    const [row] = await h.db
      .select({ listedAt: schema.minecraftServers.routeListedAt })
      .from(schema.minecraftServers)
      .where(eq(schema.minecraftServers.id, id))
    expect(row?.listedAt).toBeNull()
    expect(await shown(owner, id)).toBe('starting')
    // The edge is handed the list naming it, then says at once that it holds it.
    await asks('e1', true)
    await asks('e1', true)
    expect(await shown(owner, id)).toBe('running')
  }, 30_000)
})
