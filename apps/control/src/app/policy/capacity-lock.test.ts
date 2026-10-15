// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The capacity locks under a burst, end to end on Postgres and the fake runtime: fifty creates sent
 * at once never pass the platform's room or one person's plan, and none of them deadlocks. Each
 * person's facts are read under their own lock and the platform's counts under the platform's,
 * so this is what proves the two locks together still count every decision before the next.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { and, count, eq, isNull, ne } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { DEFAULT_ROOM } from '../../domain/policy/room.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { countServers } from '../accounts/persistence.ts'
import { AppError } from '../errors.ts'

const AT_ONCE = 50
/** What creates may fill on the platform: running room above the reserve kept for wakes. */
const ROOM = 12

/** Each create's outcome: made, or the code it was refused with. Anything else is thrown. */
async function outcomes(creates: Array<() => Promise<unknown>>): Promise<Map<string, number>> {
  const settled = await Promise.allSettled(creates.map((create) => create()))
  const tally = new Map<string, number>()
  for (const result of settled) {
    if (result.status === 'rejected' && !(result.reason instanceof AppError)) throw result.reason
    const key = result.status === 'fulfilled' ? 'made' : result.reason.code
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  return tally
}

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
