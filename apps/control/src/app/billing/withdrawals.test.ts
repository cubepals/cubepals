// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cancelling a purchase within 14 days from the account page, through the real Polar adapter
 * against a stand-in for Polar's API: what each kind gives back on each side of the Refunds page's
 * line and of once per person, that the purchase stops at once and the request is kept once, that
 * the refund a person later pays at Polar ends nothing twice and tells nobody again, the refusals
 * (day 15, a renewal, another account's order, a second request), and that nothing on the way ever
 * asks Polar for a refund.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type CheckoutConsent, TERMS_VERSION } from '@blockly/contracts'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { hasDatabase } from '../../testing/harness.ts'
import { orderEvent } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import type { UserActor } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { chippedInLeft } from './chip-in-meter.ts'
import { codeHash, codeHint, newCode } from './gift-codes.ts'

const w = new PolarWorld()
const db = test.skipIf(!hasDatabase)
const HOURS = entitlementsFor('plus').includedUnits ?? Number.NaN

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

let refundsAsked: ReturnType<typeof spyOn> | null = null
beforeEach(() => {
  w.reset()
  if (w.billing !== null) refundsAsked = spyOn(w.billing, 'refund')
})

// Nothing a test here does ever asks Polar to pay money back.
afterEach(() => {
  if (!hasDatabase) return
  expect(refundsAsked?.mock.calls ?? []).toEqual([])
  expect(w.polar.requests.filter((r) => r.path.startsWith('/v1/refunds') && r.method === 'POST')).toEqual([])
  expect(w.refunds).toEqual([])
  refundsAsked?.mockRestore()
})

/** A new Plus subscriber whose first month was paid `daysAgo` days ago. */
async function firstMonth(name: string, daysAgo: number) {
  const owner = await w.h.user(name)
  const sub = randomUUID()
  await w.standing(owner, sub)
  const order = await w.ordered(owner, sub, {
    created_at: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
  })
  return { owner, sub, order }
}

/** A server of the owner's that ran `hours` on the clock at `tier`, ending a minute ago. */
async function played(owner: UserActor, hours: number, tier = '3g') {
  const server = await w.h.create(owner)
  await w.h.until(server.id, 'running')
  await w.h.settled(server.id)
  await w.h.app.servers.stop(owner, server.id, randomUUID(), 'user')
  await w.h.until(server.id, 'stopped')
  await w.h.settled(server.id)
  // The real run took a moment; what counts is the one written here.
  await w.h.db.delete(schema.powerIntervals).where(eq(schema.powerIntervals.serverId, server.id))
  if (hours > 0)
    await w.h.db.insert(schema.powerIntervals).values({
      serverId: server.id,
      memoryTier: tier,
      startedAt: new Date(Date.now() - MINUTE_MS - hours * HOUR_MS),
      stoppedAt: new Date(Date.now() - MINUTE_MS),
    })
  return server
}

/** An admin, whose own email is the operator's inbox when none is configured. */
async function admin(): Promise<string> {
  const person = await w.h.user('Admin')
  await w.h.db.insert(schema.platformAdmins).values({ userId: person.userId, grantedBy: 'config' })
  return `${person.userId}@example.test`
}

const refusal = async (call: Promise<unknown>) => {
  const error = await call.catch((e: unknown) => e)
  if (error instanceof AppError) return error.message
  if (error instanceof NotFound) return 'not found'
  throw new Error(`expected a refusal, got ${String(error)}`)
}

const withdrawals = () => w.h.app.billing.withdrawals
const kept = (order: string) =>
  w.h.db.select().from(schema.billingWithdrawals).where(eq(schema.billingWithdrawals.externalOrderId, order))
const subjects = async (owner: UserActor) => (await w.mailTo(owner, true)).map((m) => m.subject)

