/**
 * Payments that carry extra play, through the real Polar adapter against a stand-in for Polar's
 * API: when one that didn't go through is owed (only once Polar, asked again, says it is still
 * unpaid), and what an owner pays it with, the balance: what clears it, and what never does. And
 * which of an account's subscriptions its billing reads, when it has more than one.
 *
 * Counting and sending extra play, and the first fail → told → owed → blocked run, are in
 * `extra-usage.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import { PLUS_PRODUCT, subscription } from '../../testing/polar.ts'
import { BALANCE, PolarWorld } from '../../testing/polar-world.ts'
import type { UserActor } from '../actor.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

/** An hour on, when an order made now may be owed. */
const anHourOn = () => new Date(Date.now() + 61 * 60_000)

const extraOf = async (owner: UserActor) => (await w.h.app.accountQueries.overview(owner)).usage.extra

/** A server the owner made and stopped. */
const stoppedServer = async (owner: UserActor) => {
  const { h } = w
  const server = await h.create(owner)
  await h.until(server.id, 'running')
  await h.settled(server.id)
  await h.app.servers.stop(owner, server.id, crypto.randomUUID(), 'user')
  await h.until(server.id, 'stopped')
  await h.settled(server.id)
  return server
}

test.skipIf(!hasDatabase)(
  'a cancelled subscription’s final charge is owed only once it failed or was voided, an hour on',
  async () => {
    const { owner, sub } = await w.subscriber('Zia')
    const server = await stoppedServer(owner)
    // Set to end, then ended: its final charge, with the extra on it, is made and waits.
    await w.subscriptionNow(owner, sub, { status: 'canceled' })
    const madeAt = new Date()
    const final = await w.renewalWithExtra(owner, sub, madeAt)
    // Made a moment ago: nothing owed, nothing emailed, the server starts.
    await w.h.app.billing.tellAboutPayments()
    expect(await extraOf(owner)).toMatchObject({ owedCents: 0, settleCents: 0 })
    expect(await w.mailTo(owner)).toEqual([])
    await w.h.app.servers.start(owner, server.id, crypto.randomUUID())
    await w.h.until(server.id, 'running')
    await w.h.settled(server.id)
    // An hour on, still pending and not yet tried: still not owed.
    expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(0)
    // Tried and declined: owed, and the server stops for it.
    w.declined.add(final)
    expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(1)
    expect(await extraOf(owner)).toMatchObject({ owedCents: 1750, settleCents: 1750 })
    expect((await w.h.until(server.id, 'stopped')).lifecycle.stopReason).toBe('unpaid')
    // Another, voided by Polar without a try, is owed too.
    await w.renewalWithExtra(owner, sub, madeAt, { status: 'void' })
    expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(1)
    expect(await extraOf(owner)).toMatchObject({ owedCents: 3500 })
  },
  60_000,
)

test.skipIf(!hasDatabase)(
  'a week-old charge Polar says was paid, its webhook lost, is never owed or emailed',
  async () => {
    const { owner, sub } = await w.subscriber('Ada')
    const weekAgo = new Date(Date.now() - 8 * 24 * 3_600_000)
    // Pending a week while the subscription stays active: the paid webhook never came.
    const renewal = await w.renewalWithExtra(owner, sub, weekAgo)
    w.declined.add(renewal)
    w.orders.set(renewal, { ...w.orders.get(renewal), status: 'paid', paid: true })
    await w.h.app.billing.tellAboutPayments()
    expect(await w.mailTo(owner)).toEqual([])
    expect(await extraOf(owner)).toMatchObject({ owedCents: 0 })
    expect(await w.kept(renewal)).toMatchObject({ status: 'paid', owedAt: null })
    // One Polar says is still unpaid after the week is owed, and emailed once.
    await w.renewalWithExtra(owner, sub, weekAgo)
    await w.h.app.billing.tellAboutPayments()
    await w.h.app.billing.tellAboutPayments()
    expect(await extraOf(owner)).toMatchObject({ owedCents: 1750 })
    expect((await w.mailTo(owner)).map((m) => m.subject)).toEqual([
      'Your Cubepals servers can’t start until a payment is made',
    ])
  },
  60_000,
)

test.skipIf(!hasDatabase)('Polar not answering leaves an order unowed until it does', async () => {
  const { owner, sub } = await w.subscriber('Bo')
  await w.subscriptionNow(owner, sub, { status: 'canceled' })
  await w.renewalWithExtra(owner, sub, new Date(), { status: 'void' })
  w.polar.down = true
  try {
    expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(0)
  } finally {
    w.polar.down = false
  }
  expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(1)
})

