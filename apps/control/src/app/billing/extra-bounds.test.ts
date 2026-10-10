/**
 * The edges of what extra play counts and bills, through the real Polar adapter against a
 * stand-in for Polar's API: counting stops at the moment extra play did (a cancel, a failed
 * renewal), not at the last count before it; a month is counted until it is final, whether or not
 * the account plays now.
 *
 * Counting within a month, cutting and sending events are in `extra-usage.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import { subscription } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import type { UserActor } from '../actor.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

/** A server the owner made and stopped, for runs to be written against. */
const stoppedServer = async (owner: UserActor) => {
  const { h } = w
  const server = await h.create(owner)
  await h.until(server.id, 'running')
  await h.settled(server.id)
  await h.app.servers.stop(owner, server.id, crypto.randomUUID(), 'user')
  await h.until(server.id, 'stopped')
  await h.settled(server.id)
  return server
}

/** A closed run of a small server from `from` to `to`. */
const ran = (serverId: string, from: Date, to: Date) =>
  w.h.db.insert(schema.powerIntervals).values({ serverId, memoryTier: '3g', startedAt: from, stoppedAt: to })

const monthRow = async (owner: UserActor, month: Date) => {
  const [row] = await w.h.db
    .select()
    .from(schema.extraPlayMonths)
    .where(
      and(
        eq(schema.extraPlayMonths.userId, owner.userId),
        eq(schema.extraPlayMonths.month, month.toISOString().slice(0, 10)),
      ),
    )
  return row
}

const hour = 3_600_000
const today = new Date()
const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
// Runs written in this month, ending now: four hours of room behind them.
const monthRoom = Date.now() - thisMonth.getTime()

/** A Plus subscriber with an hour included a month and 20 extra allowed, and a stopped server. */
const playing = async (name: string) => {
  const { owner, sub } = await w.subscriber(name)
  const admin = { kind: 'admin', userId: 'admin' } as const
  await w.h.app.accounts.setLimits(admin, owner.userId, {
    maxServers: null,
    maxRunning: null,
    includedUnits: 1,
  })
  await w.h.app.accounts.allowExtraPlay(owner, 20)
  return { owner, sub, server: await stoppedServer(owner) }
}

test.skipIf(!hasDatabase || monthRoom < 4 * hour)(
  'extra play is counted up to the moment a cancel or a failed renewal stopped it',
  async () => {
    const now = new Date()
    const start = new Date(now.getTime() - 3 * hour)
    const stop = new Date(start.getTime() + 2 * hour)
    // Three hours played; the account counted nothing in between (the sweep was behind).
    const cancelled = await playing('Hal')
    await ran(cancelled.server.id, start, now)
    // Set to end two hours in: an hour included, an hour extra until then, and nothing after.
    await w.standing(cancelled.owner, cancelled.sub, {
      cancel_at_period_end: true,
      canceled_at: stop.toISOString(),
    })
    expect(await w.h.app.billing.usage.count(cancelled.owner.userId, now)).toBe(true)
    expect((await monthRow(cancelled.owner, thisMonth))?.accruedMilli).toBe(1000)
    // Counted again later, still to that moment.
    expect(await w.h.app.billing.usage.count(cancelled.owner.userId, new Date(now.getTime() + hour))).toBe(
      false,
    )

    // Its renewal failed two hours in: the same, from when Polar says it went past due.
    const failed = await playing('Ivy')
    await ran(failed.server.id, start, now)
    w.subscriptions.set(
      failed.sub,
      subscription(failed.sub, { status: 'past_due', past_due_at: stop.toISOString(), ended_at: null }),
    )
    await w.standing(failed.owner, failed.sub, {}, false)
    expect(await w.h.app.billing.usage.count(failed.owner.userId, now)).toBe(true)
    expect((await monthRow(failed.owner, thisMonth))?.accruedMilli).toBe(1000)
  },
  60_000,
)

test.skipIf(!hasDatabase)(
  'last month is counted until it is final, though nothing ran in the last quarter of an hour',
  async () => {
    const { owner, server } = await playing('Jo')
    // Two hours played on the 20th of next month, never counted then.
    const month = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))
    const played = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 20, 12))
    await ran(server.id, played, new Date(played.getTime() + 2 * hour))
    // Three hours into the month after: past its first hour, and the server long stopped.
    const after = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 1, 3))
    await w.h.app.billing.usage.report(after)
    const row = await monthRow(owner, month)
    expect(row).toMatchObject({ accruedMilli: 1000 })
    expect(row?.finalAt).not.toBeNull()
    expect(
      (
        await w.h.db
          .select()
          .from(schema.extraPlayReports)
          .where(eq(schema.extraPlayReports.userId, owner.userId))
      ).map((r) => r.milli),
    ).toEqual([1000])
  },
  60_000,
)

test.skipIf(!hasDatabase)(
  'a month with a server still running in it stays open until it stops',
  async () => {
    const { owner, server } = await playing('Kai')
    const month = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))
    const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 1))
    // Started two hours before the month ended, still open five hours into the next.
    const [open] = await w.h.db
      .insert(schema.powerIntervals)
      .values({ serverId: server.id, memoryTier: '3g', startedAt: new Date(next.getTime() - 2 * hour) })
      .returning()
    const later = new Date(next.getTime() + 5 * hour)
    await w.h.app.billing.usage.count(owner.userId, later)
    expect(await monthRow(owner, month)).toMatchObject({ accruedMilli: 1000, finalAt: null })
    await w.h.db
      .update(schema.powerIntervals)
      .set({ stoppedAt: new Date(next.getTime() + 4 * hour) })
      .where(eq(schema.powerIntervals.id, open?.id ?? ''))
    await w.h.app.billing.usage.count(owner.userId, later)
    expect((await monthRow(owner, month))?.finalAt).not.toBeNull()
  },
  60_000,
)
