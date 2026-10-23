// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gifts end to end through the local billing adapter: bought within the day's cap, made once per
 * paid order with the code emailed and only its hash kept, redeemed for the plan, run on from time
 * already held, voided by a refund, ended by the sweep, and sent again with a new code.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { LocalBilling } from '../../infra/local-billing/local-billing.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { AppError } from '../errors.ts'
import type { BillingOrder, GiftProduct } from '../ports/optional.ts'
import { tuning } from '../tuning.ts'
import { codeHash, newCode, readCode } from './gift-codes.ts'
import { addMonths } from './years.ts'

const MONTH: GiftProduct = { id: 'local-gift-plus', planKey: 'plus', months: 1, priceCents: 1500 }

test('a code reads the way a person types it, and nothing else', () => {
  const code = newCode()
  expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
  expect(readCode(code.toLowerCase().replaceAll('-', ' '))).toBe(code.replaceAll('-', ''))
  expect(readCode('OOOO-IIII-LLLL-0000')).toBe('0000111111110000')
  expect(readCode('too-short')).toBeNull()
  expect(codeHash(code)).toBe(codeHash(code.toLowerCase()))
})

test('a month on from the 31st is the last day of a shorter month', () => {
  expect(addMonths(new Date('2027-01-31T10:00:00Z'), 1).toISOString()).toBe('2027-02-28T10:00:00.000Z')
  expect(addMonths(new Date('2026-10-12T00:00:00Z'), 12).toISOString()).toBe('2027-10-12T00:00:00.000Z')
})

/** A test that needs the database. */
const db = test.skipIf(!hasDatabase)

let h: Harness
let billing: LocalBilling
let orders = 0

// One harness for the file, where there is a database: booting is the slow part.
beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness({
    capabilities: (db) => {
      billing = new LocalBilling({
        db,
        secret: 'local-only-auth-secret',
        webOrigin: 'http://localhost:3000',
        gifts: [MONTH],
      })
      return { archives: null, billing }
    },
  })
}, 30_000)

afterAll(async () => {
  await h?.close()
})

const order = (userId: string, patch: Partial<BillingOrder> = {}): BillingOrder => ({
  externalOrderId: `gift-order-${++orders}`,
  userId,
  planKey: null,
  billingReason: 'purchase',
  currency: 'usd',
  subtotalCents: 1500,
  discountCents: 0,
  netCents: 1500,
  taxCents: 0,
  totalCents: 1500,
  refundedCents: 0,
  status: 'paid',
  extraCents: 0,
  externalSubscriptionId: null,
  settles: [],
  balance: false,
  chipIn: null,
  paysForYear: false,
  gift: MONTH,
  orderedAt: new Date(),
  ...patch,
})

/** A gift bought by a new account, through the webhook; answers the buyer, the order and the code. */
const bought = async () => {
  const buyer = await h.user()
  const delivery = billing.delivery({
    type: 'order.paid',
    userId: buyer.userId,
    planKey: null,
    cents: 1500,
    gift: MONTH,
  })
  expect(await h.app.billing.receiveWebhook(delivery.body, delivery.headers)).toBe('recorded')
  const email = `${buyer.userId}@example.test`
  const text = h.mail.to(email).at(-1)?.text ?? ''
  const code = text.match(/[0-9A-Z]{4}(-[0-9A-Z]{4}){3}/)?.[0]
  if (code === undefined) throw new Error('no code was emailed')
  const [row] = await h.db.select().from(schema.planGifts).where(eq(schema.planGifts.buyerId, buyer.userId))
  if (!row) throw new Error('no gift was made')
  return { buyer, code, row }
}

const refused = async (call: Promise<unknown>, code: string) => {
  const error = await call.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(AppError)
  expect((error as AppError).code).toBe(code as AppError['code'])
  return (error as AppError).message
}

db('the gift page offers each plan’s month, and buying opens a checkout, up to the day’s cap', async () => {
  expect(await h.app.billing.gifts.options()).toEqual([MONTH])
  const buyer = await h.user()
  const { url } = await h.app.billing.gifts.buy(buyer, MONTH.id, { terms: '2026-10-12' })
  expect(url).toContain('/api/billing/local/gift')
  for (let i = 0; i < tuning().abuse.giftsPerDay; i++)
    await h.app.billing.gifts.received('local', order(buyer.userId))
  expect(
    await refused(h.app.billing.gifts.buy(buyer, MONTH.id, { terms: '2026-10-12' }), 'rate_limited'),
  ).toMatch(/tomorrow/)
  await refused(
    h.app.billing.gifts.buy(await h.user(), 'no-such-gift', { terms: '2026-10-12' }),
    'invalid_choice',
  )
})

db('a paid order makes one gift, emails its code once, and keeps only the hash', async () => {
  const buyer = await h.user()
  const paid = order(buyer.userId)
  await h.app.billing.gifts.received('local', paid)
  // The provider delivers the same order again: nothing new is made or sent.
  await h.app.billing.gifts.received('local', paid)
  const mail = h.mail.to(`${buyer.userId}@example.test`)
  expect(mail).toHaveLength(1)
  const code = mail[0]?.text.match(/[0-9A-Z]{4}(-[0-9A-Z]{4}){3}/)?.[0] ?? ''
  const rows = await h.db.select().from(schema.planGifts).where(eq(schema.planGifts.buyerId, buyer.userId))
  expect(rows).toHaveLength(1)
  expect(rows[0]?.codeHash).toBe(codeHash(code))
  expect(JSON.stringify(rows[0])).not.toContain(code.replaceAll('-', ''))
  expect(await h.app.billing.gifts.mine(buyer)).toMatchObject([
    { state: 'waiting', codeHint: code.slice(-4) },
  ])
})