db('a first month cancelled below the line: Plus ends now, everything back, each told once', async () => {
  const inbox = await admin()
  const { owner, sub, order } = await firstMonth('Ana', 3)
  await played(owner, 10)
  expect(await withdrawals().list(owner)).toMatchObject([
    {
      order,
      kind: 'plan',
      title: 'your first month of Plus',
      refundCents: 1500,
      rule: 'full',
      hoursPlayed: 10,
    },
  ])

  const asked = w.polar.requests.length
  const view = await withdrawals().request(owner, order)
  expect(view).toMatchObject({ order, refundCents: 1500, rule: 'full', requestedAt: expect.any(String) })
  // Ended at Polar, so it never renews, and here, as a withdrawal.
  expect(
    w.polar.requests
      .slice(asked)
      .some((r) => r.path.startsWith(`/v1/subscriptions/${sub}`) && r.method === 'DELETE'),
  ).toBe(true)
  const overview = await w.h.app.accountQueries.overview(owner)
  expect(overview.plan).toMatchObject({ key: 'free', billed: { status: 'ended', endedFor: 'withdrawal' } })
  expect(await kept(order)).toMatchObject([
    { kind: 'plan', playedMilli: 10_000, refundCents: 1500, rule: 'full' },
  ])
  expect(await w.audited(owner, 'billing.withdrawal_requested')).toMatchObject([
    { order, kind: 'plan', refundCents: 1500, rule: 'full', source: 'user' },
  ])

  // The person: what they bought, then the acknowledgement, with when it was received.
  expect(await subjects(owner)).toEqual([
    'Your Cubepals purchase: your first month of Plus',
    'We received your cancellation: your first month of Plus',
  ])
  const ack = (await w.mailTo(owner, true)).at(-1)?.text ?? ''
  expect(ack).toContain('UTC')
  expect(ack).toContain('a full refund of $15.00')
  expect(ack).toContain('within 14 days')
  // The operator: who, which order, the hours, what the rule gives, and no earlier full refund.
  const told = w.h.mail.to(inbox)
  expect(told).toHaveLength(1)
  expect(told[0]?.subject).toBe('Cubepals: refund to pay by hand, $15.00')
  for (const said of [owner.userId, order, 'Hours played: 10', '(full)', 'earlier purchase: no'])
    expect(told[0]?.text).toContain(said)

  // Asked again: refused kindly, and nothing more happens.
  expect(await refusal(withdrawals().request(owner, order))).toMatch(/^You cancelled this on .* already\./)

  // The refund paid by hand at Polar arrives: nothing ends twice, and nobody is told again.
  const before = w.polar.requests.length
  const held = w.orders.get(order)
  if (held === undefined) throw new Error('no order')
  await w.post(orderEvent({ ...held, status: 'refunded', refunded_amount: 1500 }, 'order.refunded'))
  expect(w.polar.requests.slice(before).filter((r) => r.method === 'DELETE')).toEqual([])
  expect(await subjects(owner)).toHaveLength(2)
  expect(w.h.mail.to(inbox)).toHaveLength(1)
  expect(await w.audited(owner, 'billing.subscription_revoked')).toHaveLength(1)
  expect(await kept(order)).toMatchObject([{ refundCents: 1500, playedMilli: 10_000 }])
  expect(await withdrawals().list(owner)).toMatchObject([{ order, requestedAt: expect.any(String) }])
})

db('at the line, the hours played are paid for; play after the request changes nothing', async () => {
  const { owner, order } = await firstMonth('Bo', 3)
  const server = await played(owner, 20, '8g')
  const view = await withdrawals().request(owner, order)
  const refund = 1500 - Math.floor((1500 * 40) / HOURS)
  expect(view).toMatchObject({ rule: 'played', hoursPlayed: 40, refundCents: refund })
  await w.h.db.insert(schema.powerIntervals).values({
    serverId: server.id,
    memoryTier: '3g',
    startedAt: new Date(Date.now() - 30 * MINUTE_MS),
    stoppedAt: new Date(),
  })
  expect(await kept(order)).toMatchObject([{ playedMilli: 40_000, refundCents: refund }])
  expect(await withdrawals().list(owner)).toMatchObject([{ order, refundCents: refund, hoursPlayed: 40 }])
})

db('the full refund is once per person: a later plan pays for the hours played', async () => {
  const { owner, order } = await firstMonth('Cy', 3)
  expect(await withdrawals().request(owner, order)).toMatchObject({ rule: 'full', refundCents: 1500 })
  const again = randomUUID()
  await w.standing(owner, again)
  const second = await w.ordered(owner, again, { created_at: new Date(Date.now() - DAY_MS).toISOString() })
  await played(owner, 5)
  const view = await withdrawals().request(owner, second)
  expect(view).toMatchObject({ rule: 'played', refundCents: 1500 - Math.floor((1500 * 5) / HOURS) })
  expect(await kept(second)).toMatchObject([{ earlierFull: true }])
})

