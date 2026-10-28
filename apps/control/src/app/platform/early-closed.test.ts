// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The early price on the platform page: what an admin sees of the room and the holds on it, and
 * the switch that closes it now and keeps it closed whatever is set from outside, until an admin
 * opens it again; each audited, and refused to anyone else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import { earlyProduct } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import { EarlyRoomControl } from '../billing/early-room.ts'
import { NotFound } from '../errors.ts'

const EARLY_CORE = '8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d01'
const ADMIN = { kind: 'admin', userId: 'admin' } as const

describe.skipIf(!hasDatabase)('the early price on the platform page', () => {
  const w = new PolarWorld()
  let room: EarlyRoomControl

  beforeAll(async () => {
    await w.start()
    room = new EarlyRoomControl({ db: w.h.db, maxPoints: 100_000 })
  }, 30_000)
  afterAll(() => w.close())
  beforeEach(async () => {
    w.reset()
    w.early.splice(0, w.early.length, earlyProduct(EARLY_CORE, { plan: 'core', included_units: 90 }, 700))
    await w.h.db.delete(schema.earlyHolds)
    await w.h.app.platform.setEarlyClosed(ADMIN, false)
  })

  const open = () =>
    room.set({
      roomPoints: 500,
      points: { core: 100, plus: 300 },
      validUntil: new Date(Date.now() + 30 * MINUTE_MS),
    })

  test('shows the room as set, what a checkout takes, and the pages holding it', async () => {
    await open()
    await w.h.app.billing.offer(await w.h.user('Holding'), 'core')
    expect((await w.h.app.platform.view(ADMIN)).earlyRoom).toMatchObject({
      roomPoints: 500,
      points: { core: 100, plus: 300 },
      closedSince: null,
      holds: { count: 1, points: 100 },
    })
  })

  test('closed by an admin, it stays closed whatever is set, until an admin opens it', async () => {
    await open()
    await w.h.app.platform.setEarlyClosed(ADMIN, true)
    await open()
    const owner = await w.h.user('WhileClosed')
    expect((await w.h.app.billing.offer(owner, 'core')).productId).toBeNull()
    expect((await w.h.app.platform.view(ADMIN)).earlyRoom.closedSince).not.toBeNull()
    await w.h.app.platform.setEarlyClosed(ADMIN, false)
    expect((await w.h.app.billing.offer(owner, 'core')).productId).toBe(EARLY_CORE)
    const audited = await w.h.db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, 'platform'), eq(schema.auditLog.subjectId, 'early_room')))
    expect(audited.map((row) => row.action)).toEqual(
      expect.arrayContaining(['platform.early_room_closed', 'platform.early_room_opened']),
    )
  })

  test('is no one else’s to see or close', async () => {
    const someone = await w.h.user('Someone')
    await expect(w.h.app.platform.setEarlyClosed(someone, true)).rejects.toBeInstanceOf(NotFound)
    await expect(w.h.app.platform.view(someone)).rejects.toBeInstanceOf(NotFound)
  })
})
