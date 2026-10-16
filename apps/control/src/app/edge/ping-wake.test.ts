// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server-list ping from a network the server's own players joined it from may start it, where
 * its start is a boot, before anyone joins, and the list says it is waking (`ping-wake.ts`,
 * `known-addresses.ts`). Anything can ping, so these are mostly about when it doesn't.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { runHoursSince, runUnitsSince } from '../accounts/persistence.ts'
import type { Actor } from '../actor.ts'
import * as metered from '../billing/chip-in-meter.ts'
import { PING_WAKE_KEY, replacePresence } from '../servers/usage.ts'
import { tuning } from '../tuning.ts'
import { NOWHERE } from './service.ts'

/** Where a player of the server's own joined it from. */
const PLAYER = '203.0.113.7'
/** Somewhere nobody joined it from: a scanner, a site that lists servers. */
const STRANGER = '198.51.100.9'

/**
 * A join from `address` that ends, as the edge reports it, with the player on the server by its
 * own reading where `seen`: a player the server turned away is never on it.
 */
async function joinFrom(h: Harness, id: string, hostname: string, address: string, seen = true) {
  const player = { uuid: randomUUID(), name: 'Alex' }
  if (seen) await replacePresence(h.db, id, [player], new Date())
  const at = new Date().toISOString()
  await h.app.edge.recordSession({ edgeId: 'edge-1', hostname, event: 'disconnect', player, address, at })
  await replacePresence(h.db, id, [], new Date())
}

/**
 * A server made, run, played on from `from` (by nobody where null), and put to sleep; its memory
 * kept where `suspends`.
 */
async function sleeping(h: Harness, suspends = false, from: string | null = PLAYER) {
  h.runtime.sleeps.on = suspends
  const owner = await h.user()
  const created = await h.create(owner)
  const hostname = `${created.slug}.play.test`
  await h.until(created.id, 'running')
  await h.settled(created.id)
  if (from !== null) await joinFrom(h, created.id, hostname, from)
  await h.app.servers.stop(owner, created.id, randomUUID(), 'idle')
  await h.until(created.id, 'stopped')
  await h.settled(created.id)
  h.runtime.sleeps.on = false
  return { owner, id: created.id, hostname }
}

const knownRows = (h: Harness, id: string) =>
  h.db.select().from(schema.knownAddresses).where(eq(schema.knownAddresses.serverId, id))

const pingWakes = async (h: Harness, id: string) =>
  (await h.operations(id)).filter((o) => o.idempotencyKey.startsWith(`start:${PING_WAKE_KEY}`))

const routeOf = async (h: Harness, hostname: string) =>
  (await h.app.edge.routes()).routes.find((r) => r.hostname === hostname)

/** Up, then back to sleep, as the probation puts a woken run nobody joined. */
async function backToSleep(h: Harness, owner: Actor, id: string) {
  await h.until(id, 'running')
  await h.settled(id)
  await h.app.servers.stop(owner, id, randomUUID(), 'idle')
  await h.until(id, 'stopped')
  await h.settled(id)
}

/** As many woken runs as an hour allows, all over: what a flood of joins leaves. */
async function flooded(h: Harness, id: string) {
  const wakes = tuning().abuse.wakesPerHour
  for (let i = 1; i <= wakes; i++) {
    const startedAt = new Date(Date.now() - (i * HOUR_MS) / (wakes + 2))
    await h.db.insert(schema.powerIntervals).values({
      serverId: id,
      memoryTier: '3g',
      startedAt,
      stoppedAt: new Date(startedAt.getTime() + MINUTE_MS),
      woken: true,
    })
  }
}

/** Whether the server's newest run is a woken one. */
async function lastRunWoken(h: Harness, id: string) {
  const runs = await h.db
    .select({ woken: schema.powerIntervals.woken })
    .from(schema.powerIntervals)
    .where(eq(schema.powerIntervals.serverId, id))
    .orderBy(schema.powerIntervals.startedAt)
  return runs.at(-1)?.woken
}

/** The server's open run, moved back so it began an hour ago, and its join, where one was, half an hour ago. */
async function anHourIn(h: Harness, id: string) {
  const runs = schema.powerIntervals
  const now = Date.now()
  const [run] = await h.db
    .update(runs)
    .set({
      startedAt: new Date(now - HOUR_MS),
      joinedAt: sql`case when ${runs.joinedAt} is null then null else ${new Date(now - HOUR_MS / 2)}::timestamptz end`,
    })
    .where(and(eq(runs.serverId, id), isNull(runs.stoppedAt)))
    .returning({ pinged: runs.pinged, joinedAt: runs.joinedAt })
  return run
}

