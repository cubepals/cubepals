// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'
import { IDLE_GRACE_MS, WAKE_PROBATION_MS } from '../operations/schedules.ts'
import { destinationOf, NOWHERE } from './service.ts'

const MINUTE = 60_000

test('a destination the edge dials writes an IPv6 host in brackets, and a name as it is', () => {
  expect(destinationOf({ host: 'bly-dev-2a.flycast', port: 25565 })).toBe('bly-dev-2a.flycast:25565')
  expect(destinationOf({ host: 'fdaa:0:1::3', port: 25565 })).toBe('[fdaa:0:1::3]:25565')
  expect(destinationOf({ host: '10.0.0.7', port: 25565 })).toBe('10.0.0.7:25565')
})

// The application side of the edge (§12): a join wakes a sleeping server through the same checks
// as the Start button, on its primary name or an alias; an unknown name wakes nothing; the edge's
// sessions are presence hints; and idle stops wait for presence after a restart (§15.5).
describe.skipIf(!hasDatabase)('edge', () => {
  let h: Harness
  let admin: Actor

  beforeAll(async () => {
    h = await startHarness()
    admin = { kind: 'admin', userId: (await h.user('Admin')).userId }
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const sleeping = async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.app.servers.stop(owner, created.id, randomUUID(), 'idle')
    await h.until(created.id, 'stopped')
    await h.settled(created.id)
    return { owner, id: created.id, slug: created.slug }
  }

  test('joining a sleeping server wakes it, on its name or an alias, and says where to send the player', async () => {
    const { id, slug } = await sleeping()
    const woken = await h.app.edge.wake(`${slug}.play.test`)
    expect(woken).toMatchObject({ outcome: 'ready', destination: expect.stringContaining(':') })
    expect((await h.server(id)).lifecycle.status).toBe('running')
    const [start] = (await h.operations(id)).filter((o) => o.kind === 'start')
    expect(start?.requestedBy).toBe('system:wake')

    // Running already: the alias answers with the same destination at once.
    expect(await h.app.edge.wake(`${slug}.play.old.test`)).toEqual(woken)
    const { routes } = await h.app.edge.routes()
    expect(routes.filter((r) => r.hostname.startsWith(`${slug}.`)).map((r) => r.hostname)).toEqual([
      `${slug}.play.old.test`,
      `${slug}.play.test`,
    ])
  }, 30_000)

  test('a wake nobody joins is stopped in minutes, not left running for the whole idle window', async () => {
    const { id, slug } = await sleeping()
    await h.app.edge.wake(`${slug}.play.test`)
    await h.until(id, 'running')
    await h.settled(id)

    // Presence is trusted only once it has been read again after a restart, so every clock here
    // starts past that grace.
    const woke = Date.now() + IDLE_GRACE_MS
    // Nobody joined, so it goes as soon as the probation is up — long before the plan's own
    // idle window, which is ten minutes on free and fifteen on Plus.
    expect(
      await h.app.schedules.evaluateIdle(await h.server(id), new Date(woke + WAKE_PROBATION_MS + 1_000)),
    ).toBe('nobody_joined')
    await h.until(id, 'stopped')
    await h.settled(id)
  }, 40_000)

  test('a wake somebody did join keeps the whole idle window it is entitled to', async () => {
    const { id, slug } = await sleeping()
    await h.app.edge.wake(`${slug}.play.test`)
    await h.until(id, 'running')
    await h.settled(id)
    // A player arrived, which is what the probation was waiting for. They were last seen a
    // minute before the clock below, so the plan's own idle window is nowhere near up.
    const woke = Date.now() + IDLE_GRACE_MS
    const at = new Date(woke + WAKE_PROBATION_MS - 60_000)
    await h.db
      .insert(schema.serverActivity)
      .values({ serverId: id, lastPlayerAt: at })
      .onConflictDoUpdate({ target: schema.serverActivity.serverId, set: { lastPlayerAt: at } })

    expect(
      await h.app.schedules.evaluateIdle(await h.server(id), new Date(woke + WAKE_PROBATION_MS + 1_000)),
    ).toBe('recently_active')
    expect((await h.server(id)).lifecycle.status).toBe('running')
  }, 40_000)

  test('a wake waits once in all: what waiting for a rest took comes off the wait for the start', async () => {
    const { id, slug } = await sleeping()
    // Being put to rest as the join arrives. The rest is called off two seconds later, and the
    // join goes on to wake it, with what is left of its one wait.
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'storing' })
      .where(eq(schema.minecraftServers.id, id))
    const waits: number[] = []
    const waitFor = h.app.waiter.waitFor.bind(h.app.waiter)
    const waiter = spyOn(h.app.waiter, 'waitFor').mockImplementation(async (serverId, targets, timeoutMs) => {
      waits.push(timeoutMs)
      if (waits.length > 1) return waitFor(serverId, targets, timeoutMs)
      await Bun.sleep(2_000)
      await h.db
        .update(schema.minecraftServers)
        .set({ status: 'stopped' })
        .where(eq(schema.minecraftServers.id, id))
      return 'stopped'
    })
    try {
      expect(await h.app.edge.wake(`${slug}.play.test`)).toMatchObject({ outcome: 'ready' })
    } finally {
      waiter.mockRestore()
    }
    // The harness's wakes wait 5 s at most, as the edge's do 25 s.
    expect(waits).toHaveLength(2)
    expect(waits[0]).toBeLessThanOrEqual(5_000)
    expect(waits[1]).toBeLessThanOrEqual(3_000)
    await h.settled(id)
  }, 30_000)

  test('a server woken over and over in an hour stops being woken at all', async () => {
    const { id, slug } = await sleeping()
    // Twelve runs a connection woke and that are over, all within the hour: what a flood leaves.
    for (let i = 1; i <= 12; i++) {
      const startedAt = new Date(Date.now() - i * 120_000)
      await h.db.insert(schema.powerIntervals).values({
        serverId: id,
        memoryTier: '3g',
        startedAt,
        stoppedAt: new Date(startedAt.getTime() + 60_000),
        woken: true,
      })
    }
    expect(await h.app.edge.wake(`${slug}.play.test`)).toEqual({ outcome: 'denied', reason: 'quota' })
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
  }, 30_000)

  test('an unknown name wakes nothing, and a join is refused as the Start button would be', async () => {
    expect(await h.app.edge.wake('nobody-here.play.test')).toEqual({ outcome: 'denied', reason: 'unknown' })
    expect(await h.app.edge.wake('elsewhere.example.com')).toEqual({ outcome: 'denied', reason: 'unknown' })

    // A server in the trash still holds its address: its players hear it was deleted.
    const trashed = await sleeping()
    await h.app.servers.deleteServer(trashed.owner, trashed.id, (await h.server(trashed.id)).name)
    expect(await h.app.edge.wake(`${trashed.slug}.play.test`)).toEqual({
      outcome: 'denied',
      reason: 'deleted',
    })

    const { owner, id, slug } = await sleeping()
    await h.app.accounts.suspend(admin, owner.userId, 'testing wakes')
    expect(await h.app.edge.wake(`${slug}.play.test`)).toEqual({ outcome: 'denied', reason: 'suspended' })
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    await h.app.accounts.reinstate(admin, owner.userId)
  }, 30_000)

  test('a restarting server is routed as restarting, and a join waits for it without starting it again', async () => {
    const { owner, id, slug } = await sleeping()
    const stateOf = async () =>
      (await h.app.edge.routes()).routes.find((r) => r.hostname === `${slug}.play.test`)?.state
    expect(await stateOf()).toBe('asleep')
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(await stateOf()).toBeUndefined()

    const release = h.runtime.holdStops(1)
    try {
      await h.app.servers.restart(owner, id, randomUUID())
      await h.until(id, 'stopping')
      expect(await stateOf()).toBe('restarting')

      // Longer than a joining client waits: the edge is told it is still restarting.
      expect(await h.app.edge.wake(`${slug}.play.test`)).toEqual({ outcome: 'restarting' })

      const joining = h.app.edge.wake(`${slug}.play.test`)
      release()
      expect(await joining).toMatchObject({ outcome: 'ready', destination: expect.stringContaining(':') })
      await h.settled(id)
      expect(await stateOf()).toBeUndefined()
      // The restart brought it back; no join started it a second time.
      const kinds = (await h.operations(id)).map((o) => o.kind)
      expect(kinds.filter((k) => k === 'start')).toHaveLength(1)
      expect(kinds).toContain('restart')
    } finally {
      release()
    }

    // A restore of a running server is a restart too, though nothing routes to it to play.
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [backup] = await h.db.select().from(schema.backups).where(eq(schema.backups.serverId, id))
    if (backup === undefined) throw new Error('No backup was taken')
    const restoring = h.runtime.holdStops(1)
    try {
      await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false })
      await h.until(id, 'restoring')
      expect(await stateOf()).toBe('restarting')
    } finally {
      restoring()
    }
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    expect(await stateOf()).toBeUndefined()
  }, 60_000)

  test('the edge’s sessions are presence hints for the right server, and nonsense is ignored', async () => {
    const { owner, id, slug } = await sleeping()
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    const player = { name: 'Alex', uuid: '5f2c5d3a9b6e4f10a1b2c3d4e5f60718' }
    const at = new Date().toISOString()
    await h.app.edge.recordSession({
      edgeId: 'e1',
      hostname: `${slug}.play.test`,
      event: 'connect',
      player,
      at,
    })
    const online = await h.db
      .select()
      .from(schema.serverPresence)
      .where(eq(schema.serverPresence.serverId, id))
    expect(online).toMatchObject([
      { playerUuid: '5f2c5d3a-9b6e-4f10-a1b2-c3d4e5f60718', playerName: 'Alex', source: 'edge' },
    ])
    // An idle hint while someone is on changes nothing.
    expect(await h.app.edge.idleHint(`${slug}.play.test`)).toBe('players_online')
    // Nobody's name, a made-up id, or a name that isn't ours change nothing.
    await h.app.edge.recordSession({
      edgeId: 'e1',
      hostname: `${slug}.play.test`,
      event: 'connect',
      player: { name: 'Bad', uuid: 'not-a-uuid' },
      at,
    })
    await h.app.edge.recordSession({
      edgeId: 'e1',
      hostname: 'nobody.play.test',
      event: 'connect',
      player,
      at,
    })
    expect(
      await h.db.select().from(schema.serverPresence).where(eq(schema.serverPresence.serverId, id)),
    ).toHaveLength(1)

    await h.app.edge.recordSession({
      edgeId: 'e1',
      hostname: `${slug}.play.test`,
      event: 'disconnect',
      player,
      at,
    })
    expect(
      await h.db.select().from(schema.serverPresence).where(eq(schema.serverPresence.serverId, id)),
    ).toHaveLength(0)
  }, 30_000)

  test('joins are counted per play domain, so an alias can go once nobody uses it (§11)', async () => {
    const { owner, id, slug } = await sleeping()
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    const counts = async () =>
      new Map((await h.app.platform.view(admin)).playDomains.map((d) => [d.domain, d]))
    const before = await counts()
    expect([...before.values()].map((d) => [d.domain, d.alias])).toEqual([
      ['play.test', false],
      ['play.old.test', true],
    ])
    const player = { name: 'Steve', uuid: '8667ba71b85a4004af54457a9734eed7' }
    const at = new Date().toISOString()
    for (const hostname of [`${slug}.play.old.test`, `${slug}.play.test`, `${slug}.play.test`])
      await h.app.edge.recordSession({ edgeId: 'e1', hostname, event: 'connect', player, at })
    // A disconnect is no join.
    await h.app.edge.recordSession({
      edgeId: 'e1',
      hostname: `${slug}.play.test`,
      event: 'disconnect',
      player,
      at,
    })
    const after = await counts()
    expect((after.get('play.test')?.joins ?? 0) - (before.get('play.test')?.joins ?? 0)).toBe(2)
    expect((after.get('play.old.test')?.joins ?? 0) - (before.get('play.old.test')?.joins ?? 0)).toBe(1)
    expect(after.get('play.old.test')?.lastJoinAt).not.toBeNull()
  }, 30_000)

  test('an idle server stops once its plan’s idle time passes, but not in the grace after a restart', async () => {
    const { owner, id } = await sleeping()
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    // Running for two hours, and nobody seen since: past the free plan's 15 minutes.
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: sql`now() - interval '2 hours'` })
      .where(eq(schema.powerIntervals.serverId, id))
    await h.db.delete(schema.serverActivity).where(eq(schema.serverActivity.serverId, id))

    // Just after this process started, presence may simply not have been read yet.
    await h.app.schedules.idleCheck(new Date(Date.now() + MINUTE))
    expect(await h.app.edge.idleHint(`${(await h.server(id)).slug}.play.test`)).toBe('grace')
    expect((await h.server(id)).lifecycle.status).toBe('running')

    // Past the grace, the plan's idle time decides, whether the check or the edge's hint asks.
    await h.app.schedules.idleCheck(new Date(Date.now() + IDLE_GRACE_MS + MINUTE))
    const stopped = await h.until(id, 'stopped')
    expect(stopped.lifecycle.stopReason).toBe('idle')
    expect(await h.app.edge.idleHint(`${stopped.slug}.play.test`)).toBe('not_running')
  }, 30_000)
})