db('redeeming gives the plan for a month; the code works once', async () => {
  const { code, buyer } = await bought()
  const friend = await h.user()
  const before = Date.now()
  const redeemed = await h.app.billing.gifts.redeem(friend, code.toLowerCase())
  expect(redeemed.planKey).toBe('plus')
  expect(new Date(redeemed.startsAt).getTime()).toBeGreaterThanOrEqual(before - 1000)
  const overview = await h.app.accountQueries.overview(friend)
  expect(overview.plan.key).toBe('plus')
  expect(overview.plan.gifted?.until.toISOString()).toBe(redeemed.endsAt)
  expect(await refused(h.app.billing.gifts.redeem(friend, code), 'invalid_choice')).toMatch(/already/)
  expect(await refused(h.app.billing.gifts.redeem(await h.user(), code), 'invalid_choice')).toMatch(/used/)
  expect(await h.app.billing.gifts.mine(buyer)).toMatchObject([{ state: 'redeemed' }])
})

db('a second gift runs on from the first', async () => {
  const friend = await h.user()
  const first = await h.app.billing.gifts.redeem(friend, (await bought()).code)
  const second = await h.app.billing.gifts.redeem(friend, (await bought()).code)
  expect(second.startsAt).toBe(first.endsAt)
  expect((await h.app.accountQueries.overview(friend)).plan.gifted?.until.toISOString()).toBe(second.endsAt)
})

db('an account whose plan renews on its card is told to set it to end first', async () => {
  const { code } = await bought()
  const payer = await h.user()
  await h.app.billing.syncSubscription(
    {
      userId: payer.userId,
      externalCustomerId: `local-${payer.userId}`,
      subscription: {
        externalSubscriptionId: `sub-${payer.userId}`,
        planKey: 'plus',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
        cancelAtPeriodEnd: false,
      },
    },
    'test',
    'webhook',
  )
  expect(await refused(h.app.billing.gifts.redeem(payer, code), 'invalid_choice')).toMatch(/Manage billing/)
})

db('wrong codes are refused, and past the hour’s count the account waits', async () => {
  const guesser = await h.user()
  for (let i = 0; i < tuning().abuse.wrongCodesPerHour; i++)
    await refused(h.app.billing.gifts.redeem(guesser, newCode()), 'invalid_choice')
  await refused(h.app.billing.gifts.redeem(guesser, (await bought()).code), 'rate_limited')
})

db('a refund voids a code nobody used, and ends time somebody redeemed', async () => {
  const unused = await bought()
  await h.app.billing.gifts.received(
    'local',
    order(unused.buyer.userId, {
      externalOrderId: unused.row.externalOrderId ?? '',
      refundedCents: 1500,
      status: 'refunded',
    }),
  )
  await refused(h.app.billing.gifts.redeem(await h.user(), unused.code), 'invalid_choice')
  expect(await h.app.billing.gifts.mine(unused.buyer)).toMatchObject([{ state: 'refunded' }])

  const used = await bought()
  const friend = await h.user()
  await h.app.billing.gifts.redeem(friend, used.code)
  await h.app.billing.gifts.received(
    'local',
    order(used.buyer.userId, {
      externalOrderId: used.row.externalOrderId ?? '',
      refundedCents: 1500,
      status: 'refunded',
    }),
  )
  expect((await h.app.accountQueries.overview(friend)).plan).toMatchObject({ key: 'free', gifted: null })
})

db('the sweep records gifted time that ran out, once', async () => {
  const friend = await h.user()
  const { endsAt } = await h.app.billing.gifts.redeem(friend, (await bought()).code)
  const after = new Date(new Date(endsAt).getTime() + 1000)
  expect(await h.app.billing.gifts.recordEnds(after)).toBeGreaterThanOrEqual(1)
  expect(await h.app.billing.gifts.recordEnds(after)).toBe(0)
  const ended = await h.db
    .select()
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.subjectId, friend.userId), eq(schema.auditLog.action, 'account.plan_changed')),
    )
  expect(ended.map((entry) => entry.data)).toContainEqual(
    expect.objectContaining({ from: 'plus', to: 'free' }),
  )
})

db('sending a code again makes a new one, and the old one stops working', async () => {
  const { buyer, code, row } = await bought()
  await h.app.billing.gifts.resend(buyer, row.id)
  const again = h.mail
    .to(`${buyer.userId}@example.test`)
    .at(-1)
    ?.text.match(/[0-9A-Z]{4}(-[0-9A-Z]{4}){3}/)?.[0]
  expect(again).toBeDefined()
  expect(again).not.toBe(code)
  await refused(h.app.billing.gifts.redeem(await h.user(), code), 'invalid_choice')
  expect((await h.app.billing.gifts.redeem(await h.user(), again ?? '')).planKey).toBe('plus')
  await refused(h.app.billing.gifts.resend(buyer, row.id), 'invalid_choice')
})
