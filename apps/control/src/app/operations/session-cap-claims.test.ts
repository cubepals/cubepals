// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A session warning is said once, by whichever check claims it. session-cap.test.ts races two
 * checks, but which way a race goes is chance: the losing check either reads the warning as already
 * said or loses the claim itself. This holds the second case still, so it is tested every time.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { type Harness, startHarness } from '../../testing/harness.ts'

describe('session warning claims', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  /** Resolves once a query waits on a row lock: the check's claim has reached the row. */
  const claimWaiting = async () => {
    for (let tries = 0; tries < 200; tries++) {
      const { rows } = await h.db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_locks where not granted`,
      )
      if (rows[0]?.waiting) return
      await Bun.sleep(25)
    }
    throw new Error('The check never reached its claim')
  }

  test('a check that read the run before another claimed its warning says nothing', async () => {
    const owner = await h.user('Steve', 'plus')
    await h.db
      .update(schema.accountStanding)
      .set({ limitOverrides: { maxSessionMinutes: 240 } })
      .where(eq(schema.accountStanding.userId, owner.userId))
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const thisRun = and(eq(schema.powerIntervals.serverId, id), isNull(schema.powerIntervals.stoppedAt))
    // Nine minutes to go, so the ten-minute warning is due.
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: new Date(Date.now() - (240 - 9) * MINUTE_MS) })
      .where(thisRun)

    // Another check's claim, not yet committed: this check still reads the warning as unsaid, and
    // its own claim waits on the row. Once the other commits, the claim finds it taken.
    let check: Promise<number> | undefined
    await h.db.transaction(async (tx) => {
      await tx.update(schema.powerIntervals).set({ sessionWarnedMinutes: 10 }).where(thisRun)
      check = h.app.schedules.sessionCheck()
      await claimWaiting()
    })
    expect(await check).toBe(0)
    expect(h.minecraft.said(id)).toEqual([])
    const [run] = await h.db.select().from(schema.powerIntervals).where(thisRun)
    expect(run?.sessionWarnedMinutes).toBe(10)
  }, 30_000)
})
