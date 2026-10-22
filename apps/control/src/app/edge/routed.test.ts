// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** When a running server reads as running: once every edge that counts holds its route. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import type { DomainEvent } from '../ports/events.ts'
import { EDGE_BEHIND_MS, EDGE_RESTART_GRACE_MS } from './routed.ts'

// Until then it is still starting, to its owner and to anyone told (routed.ts).

let h: Harness
const told: DomainEvent[] = []

/** A harness of its own for each part, with no edge known before each test. */
function harness(): void {
  beforeAll(async () => {
    told.length = 0
    h = await startHarness()
    await h.events.subscribe((event) => void told.push(event))
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })
  beforeEach(async () => {
    await h.db.delete(schema.edges)
  })
}

const running = async (owner: UserActor) => {
  const created = await h.create(owner)
  await h.until(created.id, 'running')
  await h.settled(created.id)
  return created.id
}
const shown = async (owner: UserActor, id: string) => (await h.app.queries.get(owner, id)).status

/** An edge asks for routes and applies the list it is handed: next time, it holds that version. */
const edge = (edgeId: string) => {
  let held: Date | null = null
  return async () => {
    const { from } = await h.app.edge.listed()
    await h.app.edge.seen(edgeId, held)
    held = from
  }
}
/** An edge that keeps asking, and never holds a list. */
const stuck = (edgeId: string) => () => h.app.edge.seen(edgeId, null)

describe.skipIf(!hasDatabase)('a running server, as edges that keep up hold it', () => {
  harness()

  test('with no edge seen, as where none runs, it reads as running at once', async () => {
    const owner = await h.user()
    const id = await running(owner)
    expect(await shown(owner, id)).toBe('running')
  }, 30_000)

  test('it reads as starting until the edge holds a version naming it, and its page is told', async () => {
    const owner = await h.user()
    const e1 = edge('e1')
    await e1()
    const id = await running(owner)
    expect(await shown(owner, id)).toBe('starting')
    // Handed the first list naming it, which stamps it after its read: that version doesn't cover it.
    await e1()
    await e1()
    expect(await shown(owner, id)).toBe('starting')

    const before = (await h.server(id)).version
    await e1()
    expect(await shown(owner, id)).toBe('running')
    expect((await h.server(id)).version).toBe(before + 1)
    await Bun.sleep(200)
    expect(told.filter((e) => e.type === 'server_changed' && e.serverId === id).at(-1)).toEqual({
      type: 'server_changed',
      serverId: id,
      ownerId: owner.userId,
      status: 'running',
      version: before + 1,
    })
  }, 30_000)

  test('an edge whose last word is 30 s old, as one is while nothing waits, still holds it back', async () => {
    const owner = await h.user()
    await edge('e1')()
    await h.db.update(schema.edges).set({
      seenAt: sql`clock_timestamp() - interval '30 seconds'`,
      syncedTo: sql`clock_timestamp() - interval '31 seconds'`,
    })
    const id = await running(owner)
    expect(await shown(owner, id)).toBe('starting')
  }, 30_000)

  test('an edge not heard from for a minute does not', async () => {
    const owner = await h.user()
    await edge('e1')()
    await h.db.update(schema.edges).set({
      seenAt: sql`clock_timestamp() - interval '60 seconds'`,
      syncedTo: sql`clock_timestamp() - interval '61 seconds'`,
    })
    const id = await running(owner)
    expect(await shown(owner, id)).toBe('running')
  }, 30_000)

  test('while the routes keep changing, an edge that applies each list catches up all the same', async () => {
    const owner = await h.user()
    const other = await running(await h.user())
    const e1 = edge('e1')
    await e1()
    const id = await running(owner)
    // Every list differs from the one before it: another server comes and goes in between.
    let polls = 0
    while ((await shown(owner, id)) !== 'running') {
      expect(polls++).toBeLessThan(4)
      await h.db
        .update(schema.minecraftServers)
        .set({ status: polls % 2 ? 'stopped' : 'running' })
        .where(eq(schema.minecraftServers.id, other))
      await e1()
    }
  }, 30_000)

  test('a server that stops and starts again waits for its route again', async () => {
    const owner = await h.user()
    const e1 = edge('e1')
    await e1()
    const id = await running(owner)
    for (let i = 0; i < 3; i++) await e1()
    expect(await shown(owner, id)).toBe('running')

    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(await shown(owner, id)).toBe('starting')
    for (let i = 0; i < 3; i++) await e1()
    expect(await shown(owner, id)).toBe('running')
  }, 30_000)

  test('an edge gone quiet for a day is forgotten', async () => {
    await h.db.insert(schema.edges).values({ edgeId: 'gone', seenAt: new Date(Date.now() - DAY_MS - 1_000) })
    await edge('e1')()
    const left = await h.db.select({ edgeId: schema.edges.edgeId }).from(schema.edges)
    expect(left.map((e) => e.edgeId)).toEqual(['e1'])
  }, 30_000)
})

