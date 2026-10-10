// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { MemoryTier } from '../../domain/server/size.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

/** A server playing plain Minecraft on this size. */
const plain = (tier: MemoryTier) => ({ tier, loader: 'vanilla' as const, modded: false })

const HOUR = 3_600_000

// Power accounting (§4 power_intervals, §15.4): run hours are what intervals say, counted from
// the start of the month, and an interval left open on a server that stopped is closed.
describe.skipIf(!hasDatabase)('power accounting', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const running = async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner, id: created.id }
  }
  const interval = (serverId: string, startedAt: Date, stoppedAt: Date | null) =>
    h.db.insert(schema.powerIntervals).values({ serverId, memoryTier: '3g', startedAt, stoppedAt })
  /**
   * The policy's answer to booting the (running) server again at a moment of our choosing, from
   * the intervals in the database. A restart keeps its running slot, so only the hours decide.
   */
  const restartAt = (userId: string, now: Date) =>
    h.db.transaction((tx) =>
      h.app.policy.check(tx, userId, { kind: 'restart_server', runs: plain('3g') }, now, { lock: false }),
    )

  test('the free plan’s hours count this month’s part of every interval, and then boots wait', async () => {
    const { owner, id } = await running()
    // The server's own open interval began just now; replace it with one five hours long.
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    // A moment late in this month, so every interval below fits whatever today is.
    const at = new Date(monthStart.getTime() + 20 * 24 * HOUR)
    await h.db.delete(schema.powerIntervals).where(eq(schema.powerIntervals.serverId, id))
    await interval(id, new Date(at.getTime() - 5 * HOUR), null) // open: 5 h so far
    await interval(id, new Date(at.getTime() - 60 * HOUR), new Date(at.getTime() - 52 * HOUR)) // 8 h
    await interval(id, new Date(monthStart.getTime() - 30 * HOUR), new Date(monthStart.getTime() - 5 * HOUR)) // last month
    await interval(id, new Date(monthStart.getTime() - 10 * HOUR), new Date(monthStart.getTime() + 2 * HOUR)) // 2 h this month

    expect(await restartAt(owner.userId, at)).toEqual({ ok: true })
    await interval(id, new Date(at.getTime() - 9.5 * HOUR), new Date(at.getTime() - 4.5 * HOUR)) // 5 h: 20 in all
    expect(await restartAt(owner.userId, at)).toMatchObject({
      ok: false,
      code: 'limit_reached',
      message: 'You have used this month’s play time. It resets on the 1st.',
    })
    // The next month starts from nothing.
    const nextMonth = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 2))
    await h.db
      .update(schema.powerIntervals)
      .set({ stoppedAt: new Date(at.getTime() - HOUR) })
      .where(and(eq(schema.powerIntervals.serverId, id), isNull(schema.powerIntervals.stoppedAt)))
    expect(await restartAt(owner.userId, nextMonth)).toEqual({ ok: true })
  }, 30_000)

  test('usage-close ends an interval left open on a server that stopped, where it last changed', async () => {
    const { id } = await running()
    const other = await running()
    // A stop whose worker died before it closed the interval.
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'stopped', updatedAt: sql`now() - interval '3 minutes'` })
      .where(eq(schema.minecraftServers.id, id))

    expect(await h.app.schedules.usageClose()).toBe(1)
    const [closed] = await h.db
      .select()
      .from(schema.powerIntervals)
      .where(eq(schema.powerIntervals.serverId, id))
    const [server] = await h.db
      .select()
      .from(schema.minecraftServers)
      .where(eq(schema.minecraftServers.id, id))
    expect(closed?.stoppedAt?.getTime()).toBe(server?.updatedAt.getTime())
    // The running server's interval stays open, and a second sweep has nothing to do.
    const [open] = await h.db
      .select()
      .from(schema.powerIntervals)
      .where(eq(schema.powerIntervals.serverId, other.id))
    expect(open?.stoppedAt).toBeNull()
    expect(await h.app.schedules.usageClose()).toBe(0)
  }, 30_000)
})