db('refused: day 15, a renewal, another account’s order; and two at once keep one', async () => {
  const late = await firstMonth('Di', 15)
  expect(await withdrawals().list(late.owner)).toEqual([])
  expect(await refusal(withdrawals().request(late.owner, late.order))).toMatch(
    /^The 14 days to cancel your first month of Plus ended on /,
  )

  const { owner, sub, order } = await firstMonth('Eve', 2)
  const renewal = await w.ordered(owner, sub, {
    billing_reason: 'subscription_cycle',
    created_at: new Date().toISOString(),
  })
  expect(await refusal(withdrawals().request(owner, renewal))).toMatch(/^A renewal isn’t a new purchase/)
  expect((await withdrawals().list(owner)).map((p) => p.order)).toEqual([order])

  const stranger = await w.h.user('Fox')
  expect(await refusal(withdrawals().request(stranger, order))).toBe('not found')

  const both = await Promise.allSettled([
    withdrawals().request(owner, order),
    withdrawals().request(owner, order),
  ])
  expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(await kept(order)).toHaveLength(1)
  expect(await w.audited(owner, 'billing.withdrawal_requested')).toHaveLength(1)
  expect((await subjects(owner)).filter((s) => s.startsWith('We received'))).toHaveLength(1)
})

db('a year ends now, and the refund that follows moves its end no further', async () => {
  const owner = await w.h.user('Gil')
  const order = await w.paidYear(owner, { created_at: new Date().toISOString() })
  expect((await w.h.app.accountQueries.overview(owner)).plan.key).toBe('plus')
  expect(await withdrawals().request(owner, order)).toMatchObject({
    kind: 'year',
    title: 'a year of Plus',
    rule: 'full',
    refundCents: 15000,
  })
  expect((await w.h.app.accountQueries.overview(owner)).plan.key).toBe('free')
  const [year] = await w.h.db.select().from(schema.planYears).where(eq(schema.planYears.userId, owner.userId))
  expect(year?.endsAt.getTime()).toBeLessThanOrEqual(Date.now())
  expect(await w.audited(owner, 'billing.year_ended')).toHaveLength(1)

  const held = w.orders.get(order)
  if (held === undefined) throw new Error('no order')
  await w.post(orderEvent({ ...held, status: 'refunded', refunded_amount: 15000 }, 'order.refunded'))
  const [after] = await w.h.db
    .select()
    .from(schema.planYears)
    .where(eq(schema.planYears.userId, owner.userId))
  expect(after?.endsAt).toEqual(year?.endsAt as Date)
  expect(await w.audited(owner, 'billing.year_shortened')).toEqual([])
  expect(await subjects(owner)).toEqual([
    'Your Cubepals purchase: a year of Plus',
    'We received your cancellation: a year of Plus',
  ])
})

/** A gift of a month of Plus the buyer paid for today, kept as its paid order makes it; and its code. */
async function giftBought(buyer: UserActor) {
  const order = `gift-${randomUUID()}`
  await w.h.db.insert(schema.billingOrders).values({
    provider: 'polar',
    externalOrderId: order,
    userId: buyer.userId,
    billingReason: 'purchase',
    currency: 'usd',
    subtotalCents: 1500,
    discountCents: 0,
    netCents: 1500,
    taxCents: 0,
    totalCents: 1500,
    orderedAt: new Date(),
  })
  const code = newCode()
  await w.h.db.insert(schema.planGifts).values({
    provider: 'polar',
    externalOrderId: order,
    buyerId: buyer.userId,
    planKey: 'plus',
    months: 1,
    codeHash: codeHash(code),
    codeHint: codeHint(code),
    emailedAt: new Date(),
  })
  return { order, code }
}

db('a gift nobody redeemed comes back whole, and its code stops working', async () => {
  const buyer = await w.h.user('Hal')
  const { order, code } = await giftBought(buyer)
  expect(await withdrawals().request(buyer, order)).toMatchObject({
    kind: 'gift',
    rule: 'unredeemed',
    refundCents: 1500,
    hoursPlayed: null,
  })
  expect(await refusal(w.h.app.billing.gifts.redeem(await w.h.user('Ivy'), code))).toMatch(/doesn’t work/)
  // The refund paid by hand arrives: the gift was voided already, and nothing more is written.
  const [row] = await w.h.db
    .select()
    .from(schema.billingOrders)
    .where(eq(schema.billingOrders.externalOrderId, order))
  if (row === undefined) throw new Error('no order')
  await w.h.app.billing.gifts.received('polar', {
    ...row,
    userId: buyer.userId,
    refundedCents: 1500,
    status: 'refunded',
    externalSubscriptionId: null,
    settles: [],
    balance: false,
    chipIn: null,
    paysForYear: false,
    gift: { id: 'gift-product', planKey: 'plus', months: 1, priceCents: 1500 },
  })
  expect(await w.audited(buyer, 'billing.gift_refunded')).toEqual([])
  expect(await w.audited(buyer, 'billing.gift_withdrawn')).toHaveLength(1)
})

