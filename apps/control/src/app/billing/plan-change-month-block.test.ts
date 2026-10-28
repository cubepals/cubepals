// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A month keeps a block of hours only when an admin lowers the account's hours after it played,
 * and only under the plan it was kept under: when the plan in force changes mid-month (a
 * subscription that ends), the new plan's hours apply at once, never the old plan's.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { HOUR_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { entitlementsFor, entitlementsOf } from '../../domain/account/entitlements.ts'
import { hasDatabase } from '../../testing/harness.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { meteredMonth } from './chip-in-meter.ts'

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
const admin = { kind: 'admin', userId: 'admin' } as const

/** A subscriber who played three hours this month, counted, and whose subscription then ended. */
async function endedAfterPlay(name: string) {
  const { owner, sub } = await w.subscriber(name)
  const server = await w.h.create(owner)
  await w.h.until(server.id, 'running')
  await w.h.settled(server.id)
  await w.h.app.servers.stop(owner, server.id, randomUUID(), 'user')
  await w.h.until(server.id, 'stopped')
  await w.h.settled(server.id)
  const from = new Date(Date.now() - 4 * HOUR_MS)
  await w.h.db.insert(schema.powerIntervals).values({
    serverId: server.id,
    memoryTier: '3g',
    startedAt: from,
    stoppedAt: new Date(from.getTime() + 3 * HOUR_MS),
  })
  await w.h.app.billing.usage.count(owner.userId)
  await w.subscriptionNow(owner, sub, { status: 'canceled' })
  return owner
}

test.skipIf(!hasDatabase || monthRoom < 5 * HOUR_MS)(
  'a subscription that ends mid-month leaves Free’s hours in force at once',
  async () => {
    const owner = await endedAfterPlay('Ada')
    const standing = await loadStanding(w.h.db, owner.userId)
    expect(standing.plan).toBe('free')
    const overview = await w.h.app.accountQueries.overview(owner)
    expect(overview.entitlements.includedUnits).toBe(entitlementsFor('free').includedUnits)
    expect(overview.entitlements.dailyUnits).toBe(entitlementsFor('free').dailyUnits)
  },
  60_000,
)

test.skipIf(!hasDatabase || monthRoom < 5 * HOUR_MS)(
  'hours an admin gives once Plus has ended are the month’s hours, not Plus’s',
  async () => {
    const owner = await endedAfterPlay('Bea')
    await w.h.app.accounts.setLimits(admin, owner.userId, {
      maxServers: null,
      maxRunning: null,
      includedUnits: 2,
    })
    const standing = await loadStanding(w.h.db, owner.userId)
    const plan = entitlementsOf(standing)
    expect((await meteredMonth(w.h.db, standing, plan, new Date()))?.included).toBe(2)
  },
  60_000,
)
