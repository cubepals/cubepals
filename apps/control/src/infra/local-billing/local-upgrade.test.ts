// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A larger plan bought over one sold on an early product here is on the larger plan's own terms. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { latestSubscription } from '../../app/billing/persistence.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { LocalBilling } from './local-billing.ts'

describe.skipIf(!hasDatabase)('an upgrade at the local checkout', () => {
  let h: Harness
  let billing: LocalBilling

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
  }, 30_000)

  afterAll(() => h.close())

  test('Plus bought over an early Core is on Plus’s own product and terms', async () => {
    const actor = await h.user()
    const id = `local-early-${actor.userId}`
    await h.db.insert(schema.billingSubscriptions).values({
      userId: actor.userId,
      provider: billing.provider,
      externalCustomerId: `local-${actor.userId}`,
      externalSubscriptionId: id,
      planKey: 'core',
      status: 'active',
      productId: 'early-core',
      priceCents: 700,
      includedUnits: 90,
      mostExtraUnits: 12,
    })
    await billing.upgradeSubscription(id, 'plus')
    expect(await latestSubscription(h.db, actor.userId)).toMatchObject({
      planKey: 'plus',
      productId: null,
      priceCents: null,
      includedUnits: null,
      mostExtraUnits: null,
    })
  })
})
