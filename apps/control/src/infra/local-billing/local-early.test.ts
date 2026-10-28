// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The local checkout with an early product, end to end: the checkout page's price held, the
 * checkout link that sells the early product, the page's button, the signed delivery, and the
 * account on the plan with the hours it was sold.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { TERMS_VERSION } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { loadStanding } from '../../app/accounts/persistence.ts'
import { EarlyRoomControl } from '../../app/billing/early-room.ts'
import { entitlementsOf } from '../../domain/account/entitlements.ts'
import { createBillingWebhook } from '../../interfaces/billing/webhook.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { localCheckoutPages } from './checkout-pages.ts'
import { LocalBilling } from './local-billing.ts'

const EARLY = {
  id: 'local-early-core',
  planKey: 'core',
  priceCents: 700,
  includedUnits: 90,
  mostExtraUnits: 12,
  archived: false,
  createdAt: new Date('2026-10-01T00:00:00Z'),
}

describe.skipIf(!hasDatabase)('the local checkout at an early price', () => {
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
          early: [EARLY],
        })
        return { archives: null, billing }
      },
    })
    pages = localCheckoutPages({ billing, webhook: createBillingWebhook({ billing: h.app.billing }) })
    await new EarlyRoomControl({ db: h.db, maxPoints: 1000 }).set({
      roomPoints: 100,
      points: { core: 100, plus: 300 },
      validUntil: new Date(Date.now() + 30 * MINUTE_MS),
    })
  }, 30_000)

  afterAll(() => h.close())

  test('sells the month held for the page, and the account keeps its hours', async () => {
    const actor = await h.user()
    const offer = await h.app.billing.offer(actor, 'core')
    expect(offer).toMatchObject({ priceCents: 700, productId: EARLY.id })
    const { url } = await h.app.billing.startCheckout(actor, 'core', {
      consent: { terms: TERMS_VERSION, startNow: true },
      priceCents: offer.priceCents,
    })
    const link = new URL(url)
    expect((await pages.request(link.pathname + link.search)).status).toBe(200)
    const paid = await pages.request(link.pathname, {
      method: 'POST',
      body: new URLSearchParams({ ticket: link.searchParams.get('ticket') ?? '' }),
    })
    expect(paid.status).toBe(303)
    const standing = await loadStanding(h.db, actor.userId)
    expect(standing.plan).toBe('core')
    expect(entitlementsOf(standing)).toMatchObject({
      monthlyPriceCents: 700,
      includedUnits: 90,
      mostExtraUnits: 12,
    })
  })
})
