// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server-list ping may start a sleeping server whose start is a boot, before anyone joins, and
 * the list says it is waking (`ping-wake.ts`). Anything can ping, so these are mostly about when
 * it doesn't.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { runHoursSince } from '../accounts/persistence.ts'
import type { Actor } from '../actor.ts'
import * as metered from '../billing/chip-in-meter.ts'
import { PING_WAKE_KEY, replacePresence } from '../servers/usage.ts'
import { tuning } from '../tuning.ts'
import { NOWHERE } from './service.ts'

/** A server made, run, and put to sleep; its memory kept where `suspends`. */
async function sleeping(h: Harness, suspends = false) {
  h.runtime.sleeps.on = suspends
  const owner = await h.user()
  const created = await h.create(owner)
  await h.until(created.id, 'running')
  await h.settled(created.id)
  await h.app.servers.stop(owner, created.id, randomUUID(), 'idle')
  await h.until(created.id, 'stopped')
  await h.settled(created.id)
  h.runtime.sleeps.on = false
  return { owner, id: created.id, hostname: `${created.slug}.play.test` }
}

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

/**
 * A run a ping woke, an hour long, with a player the server itself saw half an hour in where
 * `joined`; what it added to its owner's hours.
 */
async function hourOfPingRun(h: Harness, joined: boolean) {
  const { owner, id, hostname } = await sleeping(h)
  const before = await runHoursSince(h.db, owner.userId, new Date(0), new Date())
  expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: true })
  await h.until(id, 'running')
  await h.settled(id)
  if (joined) await replacePresence(h.db, id, [{ uuid: randomUUID(), name: 'Steve' }], new Date())
  const run = await anHourIn(h, id)
  await h.app.servers.stop(owner, id, randomUUID(), 'idle')
  await h.until(id, 'stopped')
  await h.settled(id)
  return { run, hours: (await runHoursSince(h.db, owner.userId, new Date(0), new Date())) - before }
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
    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: true })
    const [start] = await pingWakes(h, id)
    expect(start).toMatchObject({ kind: 'start', requestedBy: 'system:wake' })
    await h.until(id, 'running')
    await h.settled(id)
    // A woken run: nobody joined, so the probation, not the plan's idle time, puts it back to sleep.
    expect(await lastRunWoken(h, id)).toBe(true)
    // Running: the next ping reaches the server itself, and nothing more is started.
    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: false })
    expect(await pingWakes(h, id)).toHaveLength(1)
  }, 30_000)

  test('a server that kept its memory is left to the join, which resumes it as fast', async () => {
    const { id, hostname } = await sleeping(h, true)
    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: false })
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    expect(await pingWakes(h, id)).toHaveLength(0)
  }, 30_000)

  test('after a ping wake nobody joined, pings leave the server asleep until the hold is over, or someone plays', async () => {
    const { owner, id, hostname } = await sleeping(h)
    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: true })
    await backToSleep(h, owner, id)

    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: false })
    expect((await h.server(id)).lifecycle.status).toBe('stopped')

    // The hold counts from that wake: once it is over, a ping wakes the server again.
    const [wake] = await pingWakes(h, id)
    await h.db
      .update(schema.serverOperations)
      .set({ createdAt: new Date(Date.now() - tuning().abuse.pingWakeHoldHours * HOUR_MS - MINUTE_MS) })
      .where(eq(schema.serverOperations.id, wake?.id ?? ''))
    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: true })
    await backToSleep(h, owner, id)

    // Somebody played since the last one: pings are worth answering again at once.
    await h.db
      .insert(schema.serverActivity)
      .values({ serverId: id, lastPlayerAt: new Date() })
      .onConflictDoUpdate({ target: schema.serverActivity.serverId, set: { lastPlayerAt: new Date() } })
    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: true })
    expect(await pingWakes(h, id)).toHaveLength(3)
    await h.until(id, 'running')
    await h.settled(id)
  }, 40_000)

  test('nothing is started for a server its owner can’t start, an unknown name, or one woken all hour', async () => {
    expect(await h.app.edge.pingWake('nobody-here.play.test')).toEqual({ waking: false })

    const { owner, id, hostname } = await sleeping(h)
    await h.app.accounts.suspend(admin, owner.userId, 'testing ping wakes')
    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: false })
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    await h.app.accounts.reinstate(admin, owner.userId)

    await flooded(h, id)
    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: false })
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
      expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: false })
      expect(await pingWakes(h, id)).toHaveLength(0)
    } finally {
      month.mockRestore()
    }
  }, 30_000)

  test('a run a ping woke counts toward the owner’s hours from the first join, not from its start', async () => {
    const { run, hours } = await hourOfPingRun(h, true)
    expect(run).toMatchObject({ pinged: true, joinedAt: expect.any(Date) })
    // Half an hour, from the join: not the hour since it started.
    expect(hours).toBeCloseTo(0.5, 1)
  }, 30_000)

  test('a run a ping woke that nobody joined counts nothing toward the owner’s hours', async () => {
    const { run, hours } = await hourOfPingRun(h, false)
    expect(run).toEqual({ pinged: true, joinedAt: null })
    expect(hours).toBeCloseTo(0, 4)
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
    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: true })

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
    expect(await h.app.edge.pingWake(hostname)).toEqual({ waking: true })
  }, 30_000)
})
