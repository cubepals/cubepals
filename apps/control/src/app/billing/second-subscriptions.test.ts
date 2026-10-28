// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A second subscription to time already paid for, through the real Polar adapter against a
 * stand-in for Polar's API: two Plus checkouts both paid, whichever word comes first, and a month
 * of Plus paid while a year of it runs. The one there first is kept as it is; the second is set to
 * end with its month and what it charged is refunded once, a refund Polar refuses asked again
 * later. One bought again after another was set to end is no second one. And a renewal refunded in
 * full, tax on top, no longer counts as paid.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import {
  customerState,
  orderEvent,
  refundedAlready,
  type StateSubscription,
  stateChanged,
} from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { UserActor } from '../actor.ts'
import { billingFacts } from './persistence.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

/** A Plus subscription as a customer's state lists it, made at `made`. */
const listed = (id: string, made: Date): StateSubscription => ({
  ...(customerState(null).active_subscriptions[0] as StateSubscription),
  id,
  created_at: made.toISOString(),
  started_at: made.toISOString(),
  current_period_start: made.toISOString(),
})

/** Polar's word that the account pays for `subs` now, the newest listed first, and its delivery's answer. */
const paying = (owner: UserActor, subs: StateSubscription[]) => {
  const state = customerState(owner.userId, { active_subscriptions: subs })
  w.polar.states.set(owner.userId, state)
  return w.post(stateChanged(state))
}

/** What Blockly keeps of the account's subscriptions, by id. */
const kept = async (owner: UserActor) =>
  new Map(
    (
      await w.h.db
        .select()
        .from(schema.billingSubscriptions)
        .where(eq(schema.billingSubscriptions.userId, owner.userId))
    ).map((row) => [row.externalSubscriptionId, row]),
  )

const ended = (sub: string) => w.updates.filter((u) => u.id === sub && u.body.cancel_at_period_end === true)

test.skipIf(!hasDatabase)(
  'two Plus checkouts both paid: the first stays as it is, the second ends with its month and is refunded',
  async () => {
    const owner = await w.h.user('Pia')
    const first = randomUUID()
    const second = randomUUID()
    const earlier = new Date(Date.now() - 10 * MINUTE_MS)
    await paying(owner, [listed(first, earlier)])
    await w.ordered(owner, first, { created_at: earlier.toISOString() })

    // The second's order comes before Polar's word that it pays: it is refunded when that word comes.
    const charged = await w.ordered(owner, second, { created_at: new Date().toISOString() })
    expect(w.refunds).toHaveLength(0)
    await paying(owner, [listed(second, new Date()), listed(first, earlier)])

    expect(ended(second)).toHaveLength(1)
    expect(w.updates.filter((u) => u.id === first)).toHaveLength(0)
    expect(w.refunds).toEqual([
      expect.objectContaining({ order_id: charged, amount: 1500, reason: 'duplicate' }),
    ])
    const subs = await kept(owner)
    expect(subs.get(first)).toMatchObject({ status: 'active', cancelAtPeriodEnd: false })
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('plus')
    expect(await w.audited(owner, 'billing.second_subscription_stopped')).toEqual([
      expect.objectContaining({ subscription: second, plan: 'plus', besides: first }),
    ])

    // Said again, the order and the standing change nothing more.
    await w.post(orderEvent(w.orders.get(charged) as never, 'order.paid'))
    await paying(owner, w.polar.states.get(owner.userId)?.active_subscriptions ?? [])
    expect(ended(second)).toHaveLength(1)
    expect(w.refunds).toHaveLength(1)
    expect(await w.audited(owner, 'billing.second_subscription_refunded')).toEqual([
      expect.objectContaining({ order: charged, subscription: second, refundCents: 1500 }),
    ])
  },
)

test.skipIf(!hasDatabase)(
  'a second subscription’s order that comes after the word it pays is refunded then',
  async () => {
    const owner = await w.h.user('Quin')
    const before = w.refunds.length
    const first = randomUUID()
    const second = randomUUID()
    const earlier = new Date(Date.now() - 10 * MINUTE_MS)
    await paying(owner, [listed(first, earlier)])
    await paying(owner, [listed(first, earlier), listed(second, new Date())])
    expect(ended(second)).toHaveLength(1)
    expect(w.refunds).toHaveLength(before)

    const charged = await w.ordered(owner, second, { created_at: new Date().toISOString() })
    expect(w.refunds.filter((r) => r.order_id === charged)).toEqual([
      expect.objectContaining({ amount: 1500, reason: 'duplicate' }),
    ])
    // The first subscription's own charges are never refunded.
    await w.ordered(owner, first, { created_at: earlier.toISOString() })
    expect(w.refunds).toHaveLength(before + 1)
  },
)