test.skipIf(!hasDatabase)(
  'Polar refusing to show an order leaves it unowed, and the sweep goes on',
  async () => {
    const { owner, sub } = await w.subscriber('Cy')
    await w.subscriptionNow(owner, sub, { status: 'canceled' })
    await w.renewalWithExtra(owner, sub, new Date(), { status: 'void' })
    // A token without orders:read, say: an answer that isn't Polar being down.
    const answer = w.polar.reply
    w.polar.reply = (request) =>
      request.path.startsWith('/v1/orders/')
        ? { status: 403, body: { detail: 'Forbidden' } }
        : answer(request)
    expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(0)
    expect(await w.h.app.billing.sweep(anHourOn())).toBe(0)
    w.polar.reply = answer
    expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(1)
  },
)

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { message?: string }) => error.message ?? '',
  )

/** An owner owing $17.50, `tax` on top, that Polar can no longer collect: its subscription ended. */
const owingBalance = async (name: string, tax = 0) => {
  const { owner, sub } = await w.subscriber(name)
  const madeAt = new Date()
  await w.subscriptionNow(owner, sub, { status: 'canceled' })
  const renewal = await w.renewalWithExtra(owner, sub, madeAt, { status: 'void', tax })
  expect(await w.h.app.billing.confirmOwed(anHourOn())).toBeGreaterThanOrEqual(1)
  return { owner, sub, renewal, madeAt }
}

test.skipIf(!hasDatabase)(
  'what Polar can no longer collect is paid as a balance, and paying clears it for good',
  async () => {
    const { owner, sub } = await w.subscriber('Yan')
    const madeAt = new Date()
    // $17.50 with $3.33 of tax on top: $20.83 owed.
    const renewal = await w.renewalWithExtra(owner, sub, madeAt, { tax: 333 })
    // Still tried: paid by fixing the card, never offered as a balance as well.
    await w.subscriptionNow(owner, sub, {
      status: 'past_due',
      past_due_at: madeAt.toISOString(),
      ended_at: null,
    })
    w.declined.add(renewal)
    expect(await refusal(w.h.app.billing.settleBalance(owner))).toBe(
      'Nothing to pay here. A payment still being tried is paid in Manage billing.',
    )
    // Ended, and voided by Polar: owed once Polar says so again, and paid here, naming the order.
    await w.subscriptionNow(owner, sub, { status: 'canceled' })
    await w.renewalWithExtra(owner, sub, madeAt, { status: 'void', id: renewal, tax: 333 })
    expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(1)
    expect(await extraOf(owner)).toMatchObject({ owedCents: 2083, settleCents: 2083 })
    const { url } = await w.h.app.billing.settleBalance(owner)
    // Priced at what it came to before tax, with tax on top, so tax is never charged twice; and
    // no discount code can make it less.
    expect([...w.checkouts.values()].find((c) => c.url === url)).toMatchObject({
      products: [BALANCE],
      prices: {
        [BALANCE]: [
          { amount_type: 'fixed', price_amount: 1750, price_currency: 'usd', tax_behavior: 'exclusive' },
        ],
      },
      allow_discount_codes: false,
      metadata: { settles: renewal },
      external_customer_id: owner.userId,
    })
    // A paid order that isn't for the balance product clears nothing, whatever its metadata says.
    await w.paidBalance(owner, renewal, 1750, { product_id: PLUS_PRODUCT, subscription_id: sub })
    await w.paidBalance(owner, renewal, 1750, { product_id: '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c0ff' })
    expect(await extraOf(owner)).toMatchObject({ owedCents: 2083 })
    // A balance paid for less than was owed before tax (a code, an amount changed) clears nothing,
    // and is kept for an admin.
    const short = await w.paidBalance(owner, renewal, 1500, { discount_amount: 250, subtotal_amount: 1750 })
    expect(await extraOf(owner)).toMatchObject({ owedCents: 2083 })
    expect(await w.audited(owner, 'billing.balance_short')).toEqual([
      { order: short, paidCents: 1500, owedCents: 1750, orders: [renewal] },
    ])
    // Paid in full, its tax on top: the block clears on its own, and Polar's word about the void
    // order again changes nothing.
    const paid = await w.paidBalance(owner, renewal, 1750, { tax_amount: 333, total_amount: 2083 })
    await w.renewalWithExtra(owner, sub, madeAt, { status: 'void', id: renewal, tax: 333 })
    const after = await w.h.app.accountQueries.overview(owner)
    expect(after.usage.extra).toMatchObject({ owedCents: 0, settleCents: 0 })
    expect(after.features.find((f) => f.feature === 'create_server')).toMatchObject({ available: true })
    expect(await w.audited(owner, 'billing.balance_settled')).toEqual([
      { order: paid, paidCents: 1750, owedCents: 1750, orders: [renewal] },
    ])
    expect(w.refunds).toEqual([])
  },
  60_000,
)

test.skipIf(!hasDatabase)('paying again opens the checkout already open, not a second', async () => {
  const { owner } = await owingBalance('Cy')
  const first = await w.h.app.billing.settleBalance(owner)
  expect(await w.h.app.billing.settleBalance(owner)).toEqual(first)
  const mine = () => [...w.checkouts.values()].filter((c) => c.external_customer_id === owner.userId)
  expect(mine()).toHaveLength(1)
  // Once it has expired, or nearly, a new one.
  for (const checkout of mine()) checkout.expires_at = new Date(Date.now() + 5 * 60_000).toISOString()
  expect(await w.h.app.billing.settleBalance(owner)).not.toEqual(first)
  expect(mine()).toHaveLength(2)
})

