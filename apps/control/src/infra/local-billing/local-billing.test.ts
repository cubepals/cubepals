// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The local checkout end to end, as the Upgrade and Manage billing buttons reach it: the link the
 * billing service hands out, the page's button, the signed delivery through the webhook route
 * Polar's take, and the plan the account is on after each.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { TERMS_VERSION } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { loadStanding } from '../../app/accounts/persistence.ts'
import { latestSubscription } from '../../app/billing/persistence.ts'
import { installTuning, tuning } from '../../app/tuning.ts'
import { createBillingWebhook } from '../../interfaces/billing/webhook.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { localCheckoutPages } from './checkout-pages.ts'
import { LocalBilling } from './local-billing.ts'

const CONSENT = { consent: { terms: TERMS_VERSION, startNow: true } } as const

describe.skipIf(!hasDatabase)('the local checkout', () => {
  let h: Harness
  let billing: LocalBilling
  let pages: ReturnType<typeof localCheckoutPages>

  beforeAll(async () => {
    h = await startHarness({
      capabilities: (db) => {
        billing = new LocalBilling({
          db,
          secret: 'local-only-auth-secret',
          webOrigin: 'http://localhost:3000',
        })
        return { archives: null, billing }
      },
    })
    pages = localCheckoutPages({ billing, webhook: createBillingWebhook({ billing: h.app.billing }) })
  }, 30_000)

  afterAll(() => h.close())

  /** Opens a link the way a browser would, and presses the page's one button. */
  async function press(link: string): Promise<Response> {
    const url = new URL(link)
    const shown = await pages.request(url.pathname + url.search)
    expect(shown.status).toBe(200)
    return pages.request(url.pathname, {
      method: 'POST',
      body: new URLSearchParams({ ticket: url.searchParams.get('ticket') ?? '' }),
    })
  }

  test('Upgrade starts Plus, Manage billing cancels it, and each goes back to the account page', async () => {
    const actor = await h.user()
    const { url } = await h.app.billing.startCheckout(actor, 'plus', CONSENT)
    expect(url).toStartWith('http://localhost:3000/api/billing/local/checkout?ticket=')

    const paid = await press(url)
    expect(paid.status).toBe(303)
    expect(paid.headers.get('location')).toBe('http://localhost:3000/account?from=billing')
    expect((await loadStanding(h.db, actor.userId)).plan).toBe('plus')
    // The checkout's paid order is on record too, so extra hours can be allowed, as after a payment.
    expect(await h.app.accounts.allowExtraPlay(actor, 20)).toBe(20)
    // Back on the account page, which asks the provider again before its webhook could arrive.
    await h.app.billing.refresh(actor)
    expect((await loadStanding(h.db, actor.userId)).plan).toBe('plus')

    const portal = await h.app.billing.customerPortal(actor)
    expect(
      await (await pages.request(new URL(portal.url).pathname + new URL(portal.url).search)).text(),
    ).toContain('This account has Plus.')
    expect((await press(portal.url)).status).toBe(303)
    expect((await loadStanding(h.db, actor.userId)).plan).toBe('free')
    await h.app.billing.refresh(actor)
    expect((await loadStanding(h.db, actor.userId)).plan).toBe('free')
  })

  test('a year bought here is a year of Plus after the month paid, which stops renewing', async () => {
    const actor = await h.user()
    await press((await h.app.billing.startCheckout(actor, 'plus', CONSENT)).url)
    await press((await h.app.billing.startCheckout(actor, 'plus', { ...CONSENT, term: 'year' })).url)
    const { year } = (await h.app.accountQueries.overview(actor)).plan
    expect(await latestSubscription(h.db, actor.userId)).toMatchObject({
      cancelAtPeriodEnd: true,
      currentPeriodEnd: year?.startsAt,
    })
  })

  test('a balance paid here is a paid order naming the orders it settles', async () => {
    const actor = await h.user()
    const url = await billing.settleUrl({
      userId: actor.userId,
      cents: 1750,
      settles: ['o-1'],
      returnUrl: 'http://localhost:3000/account',
    })
    expect(await (await pages.request(new URL(url).pathname + new URL(url).search)).text()).toContain(
      'Pay $17.50',
    )
    expect((await press(url)).status).toBe(303)
    const [kept] = await h.db
      .select()
      .from(schema.billingOrders)
      .where(eq(schema.billingOrders.userId, actor.userId))
    expect(kept).toMatchObject({ billingReason: 'purchase', status: 'paid', totalCents: 1750, planKey: null })
  })

  test('extra play is kept here, once per id, instead of being sent anywhere', async () => {
    const event = { externalId: 'extra:u:2026-10:1', userId: 'u', hours: 0.5, at: new Date() }
    await billing.reportUsage([event])
    await billing.reportUsage([event])
    expect(billing.reported.filter((kept) => kept.externalId === event.externalId)).toEqual([event])
  })

  test('a link signed elsewhere, or for the other page, opens nothing', async () => {
    const actor = await h.user()
    const { url } = await h.app.billing.startCheckout(actor, 'plus', CONSENT)
    const ticket = new URL(url).searchParams.get('ticket') ?? ''
    const other = new LocalBilling({
      db: h.db,
      secret: 'another-secret-entirely',
      webOrigin: 'http://localhost:3000',
    })
    const forged = await other.checkoutUrl({
      userId: actor.userId,
      planKey: 'plus',
      term: 'month',
      returnUrl: '/',
    })
    expect((await pages.request(new URL(forged).pathname + new URL(forged).search)).status).toBe(400)
    expect(
      (
        await pages.request('/api/billing/local/portal', {
          method: 'POST',
          body: new URLSearchParams({ ticket }),
        })
      ).status,
    ).toBe(400)
    expect((await loadStanding(h.db, actor.userId)).plan).toBe('free')
  })

  test('the webhook refuses a delivery the local checkout did not sign', async () => {
    const actor = await h.user()
    const webhook = createBillingWebhook({ billing: h.app.billing })
    const body = JSON.stringify({ type: 'subscription.started', userId: actor.userId, planKey: 'plus' })
    const refused = await webhook.request('/api/billing/webhook', {
      method: 'POST',
      body,
      headers: { 'x-local-billing-signature': 'made-up' },
    })
    expect(refused.status).toBe(401)
    expect((await loadStanding(h.db, actor.userId)).plan).toBe('free')
  })
})

