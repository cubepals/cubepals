// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A year's end follows the refund on its order as Blockly kept it, which only grows: a year
 * refunded in full stays refunded when an older paid delivery of its order comes again.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import { orderEvent } from '../../testing/polar.ts'
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

const yearsOf = (owner: UserActor) =>
  w.h.db.select().from(schema.planYears).where(eq(schema.planYears.userId, owner.userId))

test.skipIf(!hasDatabase)(
  'a year refunded in full stays refunded when its paid delivery comes again',
  async () => {
    const owner = await w.h.user('Ola')
    const id = await w.paidYear(owner)
    const paid = w.orders.get(id) as NonNullable<ReturnType<typeof w.orders.get>>
    // Refunded in full: the year ends where it began.
    await w.post(orderEvent({ ...paid, status: 'refunded', refunded_amount: 15000 }, 'order.refunded'))
    const [refunded] = await yearsOf(owner)
    expect(refunded?.endsAt).toEqual(refunded?.startsAt as Date)
    // Polar delivers the older `order.paid` again: the year stays as the refund left it.
    await w.post(orderEvent(paid, 'order.paid'))
    const [after] = await yearsOf(owner)
    expect(after?.endsAt).toEqual(after?.startsAt as Date)
    expect((await w.h.app.accountQueries.overview(owner)).plan.key).toBe('free')
  },
)