test.skipIf(!hasDatabase)(
  'a month of Plus paid while a year of it runs ends with its month, refunded, and is not a withdrawal',
  async () => {
    const owner = await w.h.user('Rae')
    const yearAt = new Date(Date.now() - 10 * MINUTE_MS)
    await w.paidYear(owner, { created_at: yearAt.toISOString() })
    const month = randomUUID()
    await paying(owner, [listed(month, new Date())])
    const charged = await w.ordered(owner, month, { created_at: new Date().toISOString() })

    expect(ended(month)).toHaveLength(1)
    expect(w.refunds.filter((r) => r.order_id === charged)).toEqual([
      expect.objectContaining({ amount: 1500, reason: 'duplicate' }),
    ])
    // Polar's word on the refund ends nothing at once: the year still runs, and no email says so.
    const held = w.orders.get(charged)
    if (held === undefined) throw new Error('Polar holds no such order')
    const mails = w.h.mail.to(`${owner.userId}@example.test`).length
    await w.post(orderEvent({ ...held, status: 'refunded', refunded_amount: 1500 }, 'order.refunded'))
    expect(w.polar.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
    expect(w.h.mail.to(`${owner.userId}@example.test`)).toHaveLength(mails)
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('plus')
  },
)

test.skipIf(!hasDatabase)(
  'one stopped as a second that becomes the one in force once the first ends pays as any does',
  async () => {
    const owner = await w.h.user('Vic')
    const first = randomUUID()
    const second = randomUUID()
    const earlier = new Date(Date.now() - 10 * MINUTE_MS)
    await paying(owner, [listed(first, earlier)])
    const charged = await w.ordered(owner, second, { created_at: new Date().toISOString() })
    await paying(owner, [listed(second, new Date()), listed(first, earlier)])
    expect(w.refunds.filter((r) => r.order_id === charged)).toHaveLength(1)

    // The first ends, and the owner has the second renew again: it is the one in force now.
    await paying(owner, [listed(second, new Date())])
    expect(await w.audited(owner, 'billing.second_subscription_in_force')).toEqual([
      expect.objectContaining({ subscription: second, plan: 'plus' }),
    ])
    const renewal = await w.ordered(owner, second, { created_at: new Date().toISOString() })
    expect(w.refunds.filter((r) => r.order_id === renewal)).toHaveLength(0)
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('plus')
  },
)

test.skipIf(!hasDatabase)(
  'a refund Polar refuses is noted once and asked again later; the standing goes through',
  async () => {
    const owner = await w.h.user('Tam')
    const first = randomUUID()
    const second = randomUUID()
    const earlier = new Date(Date.now() - 10 * MINUTE_MS)
    await w.ordered(owner, first, { created_at: earlier.toISOString() })
    const refused = await w.ordered(owner, second, { created_at: new Date().toISOString() })
    const answer = w.polar.reply
    w.polar.reply = (request) =>
      request.method === 'POST' && request.path === '/v1/refunds/' ? refundedAlready : answer(request)

    const delivered = await paying(owner, [listed(second, new Date()), listed(first, earlier)])
    expect(delivered.ok).toBe(true)
    expect((await kept(owner)).get(first)).toMatchObject({ status: 'active', cancelAtPeriodEnd: false })
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('plus')
    expect(ended(second)).toHaveLength(1)
    expect(await w.audited(owner, 'billing.second_subscription_refund_not_taken')).toEqual([
      expect.objectContaining({ order: refused, subscription: second }),
    ])

    // The order's own word, while Polar still refuses as before, is kept as any order's is, and the
    // same refusal is not noted twice.
    const still = await w.post(orderEvent(w.orders.get(refused) as never, 'order.updated'))
    expect(still.ok).toBe(true)
    expect(await w.audited(owner, 'billing.second_subscription_refund_not_taken')).toHaveLength(1)

    // The order's next word asks for its refund again, and Polar takes it this time.
    w.polar.reply = answer
    await w.post(orderEvent(w.orders.get(refused) as never, 'order.updated'))
    expect(w.refunds.filter((r) => r.order_id === refused)).toEqual([
      expect.objectContaining({ amount: 1500, reason: 'duplicate' }),
    ])
  },
)

test.skipIf(!hasDatabase)(
  'a second subscription found after it renewed has its newest charge refunded and the older ones held for a person',
  async () => {
    const owner = await w.h.user('Uli')
    const first = randomUUID()
    const second = randomUUID()
    const earlier = new Date(Date.now() - 90 * MINUTE_MS)
    await w.ordered(owner, first, { created_at: earlier.toISOString() })
    const older = await w.ordered(owner, second, {
      created_at: new Date(Date.now() - 60 * MINUTE_MS).toISOString(),
    })
    const newest = await w.ordered(owner, second, { created_at: new Date().toISOString() })

    const ours = () => w.refunds.filter((r) => r.order_id === older || r.order_id === newest)
    await paying(owner, [listed(second, new Date(Date.now() - 60 * MINUTE_MS)), listed(first, earlier)])
    expect(ours().map((r) => r.order_id)).toEqual([newest])
    expect(await w.audited(owner, 'billing.second_subscription_refund_held')).toEqual([
      expect.objectContaining({ order: older, subscription: second, cents: 1500 }),
    ])

    // Said again, the older charge is neither refunded nor noted twice, and its own word holds it too.
    await paying(owner, w.polar.states.get(owner.userId)?.active_subscriptions ?? [])
    await w.post(orderEvent(w.orders.get(older) as never, 'order.updated'))
    expect(ours().map((r) => r.order_id)).toEqual([newest])
    expect(await w.audited(owner, 'billing.second_subscription_refund_held')).toHaveLength(1)
  },
)

test.skipIf(!hasDatabase)(
  'Polar not answering a refund fails the order’s word, and the word delivered again refunds it',
  async () => {
    const owner = await w.h.user('Wen')
    const first = randomUUID()
    const second = randomUUID()
    const earlier = new Date(Date.now() - 10 * MINUTE_MS)
    await paying(owner, [listed(first, earlier)])
    await paying(owner, [listed(second, new Date()), listed(first, earlier)])
    const answer = w.polar.reply
    w.polar.reply = (request) =>
      request.method === 'POST' && request.path === '/v1/refunds/'
        ? { status: 503, body: {} }
        : answer(request)

    const charged = await w.ordered(owner, second, { created_at: new Date().toISOString() })
    expect(w.refunds.filter((r) => r.order_id === charged)).toHaveLength(0)
    expect(await w.audited(owner, 'billing.second_subscription_refund_not_taken')).toEqual([])

    w.polar.reply = answer
    const again = await w.post(orderEvent(w.orders.get(charged) as never, 'order.paid'))
    expect(again.ok).toBe(true)
    expect(w.refunds.filter((r) => r.order_id === charged)).toHaveLength(1)
  },
)

test.skipIf(!hasDatabase)(
  'Polar not answering a refund during a sync fails the sync, and the word delivered again refunds it',
  async () => {
    const owner = await w.h.user('Xia')
    const first = randomUUID()
    const second = randomUUID()
    const earlier = new Date(Date.now() - 10 * MINUTE_MS)
    await paying(owner, [listed(first, earlier)])
    const charged = await w.ordered(owner, second, { created_at: new Date().toISOString() })
    const answer = w.polar.reply
    w.polar.reply = (request) =>
      request.method === 'POST' && request.path === '/v1/refunds/'
        ? { status: 503, body: {} }
        : answer(request)

    const failed = await paying(owner, [listed(second, new Date()), listed(first, earlier)])
    expect(failed.ok).toBe(false)
    expect(await w.audited(owner, 'billing.second_subscription_refund_not_taken')).toEqual([])

    w.polar.reply = answer
    const again = await paying(owner, w.polar.states.get(owner.userId)?.active_subscriptions ?? [])
    expect(again.ok).toBe(true)
    expect(w.refunds.filter((r) => r.order_id === charged)).toHaveLength(1)
  },
)

test.skipIf(!hasDatabase)(
  'one subscription set to end and one bought after it that renews: the renewing one is in force, untouched',
  async () => {
    const owner = await w.h.user('Uma')
    const ending = randomUUID()
    const again = randomUUID()
    const earlier = new Date(Date.now() - 10 * MINUTE_MS)
    const endingListed = { ...listed(ending, earlier), cancel_at_period_end: true }
    await paying(owner, [endingListed])
    await w.ordered(owner, ending, { created_at: earlier.toISOString() })
    const charged = await w.ordered(owner, again, { created_at: new Date().toISOString() })
    await paying(owner, [listed(again, new Date()), endingListed])

    expect(w.updates.filter((u) => u.id === again || u.id === ending)).toHaveLength(0)
    expect(w.refunds.filter((r) => r.order_id === charged)).toHaveLength(0)
    expect((await kept(owner)).get(again)).toMatchObject({ status: 'active', cancelAtPeriodEnd: false })
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('plus')
    expect(await w.audited(owner, 'billing.second_subscription_stopped')).toEqual([])
  },
)

test.skipIf(!hasDatabase)('a renewal refunded in full, tax on top, no longer counts as paid', async () => {
  const { owner, sub } = await w.subscriber('Sol')
  const renewal = (refunded: number) =>
    w.ordered(owner, sub, {
      billing_reason: 'subscription_cycle',
      status: refunded === 1500 ? 'refunded' : 'partially_refunded',
      net_amount: 1500,
      tax_amount: 300,
      total_amount: 1800,
      refunded_amount: refunded,
      refunded_tax_amount: (refunded * 300) / 1500,
    })
  await renewal(1500)
  expect((await billingFacts(w.h.db, owner.userId)).paidRenewals).toBe(0)
  await renewal(700)
  expect((await billingFacts(w.h.db, owner.userId)).paidRenewals).toBe(1)
})