describe.skipIf(!hasDatabase)('the local gift page, with GIFTS_BY_EMAIL', () => {
  const MONTH = { id: 'local-gift-plus', planKey: 'plus', months: 1, priceCents: 1500 }
  let h: Harness
  let billing: LocalBilling
  let pages: ReturnType<typeof localCheckoutPages>

  const before = tuning()
  beforeEach(() => installTuning({ ...before, giftsByEmail: true }))
  afterEach(() => installTuning(before))

  beforeAll(async () => {
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
    pages = localCheckoutPages({ billing, webhook: createBillingWebhook({ billing: h.app.billing }) })
  }, 30_000)

  afterAll(() => h.close())

  /** A guest's gift, made before its checkout, bought on the page with `email`; answers the gift and its order. */
  async function bought(email: string) {
    const [made] = await h.db
      .insert(schema.planGifts)
      .values({
        provider: 'local',
        buyerEmail: email,
        recipientKey: `recipient-${crypto.randomUUID()}`,
        delivery: 'email',
        state: 'checkout',
        planKey: 'plus',
        months: 1,
      })
      .returning()
    if (!made) throw new Error('no gift was made')
    const link = new URL(
      await billing.giftCheckoutUrl({
        userId: null,
        email,
        gift: MONTH,
        giftId: made.id,
        returnUrl: 'http://localhost:3000/gift',
      }),
    )
    expect((await pages.request(link.pathname + link.search)).status).toBe(200)
    const paid = await pages.request(link.pathname, {
      method: 'POST',
      body: new URLSearchParams({ ticket: link.searchParams.get('ticket') ?? '' }),
    })
    expect(paid.status).toBe(303)
    const [gift] = await h.db.select().from(schema.planGifts).where(eq(schema.planGifts.id, made.id))
    const [order] = await h.db
      .select()
      .from(schema.billingOrders)
      .where(eq(schema.billingOrders.giftId, made.id))
    return { gift, order }
  }

  test('a guest pays for the gift made before its checkout, kept with no account', async () => {
    const { gift, order } = await bought('guest@example.test')
    expect(order).toMatchObject({ provider: 'local', userId: null })
    expect(gift).toMatchObject({ state: 'paid', externalOrderId: order?.externalOrderId, buyerId: null })
  })

  test('filed under the account with the guest’s email, as Polar files it, it is still the guest’s', async () => {
    const account = await h.user()
    const sent = billing.delivery({
      type: 'order.paid',
      userId: null,
      planKey: null,
      cents: 1500,
      gift: MONTH,
      giftId: crypto.randomUUID(),
      payerEmail: `${account.userId}@example.test`,
    })
    const read = await billing.receive(sent.body, sent.headers)
    expect(read?.kind === 'order' ? read.order.userId : null).toBe(account.userId)
    const { gift, order } = await bought(`${account.userId}@example.test`)
    expect(order?.userId).toBeNull()
    expect(gift).toMatchObject({ state: 'paid', buyerId: null })
    expect(h.mail.to(`${account.userId}@example.test`)).toHaveLength(0)
  })
})
