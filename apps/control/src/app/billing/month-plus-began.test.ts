// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The month Plus begins in counts only play since it began: hours played on the free trial
 * earlier that month stay the free trial's, and Plus's block is whole.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { HOUR_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
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

test.skipIf(!hasDatabase || monthRoom < 12 * HOUR_MS)(
  'the month Plus begins in counts only play since Plus began',
  async () => {
    const owner = await w.h.user('Yara')
    const server = await w.h.create(owner)
    await w.h.until(server.id, 'running')
    await w.h.settled(server.id)
    await w.h.app.servers.stop(owner, server.id, randomUUID(), 'user')
    await w.h.until(server.id, 'stopped')
    await w.h.settled(server.id)
    // Ten hours on the free trial, earlier this month.
    const from = new Date(thisMonth.getTime() + HOUR_MS)
    await w.h.db.insert(schema.powerIntervals).values({
      serverId: server.id,
      memoryTier: '3g',
      startedAt: from,
      stoppedAt: new Date(from.getTime() + 10 * HOUR_MS),
    })
    // Then Plus, bought and paid now.
    const sub = randomUUID()
    await w.standing(owner, sub, { created_at: new Date().toISOString() })
    await w.ordered(owner, sub, { created_at: new Date().toISOString() })
    const standing = await loadStanding(w.h.db, owner.userId)
    expect(standing.plan).toBe('plus')
    const month = await meteredMonth(w.h.db, standing, entitlementsFor('plus'), new Date())
    // Plus has played nothing yet: its 120 hours are whole.
    expect(month?.units ?? 0).toBeLessThan(0.5)
  },
  60_000,
)
