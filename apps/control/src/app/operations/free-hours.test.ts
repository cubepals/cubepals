// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Free's 20 hours in all, with at most 2 a day on top: only runs started on Free count, so
 * accounts begin with all 20 and Plus spends none of them. A run that gets to the end of the 20 is
 * warned in game, then stops with its world kept; starting or joining it is refused until the
 * account has Plus, and nothing says it comes back at midnight.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { entitlementsFor, entitlementsOf } from '../../domain/account/entitlements.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { playTotal } from '../accounts/play-total.ts'
import type { UserActor } from '../actor.ts'

const TEN =
  '[Cubepals] The free trial ends in 10 minutes. The world is saved and kept, and Core starts it again.'
const REFUSED =
  'You’ve played the 20 hours of your free trial. Your worlds are kept, and Core starts them again.'

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await h.close()
})

const running = async (actor: UserActor) => {
  const server = await h.create(actor)
  await h.until(server.id, 'running')
  await h.settled(server.id)
  return server
}
const stopped = async (actor: UserActor, id: string) => {
  await h.app.servers.stop(actor, id, crypto.randomUUID(), 'user')
  await h.until(id, 'stopped')
  await h.settled(id)
}
/** A finished run on `plan`, `hours` long, ending `daysAgo` days back: outside today's play. */
const ran = (serverId: string, plan: string | null, hours: number, daysAgo: number) => {
  const stoppedAt = new Date(Date.now() - daysAgo * DAY_MS)
  return h.db.insert(schema.powerIntervals).values({
    serverId,
    memoryTier: '3g',
    plan,
    startedAt: new Date(stoppedAt.getTime() - hours * HOUR_MS),
    stoppedAt,
  })
}
const total = async (actor: UserActor) => {
  const standing = await loadStanding(h.db, actor.userId)
  return playTotal(h.db, standing, entitlementsOf(standing), new Date())
}
const setPlan = (actor: UserActor, plan: string) =>
  h.db.update(schema.accountStanding).set({ plan }).where(eq(schema.accountStanding.userId, actor.userId))

