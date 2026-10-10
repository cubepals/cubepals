// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { and, eq, isNull } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { DomainEvent } from '../ports/events.ts'
import { claimSessionWarning, releaseSessionWarning } from '../servers/usage.ts'

const MINUTE = 60_000

// A cap on how long one run lasts: no plan sets one any more (a month's hours already bound what a
// server costs), but an admin can hold one account to it, against an AFK farm that defeats the
// kick. A run is warned twice in game, then stopped the ordinary way; the owner can start it again
// at once.
describe.skipIf(!hasDatabase)('session cap', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const running = async (plan = 'free', capped = true) => {
    const owner = await h.user('Steve', plan)
    if (capped)
      await h.db
        .update(schema.accountStanding)
        .set({ limitOverrides: { maxSessionMinutes: 240 } })
        .where(eq(schema.accountStanding.userId, owner.userId))
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    return { owner, id }
  }
  /** Puts the server's current run that many minutes in the past, as if it had run that long. */
  const ranFor = (id: string, minutes: number) =>
    h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(Date.now() - minutes * MINUTE) })
      .where(and(eq(schema.powerIntervals.serverId, id), isNull(schema.powerIntervals.stoppedAt)))
  const session = async (id: string) => {
    const [row] = await h.db
      .select()
      .from(schema.powerIntervals)
      .where(and(eq(schema.powerIntervals.serverId, id), isNull(schema.powerIntervals.stoppedAt)))
    return row
  }

  test('a run is warned at ten and two minutes, once each, then stopped at the cap', async () => {
    const { owner, id } = await running()
    const heard: DomainEvent[] = []
    const unsubscribe = await h.events.subscribe((event) => heard.push(event))
    try {
      // Well inside the session: nothing is said.
      await ranFor(id, 200)
      expect(await h.app.schedules.sessionCheck()).toBe(0)
      expect(h.minecraft.said(id)).toEqual([])

      // Ten minutes to go, said once however often the check runs, even at the same moment.
      await ranFor(id, 240 - 9)
      expect(await Promise.all([h.app.schedules.sessionCheck(), h.app.schedules.sessionCheck()])).toEqual([
        0, 0,
      ])
      await h.app.schedules.sessionCheck()
      expect(h.minecraft.said(id)).toEqual([
        '[Cubepals] Server stops in 10 minutes, saving the world first. You can join again right after.',
      ])
      expect((await session(id))?.sessionWarnedMinutes).toBe(10)

      // Two minutes to go: the second warning, also once.
      await ranFor(id, 240 - 1.5)
      await h.app.schedules.sessionCheck()
      await h.app.schedules.sessionCheck()
      expect(h.minecraft.said(id)).toEqual([
        '[Cubepals] Server stops in 10 minutes, saving the world first. You can join again right after.',
        '[Cubepals] Server stops in 2 minutes, saving the world first. You can join again right after.',
      ])
      expect((await session(id))?.sessionWarnedMinutes).toBe(2)

      // At the cap it stops the ordinary way, which saves the world first.
      await ranFor(id, 241)
      expect(await h.app.schedules.sessionCheck()).toBe(1)
      const stopped = await h.until(id, 'stopped')
      expect(stopped.lifecycle.stopReason).toBe('session_cap')
      expect((await h.app.queries.get(owner, id)).stopReason).toBe('session_cap')
      const stop = (await h.settled(id)).filter((op) => op.kind === 'stop').at(-1)
      expect(stop).toMatchObject({ requestedBy: 'system:session_cap', status: 'succeeded' })
      // Its pages hear why, as it happens.
      const told = heard.filter((e) => e.type === 'session_cap' && e.serverId === id)
      expect(told).toMatchObject([
        { minutes: 240, minutesLeft: 10 },
        { minutes: 240, minutesLeft: 2 },
        { minutes: 240, minutesLeft: 0 },
      ])

      // And it starts again straight away, on a session of its own.
      await h.app.servers.start(owner, id, crypto.randomUUID())
      await h.until(id, 'running')
      await h.settled(id)
      expect((await session(id))?.sessionWarnedMinutes).toBeNull()
      expect(await h.app.schedules.sessionCheck()).toBe(0)
    } finally {
      await unsubscribe()
    }
  }, 60_000)

  test('only one check may say a warning, however many come to it at once', async () => {
    const { id } = await running()
    await ranFor(id, 240 - 9)
    // The claim is what makes a warning once-only: two checks racing, one warning.
    const claims = await Promise.all([
      claimSessionWarning(h.db, id, 10),
      claimSessionWarning(h.db, id, 10),
      claimSessionWarning(h.db, id, 10),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    // A later warning still claims; the one already said does not again.
    expect(await claimSessionWarning(h.db, id, 2)).toBe(true)
    expect(await claimSessionWarning(h.db, id, 10)).toBe(false)
    // A warning that couldn't be said goes back, for the next check to try.
    await releaseSessionWarning(h.db, id, 2, 10)
    expect((await session(id))?.sessionWarnedMinutes).toBe(10)
  }, 30_000)

  test('a warning whose moment passed unseen is skipped rather than said late', async () => {
    const { id } = await running()
    // Nothing ran while the ten-minute mark went by: only the two-minute warning is still true.
    await ranFor(id, 240 - 1)
    await h.app.schedules.sessionCheck()
    expect(h.minecraft.said(id)).toEqual([
      '[Cubepals] Server stops in 2 minutes, saving the world first. You can join again right after.',
    ])
    expect((await session(id))?.sessionWarnedMinutes).toBe(2)
  }, 30_000)

  test('no plan caps a run: a free server runs on, however long it has been up', async () => {
    const { id } = await running('free', false)
    await ranFor(id, 10_000)
    expect(await h.app.schedules.sessionCheck()).toBe(0)
    expect(h.minecraft.said(id)).toEqual([])
    expect((await h.server(id)).lifecycle.status).toBe('running')
  }, 30_000)
})
