// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The route inputs' fingerprint moves with every input the routes are read from, and with nothing
 * else; it is read again only once the database says one of them moved; and an edge's word is
 * written seldom while no server waits on the edges.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { fingerprint, readInputs } from './inputs.ts'

describe.skipIf(!hasDatabase)('the route inputs', () => {
  let h: Harness
  const providers = () => [...h.runtimes.keys()]
  const digest = async () => (await fingerprint(h.db, providers())).digest

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })

  test('read in one snapshot with the fingerprint they go by, which moves only with what they read', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    const servers = schema.minecraftServers
    const runtimes = schema.serverRuntimes

    const read = await readInputs(h.db, providers())
    expect(read.fingerprint.digest).toBe(await digest())
    expect(read.inputs.servers.map((s) => s.id)).toContain(created.id)
    expect(read.inputs.bindings.get(created.id)?.handle).toBeTruthy()

    // What the routes don't say leaves it where it was.
    let before = await digest()
    await h.db
      .update(servers)
      .set({ lastActiveAt: new Date(0) })
      .where(eq(servers.id, created.id))
    await h.db.update(runtimes).set({ diskUsedBytes: 1 }).where(eq(runtimes.serverId, created.id))
    await h.db
      .update(runtimes)
      .set({ observed: sql`coalesce(${runtimes.observed}, '{}'::jsonb) || '{"detail":"x"}'` })
      .where(eq(runtimes.serverId, created.id))
    expect(await digest()).toBe(before)

    // Each thing a route says moves it.
    const moves = [
      () => h.db.update(servers).set({ name: 'Renamed' }).where(eq(servers.id, created.id)),
      () =>
        h.db
          .update(servers)
          .set({ ownIcon: 'a'.repeat(64) })
          .where(eq(servers.id, created.id)),
      () =>
        h.db
          .update(runtimes)
          .set({ applied: sql`${runtimes.applied} || '{"proxyProtocol":true}'` })
          .where(eq(runtimes.serverId, created.id)),
      () => h.db.update(runtimes).set({ handle: null }).where(eq(runtimes.serverId, created.id)),
      () =>
        h.db.insert(schema.serverOperations).values({
          id: randomUUID(),
          serverId: created.id,
          kind: 'restart',
          status: 'queued',
          requestedBy: 'test',
          idempotencyKey: randomUUID(),
          input: {},
        }),
      () =>
        h.db
          .update(servers)
          .set({ status: 'stopped', stopReason: 'daily' })
          .where(eq(servers.id, created.id)),
      () => h.db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, created.id)),
    ]
    for (const move of moves) {
      before = await digest()
      await move()
      expect(await digest()).not.toBe(before)
    }
  }, 30_000)

  test('say whether a running server waits to be listed, or to be told every edge holds it', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    const servers = schema.minecraftServers
    await h.db.update(servers).set({ routeListedAt: null, routedAt: null }).where(eq(servers.id, created.id))
    expect(await fingerprint(h.db, providers())).toMatchObject({ unlisted: true, unrouted: true })

    // A list names it, and with no edge counted it is told at once.
    await h.app.edge.listed()
    await h.app.edge.seen('edge-inputs', null)
    expect(await fingerprint(h.db, providers())).toMatchObject({ unlisted: false, unrouted: false })
  }, 30_000)

  test("an edge's word, while no server waits, is written every few seconds rather than every ask", async () => {
    const edgeId = `edge-${randomUUID()}`
    const seenAt = async () =>
      (await h.db.select().from(schema.edges).where(eq(schema.edges.edgeId, edgeId)))[0]?.seenAt
    await h.app.edge.seen(edgeId, null, false)
    const first = await seenAt()
    expect(first).toBeDefined()
    await h.app.edge.seen(edgeId, new Date(), false)
    expect(await seenAt()).toEqual(first)
    // A server waits: every ask is written, as it is told.
    await h.app.edge.seen(edgeId, new Date(), true)
    expect((await seenAt())?.getTime()).toBeGreaterThan(first?.getTime() ?? 0)
  }, 30_000)
})

describe.skipIf(!hasDatabase)('the route inputs, while the database says none moved', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })

  test('are not read again, with a version that keeps up, until a write says so', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    // Listed and told, so no server waits on the edges.
    await h.app.edge.listed()
    await h.app.edge.seen(`edge-${randomUUID()}`, null)
    // The fingerprint is read on the database itself; the inputs, in a transaction of their own.
    const execute = spyOn(h.db, 'execute')
    const reads = () => execute.mock.calls.length
    try {
      // Once the writes of its start are all heard, asking reads nothing.
      const deadline = Date.now() + 10_000
      for (let quiet = 0; quiet < 3 && Date.now() < deadline; ) {
        const before = reads()
        await Bun.sleep(200)
        await h.app.edge.listed()
        quiet = reads() === before ? quiet + 1 : 0
      }
      const before = reads()
      const first = await h.app.edge.listed()
      await Bun.sleep(300)
      const second = await h.app.edge.listed()
      expect(reads()).toBe(before)
      expect(second.from.getTime()).toBeGreaterThan(first.from.getTime())
      // Never later than the database's own clock, and close behind it.
      const [row] = (await h.db.execute<{ now: string }>(sql`select clock_timestamp() as now`)).rows
      const now = new Date(row?.now ?? 0).getTime()
      expect(second.from.getTime()).toBeLessThanOrEqual(now)
      expect(now - second.from.getTime()).toBeLessThan(1000)

      // A write says so, and the next ask reads.
      await h.db
        .update(schema.minecraftServers)
        .set({ name: 'Moved' })
        .where(eq(schema.minecraftServers.id, created.id))
      await Bun.sleep(100)
      const asked = reads()
      await h.app.edge.listed()
      expect(reads()).toBe(asked + 1)

      // So does a Via plugin pinned for a release, which the routes also go by.
      await h.app.edge.listed()
      await h.db.execute(
        sql`insert into compat_plugins (game_version, project_id, pinned, pinned_at) values ('0.0-test', 'via-test', '{}', now())`,
      )
      await Bun.sleep(100)
      const pinned = reads()
      await h.app.edge.listed()
      expect(reads()).toBe(pinned + 1)
    } finally {
      execute.mockRestore()
    }
  }, 30_000)
})