/** What the owner's hours read in the app, and on the meter that bills them. */
async function counted(h: Harness, ownerId: string) {
  const now = new Date()
  return {
    hours: await runHoursSince(h.db, ownerId, new Date(0), now),
    shown: await runUnitsSince(h.db, ownerId, new Date(0), now),
    metered: await metered.meteredUnitsSince(h.db, ownerId, new Date(0), now),
  }
}

/**
 * A run a ping woke, an hour long, with a player the server itself saw half an hour in where
 * `joined`; what it added to its owner's hours, as the app shows them and as the meter counts them.
 */
async function hourOfPingRun(h: Harness, joined: boolean) {
  const { owner, id, hostname } = await sleeping(h)
  const before = await counted(h, owner.userId)
  expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: true })
  await h.until(id, 'running')
  await h.settled(id)
  if (joined) await replacePresence(h.db, id, [{ uuid: randomUUID(), name: 'Steve' }], new Date())
  const run = await anHourIn(h, id)
  await h.app.servers.stop(owner, id, randomUUID(), 'idle')
  await h.until(id, 'stopped')
  await h.settled(id)
  const after = await counted(h, owner.userId)
  return {
    run,
    hours: after.hours - before.hours,
    shown: after.shown - before.shown,
    metered: after.metered - before.metered,
  }
}

describe.skipIf(!hasDatabase)('a ping wakes a server early', () => {
  let h: Harness
  let admin: Actor

  beforeAll(async () => {
    h = await startHarness()
    admin = { kind: 'admin', userId: (await h.user('Admin')).userId }
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a ping starts a server whose sleep stopped it, as a woken run, and says it is waking', async () => {
    const { id, hostname } = await sleeping(h)
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: true })
    const [start] = await pingWakes(h, id)
    expect(start).toMatchObject({ kind: 'start', requestedBy: 'system:wake' })
    await h.until(id, 'running')
    await h.settled(id)
    // A woken run: nobody joined, so the probation, not the plan's idle time, puts it back to sleep.
    expect(await lastRunWoken(h, id)).toBe(true)
    // Running: the next ping reaches the server itself, and nothing more is started.
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: false })
    expect(await pingWakes(h, id)).toHaveLength(1)
  }, 30_000)

  test('a server that kept its memory is left to the join, which resumes it as fast', async () => {
    const { id, hostname } = await sleeping(h, true)
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: false })
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    expect(await pingWakes(h, id)).toHaveLength(0)
  }, 30_000)

  test('after a ping wake nobody joined, pings leave the server asleep until the hold is over, or someone plays', async () => {
    const { owner, id, hostname } = await sleeping(h)
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: true })
    await backToSleep(h, owner, id)

    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: false })
    expect((await h.server(id)).lifecycle.status).toBe('stopped')

    // The hold counts from that wake: once it is over, a ping wakes the server again.
    const [wake] = await pingWakes(h, id)
    await h.db
      .update(schema.serverOperations)
      .set({ createdAt: new Date(Date.now() - tuning().abuse.pingWakeHoldHours * HOUR_MS - MINUTE_MS) })
      .where(eq(schema.serverOperations.id, wake?.id ?? ''))
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: true })
    await backToSleep(h, owner, id)

    // Somebody played since the last one: pings are worth answering again at once.
    await h.db
      .insert(schema.serverActivity)
      .values({ serverId: id, lastPlayerAt: new Date() })
      .onConflictDoUpdate({ target: schema.serverActivity.serverId, set: { lastPlayerAt: new Date() } })
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: true })
    expect(await pingWakes(h, id)).toHaveLength(3)
    await h.until(id, 'running')
    await h.settled(id)
  }, 40_000)

  test('nothing is started for a server its owner can’t start, an unknown name, or one woken all hour', async () => {
    expect(await h.app.edge.pingWake('nobody-here.play.test')).toEqual({ waking: false })

    const { owner, id, hostname } = await sleeping(h)
    await h.app.accounts.suspend(admin, owner.userId, 'testing ping wakes')
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: false })
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    await h.app.accounts.reinstate(admin, owner.userId)

    await flooded(h, id)
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: false })
    expect(await pingWakes(h, id)).toHaveLength(0)
  }, 30_000)

  test('an owner past their included hours is woken only by a join, never by a ping', async () => {
    const { id, hostname } = await sleeping(h)
    const month = spyOn(metered, 'meteredMonth').mockResolvedValue({
      start: new Date(Date.now() - HOUR_MS),
      next: new Date(Date.now() + HOUR_MS),
      included: 10,
      carried: 2,
      units: 12,
    })
    try {
      expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: false })
      expect(await pingWakes(h, id)).toHaveLength(0)
    } finally {
      month.mockRestore()
    }
  }, 30_000)

  test('a server on its way up is routed as waking: starting, or its world back from rest', async () => {
    const { id, hostname } = await sleeping(h)
    expect(await routeOf(h, hostname)).toMatchObject({ state: 'asleep' })
    expect((await routeOf(h, hostname))?.waking).toBeUndefined()

    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'starting' })
      .where(eq(schema.minecraftServers.id, id))
    expect(await routeOf(h, hostname)).toMatchObject({ state: 'asleep', waking: true })
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: true })

    // Back from rest: nothing to dial until it is, but the list hears it waking.
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'restoring' })
      .where(eq(schema.minecraftServers.id, id))
    expect(await routeOf(h, hostname)).toBeUndefined()
    await h.db.insert(schema.serverOperations).values({
      id: randomUUID(),
      serverId: id,
      kind: 'unstore',
      status: 'running',
      input: {},
      requestedBy: 'system:wake',
      idempotencyKey: randomUUID(),
    })
    expect(await routeOf(h, hostname)).toMatchObject({ state: 'asleep', waking: true, destination: NOWHERE })
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: true })
  }, 30_000)
})

