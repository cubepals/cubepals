// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The capacity locks under a burst, end to end on Postgres and the fake runtime. Creates, starts
 * and undeletes sent at once never pass the platform's room, its running cap or its ceiling, nor
 * one person's plan; free creates close before Plus ones; and creates and starts mixed together
 * all finish, none of them deadlocked. Each person's facts are read under their own lock and the
 * platform's counts under the platform's, so this is what proves the two locks together still
 * count every decision before the next. Every test of a cap fails with one of the two taken out.
 * A create writes its server before it takes the platform's lock, so fifty after one address
 * each get one of their own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { DEFAULT_ROOM } from '../../domain/policy/room.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { countServers } from '../accounts/persistence.ts'
import type { UserActor } from '../actor.ts'
import { AppError } from '../errors.ts'
import { installTuning, tuning } from '../tuning.ts'

const AT_ONCE = 50
/** What creates may fill on the platform: running room above the reserve kept for wakes. */
const ROOM = 12

/**
 * Each request's outcome, all sent at once: what it resolved to when that is a word, else `made`,
 * or the code it was refused with. Anything else, a deadlock among them, is thrown.
 */
async function outcomes(requests: Array<() => Promise<unknown>>): Promise<Map<string, number>> {
  const settled = await Promise.allSettled(requests.map((request) => request()))
  const tally = new Map<string, number>()
  for (const result of settled) {
    if (result.status === 'rejected' && !(result.reason instanceof AppError)) throw result.reason
    const key =
      result.status === 'rejected'
        ? result.reason.code
        : typeof result.value === 'string'
          ? result.value
          : 'made'
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  return tally
}

/** `n` servers for `owner`, made one after another, each running and then stopped. */
async function stoppedServers(h: Harness, owner: UserActor, n: number, name: string): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const { id } = await h.create(owner, { name: `${name} ${i}` })
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    ids.push(id)
  }
  return ids
}

/** Room for everything while servers are made to be stopped, started or deleted later. */
const ROOMY = { maxServers: 500, maxRunningServers: 500 }

const setControls = (h: Harness, controls: Partial<typeof schema.platformControls.$inferInsert>) =>
  h.db.update(schema.platformControls).set(controls)

describe.skipIf(!hasDatabase)('fifty creates at once', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({
      controls: { maxServers: 500, maxRunningServers: ROOM + DEFAULT_ROOM.wakeReserve },
    })
  }, 30_000)

  afterAll(() => h.close())

  test('by fifty people fill the platform’s room exactly, and the rest are told it is full', async () => {
    const people = await Promise.all(Array.from({ length: AT_ONCE }, (_, i) => h.user(`Burst ${i}`, 'plus')))
    const tally = await outcomes(people.map((person, i) => () => h.create(person, { name: `Burst ${i}` })))
    expect(Object.fromEntries(tally)).toEqual({ made: ROOM, platform_full: AT_ONCE - ROOM })
    // The kept index's count is the table's own.
    const [table] = await h.db
      .select({ n: count() })
      .from(schema.minecraftServers)
      .where(and(isNull(schema.minecraftServers.deletedAt), ne(schema.minecraftServers.status, 'stored')))
    expect((await countServers(h.db)).servers).toBe(table?.n ?? -1)
    expect((await countServers(h.db)).servers).toBe(ROOM)
  }, 60_000)

  test('by one person stop at their plan’s limit', async () => {
    const person = await h.user('Many Hands', 'free')
    // Room for all of them on the platform, so only the plan stops them.
    await h.db.update(schema.platformControls).set({ maxRunningServers: 500 })
    const plan = entitlementsFor('free', {})
    const limit = Math.min(plan.maxServers, plan.maxRunning, plan.createsPerHour)
    const tally = await outcomes(
      Array.from({ length: AT_ONCE }, (_, i) => () => h.create(person, { name: `Hand ${i}` })),
    )
    expect(tally.get('made')).toBe(limit)
    expect(
      [...tally.keys()].every((key) => key === 'made' || key === 'limit_reached' || key === 'rate_limited'),
    ).toBe(true)
    const owned = await h.db
      .select({ n: count() })
      .from(schema.minecraftServers)
      .where(eq(schema.minecraftServers.ownerId, person.userId))
    expect(owned[0]?.n).toBe(limit)
  }, 60_000)
})

describe.skipIf(!hasDatabase)('fifty creates of one name at once', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({ controls: ROOMY })
  }, 30_000)

  afterAll(() => h.close())

  test('are all made, each at an address of its own', async () => {
    // A create writes its server before the platform's lock, so two after one address take turns
    // at it, under its own lock, rather than at the platform's.
    const people = await Promise.all(
      Array.from({ length: AT_ONCE }, (_, i) => h.user(`Namesake ${i}`, 'plus')),
    )
    const made = await Promise.all(people.map((person) => h.create(person, { name: 'Same World' })))
    expect(new Set(made.map((server) => server.slug)).size).toBe(AT_ONCE)
  }, 60_000)
})

