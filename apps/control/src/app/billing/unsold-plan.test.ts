// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A paid plan with no product at the provider is not for sale yet: said at checkout and on its
 * card, never a failure. A deployment selling Plus alone has no Core, and one selling Core alone
 * has no Plus.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { hasDatabase } from '../../testing/harness.ts'
import { CORE_PRODUCT, PLUS_PRODUCT } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import { publicPlans } from '../accounts/queries.ts'
import { supportOf } from '../capabilities.ts'

const plusOnly = new PolarWorld({ plus: PLUS_PRODUCT })
const coreOnly = new PolarWorld({ core: CORE_PRODUCT })

beforeAll(async () => {
  if (hasDatabase) {
    await plusOnly.start()
    await coreOnly.start()
  }
}, 60_000)

afterAll(async () => {
  if (hasDatabase) {
    await plusOnly.close()
    await coreOnly.close()
  }
})

const offered = (world: PolarWorld) =>
  publicPlans(supportOf({ archives: null, billing: world.billing })).map((plan) => [plan.key, plan.available])

test.skipIf(!hasDatabase)('Plus alone: Core is not for sale, and its checkout says so', async () => {
  const owner = await plusOnly.h.user()
  await expect(plusOnly.h.app.billing.startCheckout(owner, 'core')).rejects.toThrow(
    'Core isn’t available yet.',
  )
  expect(offered(plusOnly)).toEqual([
    ['free', true],
    ['core', false],
    ['plus', true],
  ])
})

test.skipIf(!hasDatabase)('Core alone: Plus is not for sale, and Core still is', async () => {
  const owner = await coreOnly.h.user()
  await expect(coreOnly.h.app.billing.startCheckout(owner, 'plus')).rejects.toThrow(
    'Plus isn’t available yet.',
  )
  expect(offered(coreOnly)).toEqual([
    ['free', true],
    ['core', true],
    ['plus', false],
  ])
})
