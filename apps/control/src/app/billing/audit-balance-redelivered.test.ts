// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A balance order delivered again after its refund: `settleWith` reads the older delivery's
 * refunded amount (none), so the refunded balance clears the debt it no longer pays for.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { hasDatabase } from '../../testing/harness.ts'
import { orderEvent } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

const anHourOn = () => new Date(Date.now() + 61 * MINUTE_MS)

test.skipIf(!hasDatabase)('a balance refunded is still owed when its paid delivery comes again', async () => {
  const { owner, sub } = await w.subscriber('Rui')
  const madeAt = new Date()
  await w.subscriptionNow(owner, sub, { status: 'canceled' })
  const renewal = await w.renewalWithExtra(owner, sub, madeAt, { status: 'void' })
  expect(await w.h.app.billing.confirmOwed(anHourOn())).toBeGreaterThanOrEqual(1)
  const balance = await w.paidBalance(owner, renewal, 1750)
  const paid = w.orders.get(balance) as NonNullable<ReturnType<typeof w.orders.get>>
  await w.post(orderEvent({ ...paid, status: 'refunded', refunded_amount: 1750 }, 'order.refunded'))
  expect((await w.h.app.accountQueries.overview(owner)).usage.extra).toMatchObject({ owedCents: 1750 })
  // The older paid delivery again: the refunded balance clears the debt once more.
  await w.post(orderEvent(paid, 'order.paid'))
  expect((await w.kept(balance))?.refundedCents).toBe(1750)
  expect((await w.h.app.accountQueries.overview(owner)).usage.extra).toMatchObject({ owedCents: 1750 })
})