describe.skipIf(!hasDatabase)('Free’s 20 hours', () => {
  test('a run keeps the plan it started on, and only runs on Free count', async () => {
    const actor = await h.user('Ana')
    const server = await running(actor)
    const [first] = await h.db
      .select()
      .from(schema.powerIntervals)
      .where(eq(schema.powerIntervals.serverId, server.id))
    expect(first?.plan).toBe('free')
    await stopped(actor, server.id)
    await h.db.delete(schema.powerIntervals).where(eq(schema.powerIntervals.serverId, server.id))

    // Runs from before runs kept their plan count toward nothing: every account starts with 20.
    await ran(server.id, null, 6, 3)
    expect(await total(actor)).toEqual({ included: 20, units: 0, left: 20 })
    await ran(server.id, 'free', 2, 2)
    await ran(server.id, 'plus', 2, 1)
    expect(await total(actor)).toEqual({ included: 20, units: 2, left: 18 })

    // Plus has no such block, and going back to Free brings no new 20: what was left is.
    await setPlan(actor, 'plus')
    expect(await total(actor)).toBeNull()
    const plus = await running(actor)
    const [onPlus] = await h.db
      .select()
      .from(schema.powerIntervals)
      .where(eq(schema.powerIntervals.serverId, plus.id))
    expect(onPlus?.plan).toBe('plus')
    await stopped(actor, plus.id)
    await setPlan(actor, 'free')
    expect((await total(actor))?.left).toBeCloseTo(18, 1)
  }, 60_000)

  test('test accounts, and accounts an admin gave monthly hours, are held to the day as before', async () => {
    const actor = await h.user('Kim')
    await h.db
      .update(schema.accountStanding)
      .set({ testAccount: true })
      .where(eq(schema.accountStanding.userId, actor.userId))
    expect(await total(actor)).toBeNull()
    expect(entitlementsFor('free', { includedUnits: 30 }).totalUnits).toBeNull()
    expect(entitlementsFor('free').totalUnits).toBe(20)
  })

  test('the end of the 20: warned, stopped with the world kept, and refused until Plus', async () => {
    const actor = await h.user('Lee')
    const server = await running(actor)
    const id = server.id
    // 19 hours played on other days, and this run started 55 minutes ago: five minutes left.
    await ran(id, 'free', 19, 2)
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(Date.now() - 55 * MINUTE_MS) })
      .where(and(eq(schema.powerIntervals.serverId, id), isNull(schema.powerIntervals.stoppedAt)))
    expect((await h.app.queries.get(actor, id)).playTotal?.hoursLeft).toBeCloseTo(5 / 60, 1)

    // Five minutes left: the ten-minute warning, and the end fixed ten minutes on, never sooner.
    expect(await h.app.schedules.sessionCheck()).toBe(0)
    expect(h.minecraft.said(id)).toEqual([TEN])
    expect(await h.app.schedules.sessionCheck(new Date(Date.now() + 11 * MINUTE_MS))).toBe(1)
    const after = await h.until(id, 'stopped')
    expect(after.lifecycle.stopReason).toBe('free_hours')
    const stop = (await h.settled(id)).filter((op) => op.kind === 'stop').at(-1)
    expect(stop).toMatchObject({ requestedBy: 'system:play_total', status: 'succeeded' })

    // Played out, the run as long as the check that stopped it saw it: a start says so and what
    // brings it back; a join is refused with no midnight.
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(Date.now() - 2 * HOUR_MS) })
      .where(
        and(
          eq(schema.powerIntervals.serverId, id),
          gt(schema.powerIntervals.startedAt, new Date(Date.now() - DAY_MS)),
        ),
      )
    expect((await h.app.queries.get(actor, id)).playTotal?.hoursLeft).toBe(0)
    await expect(h.app.servers.start(actor, id, crypto.randomUUID())).rejects.toMatchObject({
      code: 'limit_reached',
      message: REFUSED,
    })
    expect(await h.app.edge.wake(`${server.slug}.play.test`)).toEqual({ outcome: 'denied', reason: 'quota' })

    // The world is kept and still downloads; the account page says what is left.
    const overview = await h.app.accountQueries.overview(actor)
    expect(overview.usage.total?.included).toBe(20)
    expect(overview.usage.total?.units).toBeGreaterThanOrEqual(20)
    // A download is answered as on an account with all 20 left (this harness may have no store).
    const fresh = await h.app.accountQueries.overview(await h.user('Noor'))
    const download = (o: typeof overview) => o.features.find((f) => f.feature === 'create_archive')
    expect(download(overview)).toEqual(download(fresh))

    // Plus starts it again.
    await setPlan(actor, 'plus')
    await h.app.servers.start(actor, id, crypto.randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
  }, 60_000)

  test('the 20 say something at four fifths and when they are played, once each', async () => {
    const actor = await h.user('Max')
    const server = await h.create(actor)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await stopped(actor, server.id)

    await ran(server.id, 'free', 10, 3)
    expect(await h.app.accounts.warnAboutPlay(actor.userId)).toBeNull()
    await ran(server.id, 'free', 6, 2)
    expect(await h.app.accounts.warnAboutPlay(actor.userId)).toBe(80)
    expect(h.mail.sent.at(-1)?.subject).toBe('About 4 hours of your free trial left')
    expect(h.mail.sent.at(-1)?.text).toContain('Core starts them again, with 40 hours a month.')
    expect(await h.app.accounts.warnAboutPlay(actor.userId)).toBeNull()

    await ran(server.id, 'free', 4, 1)
    expect(await h.app.accounts.warnAboutPlay(actor.userId)).toBe(100)
    expect(h.mail.sent.at(-1)?.subject).toBe('Your Cubepals free trial is over')
    expect(h.mail.sent.at(-1)?.text).toContain('Your worlds are kept, and you can still download them.')
    expect(await h.app.accounts.warnAboutPlay(actor.userId)).toBeNull()
  }, 60_000)
})
