// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How long a wake takes, by its way: the median of the server's own wakes that way once it has
 * enough, else every server's, else nothing (`wake-times.ts`); and what a sleeping server's route
 * says of it to the edge.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { saveMemoryKept } from '../servers/persistence.ts'
import { medianOf, readWakeMedians, WAKE_TIMES_DAYS, WakeTimes, wayOf } from './wake-times.ts'

/** A wake that succeeded, `seconds` long, `daysAgo` days ago: a start by its steps, or an unstore. */
async function woke(
  h: Harness,
  serverId: string,
  way: 'resume' | 'boot' | 'restore',
  seconds: number,
  daysAgo = 1,
) {
  const created = new Date(Date.now() - daysAgo * DAY_MS)
  await h.db.insert(schema.serverOperations).values({
    id: randomUUID(),
    serverId,
    kind: way === 'restore' ? 'unstore' : 'start',
    status: 'succeeded',
    requestedBy: 'system:wake',
    idempotencyKey: randomUUID(),
    steps: [{ step: way === 'resume' ? 'resuming' : 'booting', at: created.toISOString() }],
    createdAt: created,
    startedAt: created,
    finishedAt: new Date(created.getTime() + seconds * SECOND_MS),
  })
}

describe.skipIf(!hasDatabase)('wake times', () => {
  let h: Harness
  const ids: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' }
  let hostnameOfA = ''

  beforeAll(async () => {
    h = await startHarness()
    // An owner each: a Free account runs one server.
    const owners = { a: await h.user('A'), b: await h.user('B'), c: await h.user('C') }
    for (const key of ['a', 'b', 'c'] as const) {
      const made = await h.create(owners[key])
      await h.until(made.id, 'running')
      await h.settled(made.id)
      ids[key] = made.id
      if (key === 'a') hostnameOfA = `${made.slug}.play.test`
    }
    await h.app.servers.stop(owners.a, ids.a, randomUUID(), 'idle')
    await h.until(ids.a, 'stopped')
    await h.settled(ids.a)
    // A's own boots, and its resumes.
    for (const seconds of [30, 40, 50]) await woke(h, ids.a, 'boot', seconds)
    for (const seconds of [2, 2, 3]) await woke(h, ids.a, 'resume', seconds)
    // Five rests come back across two servers: two of B's, three of C's.
    for (const seconds of [60, 70]) await woke(h, ids.b, 'restore', seconds)
    for (const seconds of [80, 90, 100]) await woke(h, ids.c, 'restore', seconds)
    // Too old to count.
    await woke(h, ids.b, 'boot', 500, WAKE_TIMES_DAYS + 1)
  })
  afterAll(() => h?.close())

  test('a server with three wakes one way goes by its own median', async () => {
    const medians = await readWakeMedians(h.db)
    expect(medianOf(medians, ids.a, 'boot')).toBe(40)
    expect(medianOf(medians, ids.a, 'resume')).toBe(2)
    expect(medianOf(medians, ids.c, 'restore')).toBe(90)
  })

  test('one with fewer goes by every server’s, once there are five', async () => {
    const medians = await readWakeMedians(h.db)
    expect(medianOf(medians, ids.b, 'restore')).toBe(80)
    // Three boots and three resumes in all, all A's: too few for anyone else, so nothing.
    expect(medianOf(medians, ids.b, 'boot')).toBeNull()
    expect(medianOf(medians, ids.b, 'resume')).toBeNull()
  })

  test('the way a sleeping server would wake now', () => {
    expect(wayOf('stopped', true)).toBe('resume')
    expect(wayOf('stopped', false)).toBe('boot')
    expect(wayOf('stored', false)).toBe('restore')
    expect(wayOf('restoring', false)).toBe('restore')
  })

  test('the medians are read once, then kept', async () => {
    let now = 0
    const times = new WakeTimes(h.db, () => now)
    const first = times.medians()
    expect(times.medians()).toBe(first)
    now += 11 * MINUTE_MS
    expect(times.medians()).not.toBe(first)
  })

  test('a read that fails gives none, and is tried again', async () => {
    let fail = true
    const db = new Proxy(h.db, {
      get: (target, key, receiver) =>
        key === 'execute' && fail
          ? () => Promise.reject(new Error('no database'))
          : Reflect.get(target, key, receiver),
    })
    const times = new WakeTimes(db, () => 0)
    const none = await times.medians()
    expect(none.all.size + none.own.size).toBe(0)
    fail = false
    expect(medianOf(await times.medians(), ids.a, 'boot')).toBe(40)
  })

  test('an asleep server’s route says how long its wake takes', async () => {
    const route = (await h.app.edge.routes()).routes.find((r) => r.hostname === hostnameOfA)
    expect(route?.state).toBe('asleep')
    expect(route?.wakeSeconds).toBe(40)
    const running = (await h.app.edge.routes()).routes.find(
      (r) => r.hostname !== hostnameOfA && r.state === undefined,
    )
    expect(running?.wakeSeconds).toBeUndefined()
  })

  test('a resume its start gave up on is told a boot’s time from then', async () => {
    const wakeOfA = async () =>
      (await h.app.edge.routes()).routes.find((r) => r.hostname === hostnameOfA)?.wakeSeconds
    await saveMemoryKept(h.db, ids.a, true)
    expect(await wakeOfA()).toBe(2)
    // A start under way that resumed, then booted from its disk: the memory was gone.
    const now = new Date()
    const id = randomUUID()
    await h.db.insert(schema.serverOperations).values({
      id,
      serverId: ids.a,
      kind: 'start',
      status: 'running',
      requestedBy: 'system:wake',
      idempotencyKey: randomUUID(),
      steps: [
        { step: 'resuming', at: now.toISOString() },
        { step: 'booting', at: now.toISOString() },
      ],
      createdAt: now,
      startedAt: now,
    })
    try {
      expect(await wakeOfA()).toBe(40)
    } finally {
      await h.db.delete(schema.serverOperations).where(eq(schema.serverOperations.id, id))
      await saveMemoryKept(h.db, ids.a, false)
    }
  })
})