db('a redeemed gift ends on the account that redeemed it', async () => {
  const buyer = await w.h.user('Jo')
  const friend = await w.h.user('Kit')
  const { order, code } = await giftBought(buyer)
  await w.h.app.billing.gifts.redeem(friend, code)
  expect((await w.h.app.accountQueries.overview(friend)).plan.key).toBe('plus')
  expect(await withdrawals().request(buyer, order)).toMatchObject({ rule: 'full', hoursPlayed: 0 })
  expect((await w.h.app.accountQueries.overview(friend)).plan.key).toBe('free')
  // The friend who redeemed it can't cancel what the buyer paid for.
  expect(await refusal(withdrawals().request(friend, order))).toBe('not found')
})

db('a chip-in gives back its unplayed share, the newest chip-ins taken as the last played', async () => {
  const { owner } = await w.subscriber('Lu')
  const server = await played(owner, 0)
  const first = await w.h.user('Mo')
  const second = await w.h.user('Ned')
  const older = await w.chippedIn(first, server.id, 500, { created_at: new Date().toISOString() })
  await w.chippedIn(second, server.id, 500, { created_at: new Date().toISOString() })
  // Five hours of the forty were played, and drawn.
  const now = Date.now()
  await w.h.db.insert(schema.chipInDraws).values({
    serverId: server.id,
    ownerId: owner.userId,
    startedAt: new Date(now - 6 * HOUR_MS),
    endedAt: new Date(now - HOUR_MS),
    rate: 1,
  })
  await w.h.db.insert(schema.chipInMarks).values({ userId: owner.userId, drawnThrough: new Date() })
  expect((await chippedInLeft(w.h.db, owner.userId)).get(server.id)).toBeCloseTo(35, 3)

  expect(await withdrawals().request(first, older)).toMatchObject({
    kind: 'chip_in',
    rule: 'unplayed',
    hoursPlayed: 5,
    refundCents: 375,
  })
  // Its fifteen unplayed hours are gone from the server; the newer chip-in's twenty stay.
  expect((await chippedInLeft(w.h.db, owner.userId)).get(server.id)).toBeCloseTo(20, 3)
  const held = w.orders.get(older)
  if (held === undefined) throw new Error('no order')
  await w.post(orderEvent({ ...held, status: 'partially_refunded', refunded_amount: 375 }, 'order.refunded'))
  expect((await chippedInLeft(w.h.db, owner.userId)).get(server.id)).toBeCloseTo(20, 3)
})

db('a chip-in asks what checkout asks, and keeps it', async () => {
  const { owner } = await w.subscriber('Oz')
  const server = await played(owner, 0)
  const friend = await w.h.user('Pia')
  const reached = await w.h.app.sharingQueries.reach({ code: server.inviteCode }, friend)
  // What an old page, or a hand-made request, sends: not what the contract's type allows.
  const start = (consent: unknown) =>
    w.h.app.billing.chipIns.start(
      friend,
      reached?.server ?? null,
      500,
      reached?.page ?? '/',
      consent as CheckoutConsent | undefined,
    )
  expect(await refusal(start(undefined))).toMatch(/^Agree to the Terms/)
  expect(await refusal(start({ terms: TERMS_VERSION, startNow: false }))).toMatch(/^Agree to the Terms/)
  await start({ terms: TERMS_VERSION, startNow: true })
  expect(await w.audited(friend, 'billing.chip_in_started')).toMatchObject([
    { server: server.id, cents: 500, terms: TERMS_VERSION, startNow: true },
  ])
})

db('what was bought is emailed once, however often Polar delivers it', async () => {
  const { owner, order } = await firstMonth('Quin', 0)
  const held = w.orders.get(order)
  if (held === undefined) throw new Error('no order')
  await w.post(orderEvent(held, 'order.paid'))
  await w.post(orderEvent(held, 'order.updated'))
  const mail = await w.mailTo(owner, true)
  expect(mail.map((m) => m.subject)).toEqual(['Your Cubepals purchase: your first month of Plus'])
  const text = mail[0]?.text ?? ''
  for (const said of [
    'You paid $15.00',
    `${HOURS} hours of play each month`,
    'started straight away',
    'within 14 days',
    '/legal/refunds',
  ])
    expect(text).toContain(said)
  // A renewal is no new purchase: nothing is sent for it.
  await w.ordered(owner, held.subscription_id, {
    billing_reason: 'subscription_cycle',
    created_at: new Date().toISOString(),
  })
  expect(await w.mailTo(owner, true)).toHaveLength(1)
})