test.skipIf(!hasDatabase)(
  'a balance paid for orders already paid is refunded at once, and only once',
  async () => {
    const { owner, renewal } = await owingBalance('Dee')
    const first = await w.paidBalance(owner, renewal, 1750)
    expect(await extraOf(owner)).toMatchObject({ owedCents: 0 })
    // The same orders paid again, from a second checkout: given back in full, before tax.
    const again = await w.paidBalance(owner, renewal, 1750, { tax_amount: 333, total_amount: 2083 })
    expect(w.refunds.filter((r) => r.order_id === again)).toEqual([
      {
        order_id: again,
        amount: 1750,
        reason: 'duplicate',
        comment: 'Paid for orders that were already paid.',
      },
    ])
    expect(await w.audited(owner, 'billing.balance_overpaid_refunded')).toEqual([
      { order: again, refundCents: 1750, orders: [renewal] },
    ])
    // Polar's word about it again, paid, then refunded: nothing more is given back, nothing owed.
    await w.paidBalance(owner, renewal, 1750, { id: again, tax_amount: 333, total_amount: 2083 })
    await w.ordered(
      owner,
      null,
      { ...w.orders.get(again), status: 'refunded', refunded_amount: 1750 },
      'order.refunded',
    )
    expect(w.refunds.filter((r) => r.order_id === again)).toHaveLength(1)
    expect(w.refunds.some((r) => r.order_id === first)).toBe(false)
    expect(await extraOf(owner)).toMatchObject({ owedCents: 0 })
  },
  60_000,
)

test.skipIf(!hasDatabase)('a refund Polar didn’t take is asked for again on its next delivery', async () => {
  const { owner, renewal } = await owingBalance('Eli')
  await w.paidBalance(owner, renewal, 1750)
  const reply = w.polar.reply
  w.polar.reply = (request) =>
    request.path.startsWith('/v1/refunds') ? { status: 503, body: { detail: 'maintenance' } } : reply(request)
  const again = await w.paidBalance(owner, renewal, 1750)
  expect(w.refunds.filter((r) => r.order_id === again)).toHaveLength(0)
  w.polar.reply = reply
  await w.paidBalance(owner, renewal, 1750, { id: again })
  await w.paidBalance(owner, renewal, 1750, { id: again })
  expect(w.refunds.filter((r) => r.order_id === again)).toHaveLength(1)
})

test.skipIf(!hasDatabase)('a balance refunded leaves what it paid owed again', async () => {
  const { owner, renewal } = await owingBalance('Fay')
  const paid = await w.paidBalance(owner, renewal, 1750)
  expect(await extraOf(owner)).toMatchObject({ owedCents: 0 })
  await w.ordered(
    owner,
    null,
    { ...w.orders.get(paid), status: 'refunded', refunded_amount: 1750 },
    'order.refunded',
  )
  expect(await extraOf(owner)).toMatchObject({ owedCents: 1750, settleCents: 1750 })
  expect(await w.audited(owner, 'billing.balance_refunded')).toEqual([
    { order: paid, refundedCents: 1750, owedCents: 1750, orders: [renewal] },
  ])
  // Owed again, it blocks again.
  expect(
    (await w.h.app.accountQueries.overview(owner)).features.find((f) => f.feature === 'create_server'),
  ).toMatchObject({
    available: false,
  })
})

test.skipIf(!hasDatabase)('an old past-due subscription never hides a newer one that pays', async () => {
  const owner = await w.h.user('Gil')
  const old = randomUUID()
  await w.standing(owner, old, { created_at: '2026-09-01T00:00:00Z' })
  await w.ordered(owner, old, { created_at: new Date().toISOString() })
  // Its renewal fails and Polar retries it; a new subscription, made since, pays.
  w.subscriptions.set(
    old,
    subscription(old, { status: 'past_due', past_due_at: new Date().toISOString(), ended_at: null }),
  )
  const fresh = randomUUID()
  await w.standing(owner, fresh, { created_at: new Date().toISOString() })
  // Every sync writes the past-due one again, after the one that pays.
  await w.standing(owner, fresh, { created_at: new Date().toISOString() })
  const subs = await w.h.db
    .select()
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.userId, owner.userId))
  const byId = new Map(subs.map((row) => [row.externalSubscriptionId, row]))
  expect(byId.get(old)).toMatchObject({ status: 'past_due' })
  expect((byId.get(old)?.updatedAt.getTime() ?? 0) >= (byId.get(fresh)?.updatedAt.getTime() ?? 0)).toBe(true)
  // The one that pays speaks for the account: extra play may be allowed.
  expect(await w.h.app.accounts.allowExtraPlay(owner, 20)).toBe(20)
  expect(await extraOf(owner)).toMatchObject({ may: true })
})
