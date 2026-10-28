// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A subscription keeps the hours it was sold with: one on an early product has that product's
 * price, hours and cap for as long as it stays on it, whatever the product says later; a move to
 * another product takes that one's; an admin's hours still win; and a plan's own product follows
 * the plan table, as before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsFor, entitlementsOf } from '../../domain/account/entitlements.ts'
import { hasDatabase } from '../../testing/harness.ts'
import { CORE_PRODUCT, earlyProduct, PLUS_PRODUCT } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { latestSubscription } from './persistence.ts'

const EARLY_CORE = '9b2d6e10-4c1a-4f3b-8e5d-7a6c5b4a3e01'
const early = (included = 90) =>
  earlyProduct(EARLY_CORE, { plan: 'core', included_units: included, most_extra_units: 12 }, 700)

describe.skipIf(!hasDatabase)('the hours a subscription was sold with', () => {
  const w = new PolarWorld()

  beforeAll(() => w.start(), 30_000)
  afterAll(() => w.close())
  beforeEach(() => {
    w.reset()
    w.early.splice(0, w.early.length, early())
  })

  test('a plan’s own product follows the plan table', async () => {
    const owner = await w.h.user('Regular')
    await w.standing(owner, randomUUID(), { product_id: CORE_PRODUCT })
    const standing = await loadStanding(w.h.db, owner.userId)
    expect(standing.plan).toBe('core')
    expect(standing.soldWith).toBeUndefined()
    expect(entitlementsOf(standing)).toEqual(entitlementsFor('core'))
    expect(await latestSubscription(w.h.db, owner.userId)).toMatchObject({
      productId: CORE_PRODUCT,
      priceCents: null,
      includedUnits: null,
      mostExtraUnits: null,
    })
  })

  test('one on an early product has its price, hours and cap, on the account page too', async () => {
    const owner = await w.h.user('Early')
    await w.standing(owner, randomUUID(), { product_id: EARLY_CORE })
    const standing = await loadStanding(w.h.db, owner.userId)
    expect(standing.soldWith).toEqual({ priceCents: 700, includedUnits: 90, mostExtraUnits: 12 })
    expect(entitlementsOf(standing)).toMatchObject({
      plan: 'core',
      monthlyPriceCents: 700,
      includedUnits: 90,
      mostExtraUnits: 12,
    })
    const overview = await w.h.app.accountQueries.overview(owner)
    expect(overview.entitlements).toMatchObject({
      monthlyPriceCents: 700,
      includedUnits: 90,
      mostExtraUnits: 12,
    })
  })

  test('they stay while it is on that product, whatever the product says later', async () => {
    const owner = await w.h.user('Kept')
    const sub = randomUUID()
    await w.standing(owner, sub, { product_id: EARLY_CORE })
    w.early.splice(0, w.early.length, early(200))
    // Past the time the adapter keeps what it read of the products.
    setSystemTime(new Date(Date.now() + 10 * MINUTE_MS))
    try {
      await w.standing(owner, sub, { product_id: EARLY_CORE })
    } finally {
      setSystemTime()
    }
    expect((await loadStanding(w.h.db, owner.userId)).soldWith?.includedUnits).toBe(90)
  })

  test('a move to another product takes that one’s terms', async () => {
    const owner = await w.h.user('Moved')
    const sub = randomUUID()
    await w.standing(owner, sub, { product_id: EARLY_CORE })
    await w.standing(owner, sub, { product_id: PLUS_PRODUCT })
    const standing = await loadStanding(w.h.db, owner.userId)
    expect(standing.plan).toBe('plus')
    expect(standing.soldWith).toBeUndefined()
    expect(entitlementsOf(standing).includedUnits).toBe(entitlementsFor('plus').includedUnits)
  })

  test('an admin’s hours still win over the ones it was sold with', async () => {
    const owner = await w.h.user('Given')
    await w.standing(owner, randomUUID(), { product_id: EARLY_CORE })
    await w.h.db
      .update(schema.accountStanding)
      .set({ limitOverrides: { includedUnits: 300 } })
      .where(eq(schema.accountStanding.userId, owner.userId))
    expect(entitlementsOf(await loadStanding(w.h.db, owner.userId))).toMatchObject({
      includedUnits: 300,
      monthlyPriceCents: 700,
    })
  })
})
