// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hours an admin gives an account (`limitOverrides.includedUnits`) hold for the month they were
 * given in: taken back mid-month, they apply from the next month, so hours played while they
 * covered them are never counted as extra play.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { HOUR_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import { PolarWorld } from '../../testing/polar-world.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

const today = new Date()
const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
const monthRoom = Date.now() - thisMonth.getTime()

test.skipIf(!hasDatabase || monthRoom < 6 * HOUR_MS)(
  'hours played while an admin’s hours covered them are never billed as extra later',
  async () => {
    const { owner } = await w.subscriber('Bo')
    const admin = { kind: 'admin', userId: 'admin' } as const
    // Given 10 hours a month, with 20 extra allowed.
    await w.h.app.accounts.setLimits(admin, owner.userId, {
      maxServers: null,
      maxRunning: null,
      includedUnits: 10,
    })
    await w.h.app.accounts.allowExtraPlay(owner, 20)
    const server = await w.h.create(owner)
    await w.h.until(server.id, 'running')
    await w.h.settled(server.id)
    await w.h.app.servers.stop(owner, server.id, randomUUID(), 'user')
    await w.h.until(server.id, 'stopped')
    await w.h.settled(server.id)
    // Five hours played, all inside the ten.
    const from = new Date(Date.now() - 5.5 * HOUR_MS)
    await w.h.db.insert(schema.powerIntervals).values({
      serverId: server.id,
      memoryTier: '3g',
      startedAt: from,
      stoppedAt: new Date(from.getTime() + 5 * HOUR_MS),
    })
    await w.h.app.billing.usage.count(owner.userId)
    // The admin takes the hours back down to 1.
    await w.h.app.accounts.setLimits(admin, owner.userId, {
      maxServers: null,
      maxRunning: null,
      includedUnits: 1,
    })
    await w.h.app.billing.usage.count(owner.userId)
    const rows = await w.h.db
      .select()
      .from(schema.extraPlayMonths)
      .where(and(eq(schema.extraPlayMonths.userId, owner.userId)))
    // Nothing played was extra when it was played.
    expect(rows.reduce((sum, row) => sum + row.accruedMilli, 0)).toBe(0)
  },
  60_000,
)
