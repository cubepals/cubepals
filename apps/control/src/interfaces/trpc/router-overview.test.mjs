// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The real account query crosses the RPC boundary as JSON without losing entitlements or dates. */
import { afterAll, describe, expect, test } from 'bun:test'
import { DAY_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { addMonths } from '../../app/billing/years.ts'
import { LIST_UUIDS } from '../../minecraft/console.ts'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { appRouter } from './router.ts'

let harness
afterAll(async () => {
  await harness?.then(
    (h) => h.close(),
    () => undefined,
  )
})
function jsonValue(value) {
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Set || Array.isArray(value)) return [...value].map(jsonValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]))
  return value
}
async function checkAccount(mode) {
  harness ??= startHarness()
  const h = await harness,
    owner = await h.user('Steve', 'plus'),
    now = new Date()
  if (mode !== 'none')
    await h.db.insert(schema.billingSubscriptions).values({
      userId: owner.userId,
      provider: 'router-fixture',
      externalCustomerId: crypto.randomUUID(),
      externalSubscriptionId: crypto.randomUUID(),
      planKey: 'plus',
      status: mode === 'dates' ? 'past_due' : 'active',
      currentPeriodEnd: mode === 'dates' ? addMonths(now, 1) : null,
      pastDueAt: mode === 'dates' ? now : null,
      movesToPlan: mode === 'dates' ? 'core' : null,
      movesAt: mode === 'dates' ? addMonths(now, 1) : null,
    })
  if (mode === 'dates') {
    await h.db.insert(schema.planYears).values({
      provider: 'router-fixture',
      externalOrderId: crypto.randomUUID(),
      userId: owner.userId,
      planKey: 'plus',
      startsAt: new Date(now.getTime() - DAY_MS),
      endsAt: addMonths(now, 12),
    })
    for (const [startsAt, endsAt] of [
      [new Date(now.getTime() - SECOND_MS), addMonths(now, 1)],
      [addMonths(now, 2), addMonths(now, 3)],
    ])
      await h.db.insert(schema.planGifts).values({
        provider: 'router-fixture',
        externalOrderId: crypto.randomUUID(),
        buyerId: owner.userId,
        state: 'claimed',
        planKey: 'plus',
        months: 1,
        redeemedBy: owner.userId,
        redeemedAt: now,
        startsAt,
        endsAt,
      })
  }
  const original = await h.app.accountQueries.overview(owner)
  if (mode === 'none')
    expect(original.plan).toMatchObject({ billed: null, year: null, gifted: null, giftNext: null })
  if (mode === 'dates') {
    expect(original.plan.billed?.periodEnd).toBeInstanceOf(Date)
    expect(original.plan.billed?.pastDueUntil).toBeInstanceOf(Date)
    expect(original.plan.billed?.movesTo?.at).toBeInstanceOf(Date)
    expect(original.plan.year?.endsAt).toBeInstanceOf(Date)
    expect(original.plan.gifted?.until).toBeInstanceOf(Date)
    expect(original.plan.giftNext?.startsAt).toBeInstanceOf(Date)
  }
  const caller = appRouter.createCaller({ actor: owner, services: h.app })
  const result = await caller.account.overview()
  const { plans, ...account } = original
  expect(result).toMatchObject(jsonValue(account))
  expect(result.plans.map((plan) => plan.key)).toEqual(plans.map((plan) => plan.key))
  expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  expect(result.entitlements.sizeLabels).toEqual(original.sizeLabels)
  for (const plan of original.plans) {
    const offered = result.plans.find((item) => item.key === plan.key)
    expect(offered).toBeDefined()
    expect(offered.entitlements).toMatchObject(jsonValue(plan.entitlements))
    expect(offered.entitlements.sizeLabels).toEqual(plan.sizeLabels)
  }
}
async function consoleReply() {
  harness ??= startHarness()
  const h = await harness,
    owner = await h.user('Steve', 'plus'),
    server = await h.create(owner)
  await h.until(server.id, 'running')
  await h.settled(server.id)
  const output = await h.app.console.run(owner, server.id, LIST_UUIDS)
  const caller = appRouter.createCaller({ actor: owner, services: h.app })
  expect(await caller.console.run({ serverId: server.id, command: LIST_UUIDS })).toEqual({ output })
}

describe.skipIf(!hasDatabase)('account overview on the wire', () => {
  test('console replies retain the game’s actual output', consoleReply, 30 * SECOND_MS)
  test(
    'an account with no purchases retains its null plan history and real entitlements',
    () => checkAccount('none'),
    30 * SECOND_MS,
  )
  test(
    'subscription, year and gift dates are ISO strings with their real values',
    () => checkAccount('dates'),
    30 * SECOND_MS,
  )
  test(
    'a subscription with no dates retains null fields without inventing a schedule',
    () => checkAccount('nulls'),
    30 * SECOND_MS,
  )
})