/**
 * A mailer that refuses the emails `refused` picks, as an outage would, until it is let go; the
 * Outbox keeps only what went.
 */
function refusing(refused: (message: { to: string; subject: string }) => boolean) {
  const send = w.h.mail.send.bind(w.h.mail)
  return spyOn(w.h.mail, 'send').mockImplementation(async (message) => {
    if (refused(message)) throw new Error('the mail server is down')
    return send(message)
  })
}

const told = (order: string) =>
  w.h.db
    .select({
      acknowledgedAt: schema.billingWithdrawals.acknowledgedAt,
      operatorsToldAt: schema.billingWithdrawals.operatorsToldAt,
    })
    .from(schema.billingWithdrawals)
    .where(eq(schema.billingWithdrawals.externalOrderId, order))

db('the person’s email failing leaves the request kept, and the billing pass sends it once', async () => {
  const inbox = await admin()
  const { owner, order } = await firstMonth('Rae', 2)
  const email = `${owner.userId}@example.test`
  const down = refusing((m) => m.to === email && m.subject.startsWith('We received'))
  try {
    expect(await withdrawals().request(owner, order)).toMatchObject({
      order,
      requestedAt: expect.any(String),
    })
  } finally {
    down.mockRestore()
  }
  // Kept and stopped, the operator told once, the person not yet; the page says it was cancelled.
  expect(await kept(order)).toHaveLength(1)
  expect((await w.h.app.accountQueries.overview(owner)).plan.key).toBe('free')
  expect(w.h.mail.to(inbox)).toHaveLength(1)
  expect((await subjects(owner)).filter((s) => s.startsWith('We received'))).toEqual([])
  expect(await told(order)).toMatchObject([{ acknowledgedAt: null, operatorsToldAt: expect.any(Date) }])
  expect(await withdrawals().list(owner)).toMatchObject([{ order, requestedAt: expect.any(String) }])

  await withdrawals().mail.tellUntold()
  await withdrawals().mail.tellUntold()
  expect((await subjects(owner)).filter((s) => s.startsWith('We received'))).toHaveLength(1)
  expect(w.h.mail.to(inbox)).toHaveLength(1)
  expect(await told(order)).toMatchObject([{ acknowledgedAt: expect.any(Date) }])
})

db('the operator’s email failing leaves the request kept, and the billing pass sends it once', async () => {
  const inbox = await admin()
  const { owner, order } = await firstMonth('Sol', 2)
  const down = refusing((m) => m.to === inbox)
  try {
    await withdrawals().request(owner, order)
  } finally {
    down.mockRestore()
  }
  expect(await kept(order)).toHaveLength(1)
  expect(w.h.mail.to(inbox)).toEqual([])
  expect((await subjects(owner)).filter((s) => s.startsWith('We received'))).toHaveLength(1)

  await withdrawals().mail.tellUntold()
  await withdrawals().mail.tellUntold()
  expect(w.h.mail.to(inbox).filter((m) => m.text.includes(order))).toHaveLength(1)
  expect((await subjects(owner)).filter((s) => s.startsWith('We received'))).toHaveLength(1)
})

db('a full refund given through support counts as the person’s once; a part refund doesn’t', async () => {
  const refundedEarlier = async (name: string, amount: number) => {
    const { owner, order } = await firstMonth(name, 5)
    const held = w.orders.get(order)
    if (held === undefined) throw new Error('no order')
    const refunded = amount >= held.net_amount ? 'refunded' : 'partially_refunded'
    await w.post(orderEvent({ ...held, status: refunded, refunded_amount: amount }, 'order.refunded'))
    // Bought again, a day ago.
    const again = randomUUID()
    await w.standing(owner, again)
    const second = await w.ordered(owner, again, { created_at: new Date(Date.now() - DAY_MS).toISOString() })
    return withdrawals().request(owner, second)
  }
  expect(await refundedEarlier('Tia', 1500)).toMatchObject({ rule: 'played' })
  expect(await refundedEarlier('Uli', 500)).toMatchObject({ rule: 'full' })
})