describe.skipIf(!hasDatabase)('a running server, as edges that come late or fall behind hold it', () => {
  harness()

  test('an edge first seen after a server became running holds back only servers that start after it', async () => {
    const owner = await h.user()
    const e1 = edge('e1')
    await e1()
    const before = await running(owner)
    for (let i = 0; i < 3; i++) await e1()
    expect(await shown(owner, before)).toBe('running')

    const e2 = edge('e2')
    await e2()
    expect(await shown(owner, before)).toBe('running')
    const other = await h.user()
    const after = await running(other)
    for (let i = 0; i < 3; i++) await e1()
    expect(await shown(other, after)).toBe('starting')
    for (let i = 0; i < 3; i++) await e2()
    expect(await shown(other, after)).toBe('running')
  }, 30_000)

  test('an edge that keeps asking but falls behind stops counting, and an admin is told', async () => {
    const owner = await h.user()
    const e1 = edge('e1')
    await e1()
    await stuck('lags')()
    const id = await running(owner)
    for (let i = 0; i < 3; i++) await e1()
    expect(await shown(owner, id)).toBe('starting')

    // Still asking, but holding nothing for longer than the limit allows.
    await h.db
      .update(schema.edges)
      .set({ firstSeenAt: sql`clock_timestamp() - make_interval(secs => ${EDGE_BEHIND_MS / 1000 + 1})` })
      .where(eq(schema.edges.edgeId, 'lags'))
    await stuck('lags')()
    expect(await shown(owner, id)).toBe('running')
    const admin = { kind: 'admin' as const, userId: (await h.user('Admin')).userId }
    expect((await h.app.alerts.active(admin)).map((a) => a.key)).toContain('edge_behind')
  }, 30_000)

  test('an edge whose agent has just restarted is not reported behind; one that stays behind is', async () => {
    const admin = { kind: 'admin' as const, userId: (await h.user('Admin')).userId }
    const alerted = async () => (await h.app.alerts.active(admin)).map((a) => a.key)
    // It held a version, then went quiet for longer than the limit allows while it restarted.
    await edge('restarted')()
    const stale = sql`clock_timestamp() - make_interval(secs => ${EDGE_BEHIND_MS / 1000 + 1})`
    await h.db
      .update(schema.edges)
      .set({ syncedTo: stale, seenAt: sql`clock_timestamp()` })
      .where(eq(schema.edges.edgeId, 'restarted'))
    await h.app.edge.seen('restarted', null, true, new Date())
    expect(await alerted()).not.toContain('edge_behind')

    // Still behind once the grace has passed: reported.
    const old = new Date(Date.now() - EDGE_RESTART_GRACE_MS - SECOND_MS)
    await h.db.update(schema.edges).set({ startedAt: old }).where(eq(schema.edges.edgeId, 'restarted'))
    await h.app.edge.seen('restarted', null, true, old)
    expect(await alerted()).toContain('edge_behind')
  }, 30_000)

  test('restarts inside the grace of the last do not extend it, so a crash loop is reported', async () => {
    const startedAt = async () =>
      (
        await h.db
          .select({ at: schema.edges.startedAt })
          .from(schema.edges)
          .where(eq(schema.edges.edgeId, 'loops'))
      )[0]?.at?.getTime() ?? 0
    await h.app.edge.seen('loops', null, true, new Date(Date.now() - 30 * SECOND_MS))
    const first = await startedAt()
    // It restarts again within the grace: the start that counts stays the first.
    await h.app.edge.seen('loops', null, true, new Date())
    expect(await startedAt()).toBe(first)
    // Once the grace has passed, the next restart is a new start.
    await h.db
      .update(schema.edges)
      .set({ startedAt: new Date(Date.now() - EDGE_RESTART_GRACE_MS - SECOND_MS) })
      .where(eq(schema.edges.edgeId, 'loops'))
    const again = new Date()
    await h.app.edge.seen('loops', null, true, again)
    expect(Math.abs((await startedAt()) - +again)).toBeLessThan(SECOND_MS)
  }, 30_000)

  test('a server never waits on the edges longer than the limit, and is told once it has', async () => {
    const owner = await h.user()
    const never = stuck('never')
    await never()
    const id = await running(owner)
    await never()
    expect(await shown(owner, id)).toBe('starting')

    await h.db
      .update(schema.minecraftServers)
      .set({ readyAt: sql`clock_timestamp() - make_interval(secs => ${EDGE_BEHIND_MS / 1000 + 1})` })
      .where(eq(schema.minecraftServers.id, id))
    expect(await shown(owner, id)).toBe('running')
    const before = (await h.server(id)).version
    await never()
    expect((await h.server(id)).version).toBe(before + 1)
  }, 30_000)
})