describe.skipIf(!hasDatabase)('only its own players’ networks wake a server with a ping', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a ping from anywhere its players didn’t join from leaves it asleep, and a join still wakes it', async () => {
    const { id, hostname } = await sleeping(h)
    expect(await h.app.edge.pingWake(hostname, STRANGER)).toEqual({ waking: false })
    // An edge from before pings said where they came from.
    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: false })
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    expect(await pingWakes(h, id)).toHaveLength(0)
    // Nobody is turned away: the stranger's join wakes it as always.
    expect(await h.app.edge.wake(hostname)).toMatchObject({ outcome: 'ready' })
    await h.settled(id)
  }, 30_000)

  test('a network counts once a join from it ends with the server having seen the player on', async () => {
    const { owner, id, hostname } = await sleeping(h, false, null)
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: false })

    // A client the server never let on (no account, not on the whitelist) leaves nothing behind.
    await h.app.edge.wake(hostname)
    await h.settled(id)
    await joinFrom(h, id, hostname, STRANGER, false)
    // A player it saw does, as their network: a phone's IPv6 address changes within it.
    await joinFrom(h, id, hostname, '2001:db8:1:2::a')
    const rows = await knownRows(h, id)
    expect(rows).toHaveLength(1)
    // Kept only as a hash: not the address, nor its network.
    expect(JSON.stringify(rows)).not.toContain('2001:db8')
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)

    expect(await h.app.edge.pingWake(hostname, STRANGER)).toEqual({ waking: false })
    expect(await h.app.edge.pingWake(hostname, '2001:db8:1:2::b')).toEqual({ waking: true })
    await h.until(id, 'running')
    await h.settled(id)
  }, 40_000)

  test('a network its players last joined from too long ago no longer wakes it, and is forgotten', async () => {
    const { id, hostname } = await sleeping(h)
    const long = new Date(Date.now() - tuning().abuse.knownAddressDays * DAY_MS - MINUTE_MS)
    await h.db
      .update(schema.knownAddresses)
      .set({ seenAt: long })
      .where(eq(schema.knownAddresses.serverId, id))
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: false })
    expect(await pingWakes(h, id)).toHaveLength(0)

    expect(await h.app.edge.forgetAddresses()).toBeGreaterThanOrEqual(1)
    expect(await knownRows(h, id)).toHaveLength(0)
  }, 30_000)

  test('a world at rest stays at rest for a ping, even from its own players’ network', async () => {
    const { id, hostname } = await sleeping(h)
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'stored' })
      .where(eq(schema.minecraftServers.id, id))
    expect(await h.app.edge.pingWake(hostname, PLAYER)).toEqual({ waking: false })
    expect((await h.server(id)).lifecycle.status).toBe('stored')
    expect(await pingWakes(h, id)).toHaveLength(0)
  }, 30_000)
})

describe.skipIf(!hasDatabase)('a ping wake nobody joins costs its owner nothing', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a run a ping woke counts toward the owner’s hours from the first join, not from its start', async () => {
    const { run, hours, shown, metered } = await hourOfPingRun(h, true)
    expect(run).toMatchObject({ pinged: true, joinedAt: expect.any(Date) })
    // Half an hour, from the join: not the hour since it started.
    expect(hours).toBeCloseTo(0.5, 1)
    // The meter that bills it counts what the app shows.
    expect(shown).toBeGreaterThan(0)
    expect(metered).toBeCloseTo(shown, 4)
  }, 30_000)

  test('a run a ping woke that nobody joined counts nothing toward the owner’s hours', async () => {
    const { run, hours, shown, metered } = await hourOfPingRun(h, false)
    expect(run).toEqual({ pinged: true, joinedAt: null })
    expect(hours).toBeCloseTo(0, 4)
    expect(shown).toBeCloseTo(0, 4)
    expect(metered).toBeCloseTo(0, 4)
  }, 30_000)
})
