// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A kept address on the edge (`domain/server/kept-addresses.ts`): it routes as the address of the
 * server it points at, a join to it wakes that server, and what the edge reports at it counts for
 * that server. It is never a server of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { Slug } from '../../domain/server/slug.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

describe.skipIf(!hasDatabase)('a kept address', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('routes nowhere while no server has the slug it points at', async () => {
    const { routes } = await h.app.edge.routes()
    expect(routes.filter((r) => r.hostname.startsWith('sunset-valley.'))).toEqual([])
    expect(await h.app.edge.wake('sunset-valley.play.test')).toEqual({ outcome: 'denied', reason: 'unknown' })
  })

  test('routes, wakes and counts as the server it points at, under every play domain', async () => {
    const owner = await h.user()
    const made = await h.create(owner, { name: 'Arcade' })
    await h.db
      .update(schema.minecraftServers)
      .set({ slug: 'arcade' as Slug })
      .where(eq(schema.minecraftServers.id, made.id))
    await h.until(made.id, 'running')
    await h.settled(made.id)
    await h.app.servers.stop(owner, made.id, randomUUID(), 'idle')
    await h.until(made.id, 'stopped')
    await h.settled(made.id)

    // Asleep: the kept address's routes are Arcade's, with only the hostname and whose it is added.
    const asleep = (await h.app.edge.routes()).routes
    const arcade = asleep.find((r) => r.hostname === 'arcade.play.test')
    if (arcade === undefined) throw new Error('Arcade has no route')
    expect(arcade.state).toBe('asleep')
    expect(arcade.aliasOf).toBeUndefined()
    for (const domain of ['play.test', 'play.old.test'])
      expect(asleep.find((r) => r.hostname === `sunset-valley.${domain}`)).toEqual({
        ...arcade,
        hostname: `sunset-valley.${domain}`,
        aliasOf: 'arcade',
      })

    // A join at it wakes Arcade, and is sent where a join at Arcade's own address is.
    const woken = await h.app.edge.wake('sunset-valley.play.test')
    expect(woken).toMatchObject({ outcome: 'ready', destination: expect.stringContaining(':') })
    expect((await h.server(made.id)).lifecycle.status).toBe('running')
    expect(await h.app.edge.wake('arcade.play.test')).toEqual({
      outcome: 'ready',
      destination: (woken as { destination: string }).destination,
    })
    const running = (await h.app.edge.routes()).routes
    const destination = running.find((r) => r.hostname === 'arcade.play.test')?.destination
    expect(running.find((r) => r.hostname === 'sunset-valley.play.test')?.destination).toBe(destination)

    // A player seen at it is on Arcade, and no other server is.
    const player = { name: 'Alex', uuid: '5f2c5d3a9b6e4f10a1b2c3d4e5f60718' }
    await h.app.edge.recordSession({
      edgeId: 'e1',
      hostname: 'sunset-valley.play.test',
      event: 'connect',
      player,
      at: new Date().toISOString(),
    })
    const online = await h.db.select().from(schema.serverPresence)
    expect(online).toMatchObject([{ serverId: made.id, playerName: 'Alex', source: 'edge' }])
    expect(await h.app.edge.idleHint('sunset-valley.play.test')).toBe('grace')
  }, 60_000)

  test('a server that had the kept address before is not routed at it', async () => {
    const owner = await h.user()
    const made = await h.create(owner, { name: 'Sunset' })
    await h.db
      .update(schema.minecraftServers)
      .set({ slug: 'sunset-valley' as Slug })
      .where(eq(schema.minecraftServers.id, made.id))
    await h.until(made.id, 'running')
    const hostnames = (await h.app.edge.routes()).routes.map((r) => r.hostname)
    expect(hostnames.filter((name) => name === 'sunset-valley.play.test')).toHaveLength(1)
  }, 60_000)
})