describe.skipIf(!hasDatabase)('starts at once', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({ controls: ROOMY })
  }, 30_000)

  afterAll(() => h.close())

  test('by twenty people stop at the platform’s running cap', async () => {
    const people = await Promise.all(Array.from({ length: 20 }, (_, i) => h.user(`Waker ${i}`, 'plus')))
    const servers = await Promise.all(people.map((person, i) => stoppedServers(h, person, 1, `Waker ${i}`)))
    expect((await countServers(h.db)).running).toBe(0)
    await setControls(h, { maxRunningServers: 8 })
    const tally = await outcomes(
      people.map((person, i) => () => h.app.servers.start(person, servers[i]?.[0] ?? '', randomUUID())),
    )
    expect(Object.fromEntries(tally)).toEqual({ made: 8, limit_reached: 12 })
    expect((await countServers(h.db)).running).toBe(8)
  }, 120_000)

  test('of one person’s servers stop at their plan’s running cap', async () => {
    await setControls(h, ROOMY)
    const person = await h.user('Eight Worlds', 'plus')
    const standing = schema.accountStanding
    await h.db
      .update(standing)
      .set({ limitOverrides: { maxServers: 8, maxRunning: 8 } })
      .where(eq(standing.userId, person.userId))
    const servers = await stoppedServers(h, person, 8, 'World')
    await h.db
      .update(standing)
      .set({ limitOverrides: { maxServers: 8, maxRunning: 2 } })
      .where(eq(standing.userId, person.userId))
    const tally = await outcomes(servers.map((id) => () => h.app.servers.start(person, id, randomUUID())))
    expect(Object.fromEntries(tally)).toEqual({ made: 2, limit_reached: 6 })
    expect((await countServers(h.db, person.userId)).running).toBe(2)
  }, 120_000)
})

describe.skipIf(!hasDatabase)('undeletes at once', () => {
  /** The most servers the runtime holds; creates leave the wake reserve of it. */
  const CEILING = 12
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({ controls: ROOMY, serverCeiling: CEILING })
  }, 30_000)

  afterAll(() => h.close())

  test('never take the platform past its ceiling', async () => {
    const gone = await Promise.all(Array.from({ length: 10 }, (_, i) => h.user(`Gone ${i}`, 'plus')))
    const trashed = await Promise.all(
      gone.map(async (person, i) => {
        const { id } = await h.create(person, { name: `Gone ${i}` })
        await h.until(id, 'running')
        await h.settled(id)
        await h.app.servers.deleteServer(person, id, `Gone ${i}`)
        await h.settled(id)
        return id
      }),
    )
    const here = await Promise.all(Array.from({ length: 8 }, (_, i) => h.user(`Here ${i}`, 'plus')))
    for (const [i, person] of here.entries()) await h.create(person, { name: `Here ${i}` })
    expect((await countServers(h.db)).servers).toBe(8)
    const tally = await outcomes(
      gone.map((person, i) => () => h.app.servers.undeleteServer(person, trashed[i] ?? '')),
    )
    expect(Object.fromEntries(tally)).toEqual({ made: CEILING - 8, limit_reached: 10 - (CEILING - 8) })
    expect((await countServers(h.db)).servers).toBe(CEILING)
  }, 120_000)
})

describe.skipIf(!hasDatabase)('free and Plus creates at once', () => {
  const was = tuning()
  let h: Harness

  beforeAll(async () => {
    installTuning({ ...was, capacity: { ...was.capacity, freeShare: 0.5 } })
    h = await startHarness({
      controls: { maxServers: 500, maxRunningServers: ROOM + DEFAULT_ROOM.wakeReserve },
    })
  }, 30_000)

  afterAll(async () => {
    installTuning(was)
    await h.close()
  })

  test('close to free plans at their share first, and Plus fills the rest', async () => {
    const free = await Promise.all(Array.from({ length: 25 }, (_, i) => h.user(`Free ${i}`, 'free')))
    const plus = await Promise.all(Array.from({ length: 25 }, (_, i) => h.user(`Plus ${i}`, 'plus')))
    const create = (person: UserActor, name: string, as: string) => () =>
      h.create(person, { name }).then(() => as)
    const tally = await outcomes(
      free.flatMap((person, i) => [
        create(person, `Free ${i}`, 'free made'),
        create(plus[i] ?? person, `Plus ${i}`, 'plus made'),
      ]),
    )
    const freeMade = tally.get('free made') ?? 0
    expect(freeMade).toBeLessThanOrEqual(ROOM / 2)
    expect(tally.get('plus made')).toBe(ROOM - freeMade)
    expect(tally.get('platform_full')).toBe(50 - ROOM)
    expect((await countServers(h.db)).running).toBe(ROOM)
  }, 60_000)
})

describe.skipIf(!hasDatabase)('creates and starts mixed at once', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({ controls: ROOMY })
  }, 30_000)

  afterAll(() => h.close())

  test('all finish, within the platform’s running cap and each person’s', async () => {
    const people = await Promise.all(Array.from({ length: 10 }, (_, i) => h.user(`Busy ${i}`, 'plus')))
    // Three servers each and room for a fourth, still two running at a time.
    await h.db
      .update(schema.accountStanding)
      .set({ limitOverrides: { maxServers: 4 } })
      .where(
        inArray(
          schema.accountStanding.userId,
          people.map((person) => person.userId),
        ),
      )
    const servers = await Promise.all(people.map((person, i) => stoppedServers(h, person, 3, `Busy ${i}`)))
    const cap = 16
    await setControls(h, { maxRunningServers: cap })
    // Each person starts all three servers and makes a fourth, which their plan's two running
    // places can't all take; together they ask for more than the platform runs.
    await outcomes(
      people.flatMap((person, i) => [
        ...(servers[i] ?? []).map((id) => () => h.app.servers.start(person, id, randomUUID())),
        () => h.create(person, { name: `Busy ${i} new` }),
      ]),
    )
    const running = await Promise.all(
      people.map(async (person) => (await countServers(h.db, person.userId)).running),
    )
    expect(Math.max(...running)).toBeLessThanOrEqual(2)
    expect((await countServers(h.db)).running).toBe(cap)
  }, 120_000)
})
