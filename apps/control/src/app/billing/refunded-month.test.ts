// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A month of Plus refunded as the withdrawal the Refunds page offers ("Plus then ends straight
 * away"): a first month's order refunded within its 14 days, or any order Polar's refund reason
 * marks as one. Blockly ends the subscription in Polar (a refund there ends nothing on its own),
 * moves the account to Free, says so by email and on the account page, and the audit log keeps
 * why. Any other refund leaves Plus to run and renew.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { DAY_MS } from '@blockly/contracts/durations'
import { hasDatabase } from '../../testing/harness.ts'
import { orderEvent, subscription } from '../../testing/polar.ts'
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

/** Whether Blockly asked Polar to end the subscription since `asked` requests. */
const endedInPolar = (sub: string, asked: number) =>
  w.polar.requests
    .slice(asked)
    .some(
      (r) => r.path.startsWith(`/v1/subscriptions/${sub}`) && (r.method === 'DELETE' || r.method === 'PATCH'),
    )

/** A renewal of the subscription, paid, then refunded for `reason`; the requests made before it. */
async function renewalRefunded(owner: UserActor, sub: string, reason: 'customer_request' | 'duplicate') {
  const id = await w.ordered(owner, sub, {
    billing_reason: 'subscription_cycle',
    created_at: new Date().toISOString(),
  })
  const held = w.orders.get(id)
  if (held === undefined) throw new Error('no renewal')
  w.refunds.push({ order_id: id, amount: held.total_amount, reason })
  const asked = w.polar.requests.length
  await w.post(
    orderEvent({ ...held, status: 'refunded', refunded_amount: held.total_amount }, 'order.refunded'),
  )
  return asked
}

test.skipIf(!hasDatabase)('a first month refunded in full ends Plus and its subscription', async () => {
  const { owner, sub } = await w.subscriber('Uma')
  const [first] = [...w.orders.values()].filter((o) => o.subscription_id === sub)
  if (first === undefined) throw new Error('no first order')
  const asked = w.polar.requests.length
  await w.post(
    orderEvent({ ...first, status: 'refunded', refunded_amount: first.total_amount }, 'order.refunded'),
  )
  // Blockly keeps the refund…
  expect((await w.kept(first.id))?.refundedCents).toBe(first.total_amount)
  // …the account is on Free…
  expect((await w.h.app.accountQueries.overview(owner)).plan.key).toBe('free')
  // …and Polar is asked to end the subscription that was refunded.
  const ended = w.polar.requests
    .slice(asked)
    .some(
      (r) => r.path.startsWith(`/v1/subscriptions/${sub}`) && (r.method === 'DELETE' || r.method === 'PATCH'),
    )
  expect(ended).toBe(true)
})

test.skipIf(!hasDatabase)(
  'the owner is told once, the account page says so, and the audit log keeps why',
  async () => {
    const { owner, sub } = await w.subscriber('Vera')
    const [first] = [...w.orders.values()].filter((o) => o.subscription_id === sub)
    if (first === undefined) throw new Error('no first order')
    const refunded = orderEvent({ ...first, status: 'refunded', refunded_amount: 500 }, 'order.refunded')
    await w.post(refunded)
    // Polar delivers it again: nothing is ended or said twice.
    await w.post(refunded)
    expect((await w.mailTo(owner)).map((m) => m.subject)).toEqual([
      'Your refund went through, and Plus has ended',
    ])
    const overview = await w.h.app.accountQueries.overview(owner)
    expect(overview.plan).toMatchObject({ key: 'free', billed: { status: 'ended', endedFor: 'withdrawal' } })
    expect(await w.audited(owner, 'billing.subscription_revoked')).toEqual([
      { provider: 'polar', subscription: sub, plan: 'plus', why: 'withdrawal', source: 'webhook' },
    ])
  },
)

test.skipIf(!hasDatabase)('a renewal refunded at the player’s request ends Plus too', async () => {
  const { owner, sub } = await w.subscriber('Wes')
  const asked = await renewalRefunded(owner, sub, 'customer_request')
  expect(endedInPolar(sub, asked)).toBe(true)
  expect((await w.h.app.accountQueries.overview(owner)).plan.key).toBe('free')
})

test.skipIf(!hasDatabase)('a renewal Blockly refunded itself leaves Plus to run and renew', async () => {
  const { owner, sub } = await w.subscriber('Xia')
  const asked = await renewalRefunded(owner, sub, 'duplicate')
  expect(endedInPolar(sub, asked)).toBe(false)
  expect((await w.h.app.accountQueries.overview(owner)).plan.key).toBe('plus')
  expect(await w.mailTo(owner)).toEqual([])
})

test.skipIf(!hasDatabase)(
  'a first month refunded after its 14 days, not as a withdrawal, keeps Plus',
  async () => {
    const { owner, sub } = await w.subscriber('Yan')
    const [first] = [...w.orders.values()].filter((o) => o.subscription_id === sub)
    if (first === undefined) throw new Error('no first order')
    const began = new Date(Date.now() - 20 * DAY_MS)
    const asked = w.polar.requests.length
    await w.post(
      orderEvent(
        {
          ...first,
          created_at: began.toISOString(),
          modified_at: new Date().toISOString(),
          status: 'partially_refunded',
          refunded_amount: 500,
        },
        'order.refunded',
      ),
    )
    expect(endedInPolar(sub, asked)).toBe(false)
    expect((await w.h.app.accountQueries.overview(owner)).plan.key).toBe('plus')
  },
)

test.skipIf(!hasDatabase)('one already revoked in Polar is ended here all the same', async () => {
  const { owner, sub } = await w.subscriber('Zoe')
  const [first] = [...w.orders.values()].filter((o) => o.subscription_id === sub)
  if (first === undefined) throw new Error('no first order')
  // Revoked by hand in Polar's dashboard, and that word not here yet: Polar refuses a second revoke.
  w.subscriptions.set(sub, subscription(sub))
  const response = await w.post(
    orderEvent({ ...first, status: 'refunded', refunded_amount: first.total_amount }, 'order.refunded'),
  )
  expect(response.status).toBe(200)
  expect((await w.h.app.accountQueries.overview(owner)).plan.billed).toMatchObject({
    status: 'ended',
    endedFor: 'withdrawal',
  })
})