// A provider whose addresses move (Boat): each start brings compute back somewhere else, and a
// stopped server's old address may be someone else's by then.
describe.skipIf(!hasDatabase)('edge, where addresses move', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({ movingAddresses: true })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const routeOf = async (slug: string) =>
    (await h.app.edge.routes()).routes.find((r) => r.hostname === `${slug}.play.test`)?.destination

  test('a sleeping server routes nowhere, and each wake answers where it runs now', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    const first = await routeOf(created.slug)
    expect(first).not.toBe(NOWHERE)

    await h.app.servers.stop(owner, created.id, randomUUID(), 'idle')
    await h.until(created.id, 'stopped')
    await h.settled(created.id)
    expect(await routeOf(created.slug)).toBe(NOWHERE)

    const woken = await h.app.edge.wake(`${created.slug}.play.test`)
    await h.settled(created.id)
    expect(woken).toMatchObject({ outcome: 'ready' })
    const second = await routeOf(created.slug)
    expect(woken).toEqual({ outcome: 'ready', destination: second ?? '' })
    expect(second).not.toBe(first)
    expect(second).not.toBe(NOWHERE)
  }, 30_000)

  test('a restart keeps the handle its start came back with, so the route follows it', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    const before = await routeOf(created.slug)

    await h.app.servers.restart(owner, created.id, randomUUID())
    await h.settled(created.id)
    expect((await h.server(created.id)).lifecycle.status).toBe('running')
    const after = await routeOf(created.slug)
    expect(after).not.toBe(before)
    expect(after).not.toBe(NOWHERE)
  }, 30_000)

  test('a join that finds no room goes back to sleep, says why, and the next join wakes it', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.app.servers.stop(owner, created.id, randomUUID(), 'idle')
    await h.until(created.id, 'stopped')
    await h.settled(created.id)

    // On Boat, the plan's starts for the day are spent.
    h.runtime.full("the plan's starts for this day are used up")
    expect(await h.app.edge.wake(`${created.slug}.play.test`)).toEqual({ outcome: 'starting' })
    await h.settled(created.id)
    const asleep = await h.server(created.id)
    expect(asleep.lifecycle).toMatchObject({ status: 'stopped', stopReason: 'idle', failure: null })
    const start = (await h.operations(created.id)).filter((o) => o.kind === 'start').at(-1)
    expect(start).toMatchObject({
      status: 'failed',
      error: 'There was no room for it where it runs just then. Try again in a few minutes.',
    })
    expect(await routeOf(created.slug)).toBe(NOWHERE)

    h.runtime.full(null)
    expect(await h.app.edge.wake(`${created.slug}.play.test`)).toMatchObject({ outcome: 'ready' })
    expect((await h.server(created.id)).lifecycle.status).toBe('running')
  }, 30_000)

  test('a running server the provider moved is routed where it is, once reconcile has seen it', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    const before = await routeOf(created.slug)

    h.runtime.move(created.id)
    await h.app.schedules.reconcile()
    const after = await routeOf(created.slug)
    expect(after).not.toBe(before)
    expect(after).not.toBe(NOWHERE)
    expect((await h.server(created.id)).lifecycle.status).toBe('running')
  }, 30_000)
})
