// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core, the plan between the trial and Plus, end to end through the real Polar adapter: bought
 * from the trial's end, what it holds a server to, bought over by Plus, and left for by a player
 * whose servers ran on Plus. Its numbers are `entitlements.test.ts`'s; this is what billing and
 * servers do with them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { DAY_MS, HOUR_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import {
  CORE_FIXED_PRICE,
  CORE_PRODUCT,
  checkout,
  customerState,
  orderItem,
  PLUS_PRODUCT,
  stateChanged,
  subscription,
} from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }),
  )

/** Polar's word that the account pays for Core, as a subscription made `at`. */
async function pays(owner: UserActor, plans: Array<{ sub: string; product: string; at: string }>) {
  const [first, ...rest] = plans
  if (first === undefined) throw new Error('A subscription to hold')
  const state = customerState(
    owner.userId,
    {},
    { id: first.sub, product_id: first.product, created_at: first.at },
  )
  const [held] = state.active_subscriptions
  if (held === undefined) throw new Error('customerState holds one subscription')
  for (const next of rest)
    state.active_subscriptions.push({ ...held, id: next.sub, product_id: next.product, created_at: next.at })
  w.polar.states.set(owner.userId, state)
  return w.post(stateChanged(state))
}

const create = (owner: UserActor, request: Parameters<typeof w.h.create>[1] = {}) =>
  w.h.create(owner, request)

describe.skipIf(!hasDatabase)('buying Core and Plus over it', () => {
  test('the trial leads to Core: one checkout buys it, and the account is held to Core’s limits', async () => {
    const owner = await w.h.user('Ada')
    const before = await w.h.app.accountQueries.overview(owner)
    expect(before.plans.map((p) => p.key)).toEqual(['free', 'core', 'plus'])

    w.polar.reply = () => ({ status: 201, body: checkout('co_core', 'https://polar.test/checkout/core') })
    const { url } = await w.h.app.billing.startCheckout(owner, 'core', {
      reason: 'hours',
      next: '/servers',
      consent: { terms: TERMS_VERSION, startNow: true },
    })
    expect(url).toBe('https://polar.test/checkout/core')
    const asked = w.polar.requests.at(-1)
    expect(JSON.parse(asked?.body ?? '')).toMatchObject({
      products: [CORE_PRODUCT],
      external_customer_id: owner.userId,
    })
    w.reset()

    await pays(owner, [{ sub: randomUUID(), product: CORE_PRODUCT, at: new Date().toISOString() }])
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('core')
    const overview = await w.h.app.accountQueries.overview(owner)
    expect(overview.plan.key).toBe('core')
    expect(overview.entitlements).toMatchObject({
      plan: 'core',
      monthlyPriceCents: 999,
      maxServers: 1,
      includedUnits: 40,
      mayBuyMore: true,
      mayUseMods: false,
    })
    expect(overview.entitlements.allowedMemoryTiers).toEqual(['3g'])
    expect(overview.entitlements.settingCaps?.maxPlayers).toBe(5)

    // Five at once on vanilla starts; the sixth, a mod and a group of ten are Plus's.
    const server = await create(owner, { name: 'Friends' })
    await w.h.until(server.id, 'running')
    await w.h.settled(server.id)
    expect(server.memoryTier).toBe('3g')
    expect(await refusal(create(owner, { name: 'Ten', partySize: '10' }))).toMatchObject({
      code: 'not_entitled',
    })
    const options = await w.h.app.queries.createOptions(owner)
    expect(options.partySizes.find((size) => size.value === '10')).toMatchObject({
      allowed: false,
      reason: 'Groups over 5 come with Plus.',
      plan: 'plus',
    })
    const modded = await refusal(create(owner, { name: 'Mods', loader: 'fabric', gameVersion: '26.2' }))
    expect(modded).toMatchObject({ code: 'not_entitled' })
    expect(modded?.message).toContain('Plus')
  }, 60_000)
})

describe.skipIf(!hasDatabase)('Core becoming Plus in place', () => {
  test('Plus over Core changes the one subscription: no checkout, no second renewal', async () => {
    const owner = await w.h.user('Bea')
    const core = randomUUID()
    await pays(owner, [{ sub: core, product: CORE_PRODUCT, at: '2026-10-01T00:00:00Z' }])
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('core')
    const asked = w.polar.requests.length

    const { url } = await w.h.app.billing.startCheckout(owner, 'plus', {
      reason: 'players',
      next: '/servers/new',
    })
    expect(new URL(url).searchParams.get('next')).toBe('/servers/new')
    const sent = w.polar.requests.slice(asked)
    expect(sent.some((request) => request.path.startsWith('/v1/checkouts'))).toBe(false)
    // Polar is asked once, on the subscription Core is paid by: its product, the difference invoiced.
    expect(w.updates).toEqual([
      { id: core, body: { product_id: PLUS_PRODUCT, proration_behavior: 'invoice' } },
    ])

    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('plus')
    const rows = await w.h.db
      .select({
        id: schema.billingSubscriptions.externalSubscriptionId,
        plan: schema.billingSubscriptions.planKey,
        status: schema.billingSubscriptions.status,
        ending: schema.billingSubscriptions.cancelAtPeriodEnd,
      })
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.userId, owner.userId))
    expect(rows).toEqual([{ id: core, plan: 'plus', status: 'active', ending: false }])
    expect((await w.audited(owner, 'billing.plan_upgraded_in_place'))[0]).toMatchObject({
      from: 'core',
      to: 'plus',
    })
    expect((await w.h.app.accountQueries.overview(owner)).entitlements).toMatchObject({
      plan: 'plus',
      maxServers: 3,
      includedUnits: 120,
    })
  })

  test('Core set to end renews again first, as Polar changes the product of no ending subscription', async () => {
    const owner = await w.h.user('Dee')
    const core = randomUUID()
    await pays(owner, [{ sub: core, product: CORE_PRODUCT, at: '2026-10-01T00:00:00Z' }])
    const state = w.polar.states.get(owner.userId)
    const [held] = state?.active_subscriptions ?? []
    if (state === undefined || held === undefined) throw new Error('Polar holds the subscription')
    held.cancel_at_period_end = true
    w.subscriptions.set(core, subscription(core, { cancel_at_period_end: true, ended_at: null }))
    await w.post(stateChanged(state))

    await w.h.app.billing.startCheckout(owner, 'plus')
    expect(w.updates.filter((update) => update.id === core)).toEqual([
      { id: core, body: { cancel_at_period_end: false } },
      { id: core, body: { product_id: PLUS_PRODUCT, proration_behavior: 'invoice' } },
    ])
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('plus')
  })

  test('a Core still renewing beside Plus is stopped, and a stop Polar refuses fails the delivery', async () => {
    const owner = await w.h.user('Eli')
    const core = randomUUID()
    const plus = randomUUID()
    const both = [
      { sub: core, product: CORE_PRODUCT, at: '2026-10-01T00:00:00Z' },
      { sub: plus, product: PLUS_PRODUCT, at: '2026-10-10T00:00:00Z' },
    ]
    await pays(owner, both.slice(0, 1))
    const answer = w.polar.reply
    w.polar.reply = (request) => (request.method === 'PATCH' ? { status: 500, body: {} } : answer(request))
    expect((await pays(owner, both)).status).toBeGreaterThanOrEqual(500)

    // Polar answers the next delivery: Core's renewal stops, and the account is Plus's alone.
    w.polar.reply = answer
    await pays(owner, both)
    expect(w.updates).toContainEqual({ id: core, body: { cancel_at_period_end: true } })
    expect(w.updates.some((update) => update.id === plus)).toBe(false)
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('plus')
  })

  test('Core is not bought over Plus: the move to it is from the account, and nothing is paid twice', async () => {
    const owner = await w.h.user('Cy')
    await pays(owner, [{ sub: randomUUID(), product: PLUS_PRODUCT, at: '2026-10-01T00:00:00Z' }])
    const asked = w.polar.requests.length
    const refused = await refusal(w.h.app.billing.startCheckout(owner, 'core'))
    expect(refused).toMatchObject({ code: 'invalid_choice' })
    expect(refused?.message).toBe(
      'You have Plus now. Move to Core from your account: it starts when the month you paid for ends, and Plus stays until then.',
    )
    expect(w.polar.requests.slice(asked).some((request) => request.path.startsWith('/v1/checkouts'))).toBe(
      false,
    )
  })
})

describe.skipIf(!hasDatabase)('moving down from Plus to Core', () => {
  test('Plus that no monthly subscription pays for has nothing to move: Core opens when it ends', async () => {
    const until = 'You have Plus until it ends, and Core opens when it does.'
    // Plus an admin gave, a year paid at once and a gift all run out on their own.
    const given = await w.h.user('Kay', 'plus')
    expect(await refusal(w.h.app.billing.startCheckout(given, 'core'))).toMatchObject({
      code: 'invalid_choice',
      message: until,
    })
    // Plus set to end with the month paid for is no move either: it ends, and Core opens.
    const ending = await w.h.user('Lee')
    await pays(ending, [{ sub: randomUUID(), product: PLUS_PRODUCT, at: '2026-10-01T00:00:00Z' }])
    const state = w.polar.states.get(ending.userId)
    const [held] = state?.active_subscriptions ?? []
    if (state === undefined || held === undefined) throw new Error('Polar holds the subscription')
    held.cancel_at_period_end = true
    await w.post(stateChanged(state))
    expect(await refusal(w.h.app.billing.startCheckout(ending, 'core'))).toMatchObject({ message: until })
    // And the move itself says the same of both.
    expect(await refusal(w.h.app.billing.moveToSmaller(given, 'core'))).toMatchObject({
      code: 'invalid_choice',
    })
  })

  /** An owner on Plus with one server, moved to Core: Plus ended in Manage billing, Core bought after it. */
  async function movedDown(name: string, request: Parameters<typeof create>[1]) {
    const owner = await w.h.user(name)
    const plus = randomUUID()
    await pays(owner, [{ sub: plus, product: PLUS_PRODUCT, at: '2026-10-01T00:00:00Z' }])
    const server = await create(owner, request)
    await w.h.until(server.id, 'running')
    await w.h.settled(server.id)
    await w.subscriptionNow(owner, plus, { status: 'canceled' })
    await pays(owner, [{ sub: randomUUID(), product: CORE_PRODUCT, at: new Date().toISOString() }])
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('core')
    return { owner, server }
  }

  test('moving down from Plus: a modded world stops whole, and starts again with Plus', async () => {
    const { owner, server } = await movedDown('Dee', {
      name: 'Modded',
      loader: 'fabric',
      gameVersion: '26.2',
    })
    const stopped = await w.h.until(server.id, 'stopped')
    expect(stopped.lifecycle.stopReason).toBe('entitlement')
    // Nothing was converted or taken off it: same world, same server type.
    expect(stopped.activeWorldId).toBe(server.activeWorldId)
    expect((await loadRevision(w.h.db, stopped.desiredRevisionId)).loader).toBe('fabric')
    await w.h.settled(server.id)
    expect(await refusal(w.h.app.servers.start(owner, server.id, randomUUID()))).toMatchObject({
      code: 'not_entitled',
      message: 'This server’s type comes with Plus. Its world is safe, and it starts again with Plus.',
    })
    // The player may stay on Core and wait, or pay for Plus again: it starts as it was.
    await pays(owner, [{ sub: randomUUID(), product: PLUS_PRODUCT, at: new Date().toISOString() }])
    await w.h.app.servers.start(owner, server.id, randomUUID())
    await w.h.until(server.id, 'running')
  }, 60_000)

  test('moving down from Plus: a bigger server waits as it is until its owner resizes it or goes back', async () => {
    const { owner, server } = await movedDown('Eve', { name: 'Large', partySize: '20' })
    expect(server.memoryTier).toBe('8g')
    await w.h.until(server.id, 'stopped')
    await w.h.settled(server.id)
    expect(await refusal(w.h.app.servers.start(owner, server.id, randomUUID()))).toMatchObject({
      code: 'not_entitled',
      message: 'Your plan does not include servers this size. Plus runs it as it is, or you can resize it.',
    })
    // Nothing was resized for them, and a resize to what Core holds is theirs to make. Its settings
    // are Plus's too, and Core's caps refuse them rather than lower them.
    expect((await w.h.server(server.id)).memoryTier).toBe('8g')
    const { settings } = await loadRevision(w.h.db, (await w.h.server(server.id)).desiredRevisionId)
    await w.h.app.revisions.changeSettings(
      owner,
      server.id,
      { ...settings, maxPlayers: 5, viewDistance: 8, simulationDistance: 6 },
      randomUUID(),
    )
    await w.h.app.revisions.resize(owner, server.id, '3g', randomUUID())
    await w.h.app.servers.start(owner, server.id, randomUUID())
    await w.h.until(server.id, 'running')
  }, 90_000)
})

describe.skipIf(!hasDatabase)('Core’s extra play', () => {
  test('past its 40 hours Core allows extra play like Plus: the owner’s limit, the same meter, billed on Core', async () => {
    const owner = await w.h.user('Gus')
    const sub = randomUUID()
    await pays(owner, [{ sub, product: CORE_PRODUCT, at: new Date().toISOString() }])
    // Nothing is allowed until a first payment has gone through, and the words say which plan.
    expect(await refusal(w.h.app.accounts.allowExtraPlay(owner, 20))).toMatchObject({
      message: 'Extra hours open once your first Core payment has gone through.',
    })
    await w.ordered(owner, sub, {
      product_id: CORE_PRODUCT,
      created_at: new Date().toISOString(),
      items: [orderItem(999, CORE_FIXED_PRICE)],
    })
    expect(await w.h.app.accounts.allowExtraPlay(owner, 20)).toBe(20)
    const { usage, entitlements } = await w.h.app.accountQueries.overview(owner)
    expect(entitlements).toMatchObject({ includedUnits: 40, mayBuyMore: true })
    expect(usage.unitCents).toBe(25)
    expect(usage.extra).toMatchObject({ may: true, why: null })
    // More than the owner may allow is refused, never lowered.
    expect(await refusal(w.h.app.accounts.allowExtraPlay(owner, usage.extra.ceiling + 1))).toMatchObject({
      code: 'invalid_choice',
    })
    // Core stops at 60 extra hours, which is all Polar bills at its price, however much the account's
    // own ceiling allows: after a renewal is paid, 60 may be allowed and no more.
    await w.ordered(owner, sub, {
      product_id: CORE_PRODUCT,
      billing_reason: 'subscription_cycle',
      created_at: new Date().toISOString(),
      items: [orderItem(999, CORE_FIXED_PRICE)],
    })
    expect(await w.h.app.accounts.allowExtraPlay(owner, 60)).toBe(60)
    expect(await refusal(w.h.app.accounts.allowExtraPlay(owner, 61))).toMatchObject({
      code: 'invalid_choice',
    })
    const renewed = await w.h.app.accountQueries.overview(owner)
    expect(renewed.usage.extra).toMatchObject({ ceiling: 60, nextCeiling: null })
    expect(renewed.usage.extra.choices.every((units) => units <= 60)).toBe(true)
    // A renewal's extra line on Core's metered price is extra play on the order, on the Core plan.
    const id = await w.renewalWithExtra(owner, sub, new Date(), { status: 'paid', core: true })
    expect(await w.kept(id)).toMatchObject({ planKey: 'core', extraCents: 250, totalCents: 1249 })
  }, 30_000)

  test('extra hours on Core are counted past the included ones and no further than the owner allowed', async () => {
    const owner = await w.h.user('Hal')
    const sub = randomUUID()
    // Subscribed since the month began, so the runs below are on Core.
    const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) + 60_000)
    await pays(owner, [{ sub, product: CORE_PRODUCT, at: since.toISOString() }])
    await w.ordered(owner, sub, { product_id: CORE_PRODUCT, created_at: since.toISOString() })
    // An hour included, so a few hours of play reach the extra; the 40 are the table's own.
    await w.h.app.accounts.setLimits({ kind: 'admin', userId: 'admin' }, owner.userId, {
      maxServers: null,
      maxRunning: null,
      includedUnits: 1,
    })
    expect(await w.h.app.accounts.allowExtraPlay(owner, 2)).toBe(2)
    const server = await create(owner, { name: 'Counted' })
    await w.h.until(server.id, 'running')
    await w.h.settled(server.id)
    await w.h.app.servers.stop(owner, server.id, randomUUID(), 'user')
    await w.h.until(server.id, 'stopped')
    await w.h.settled(server.id)
    const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
    if (Date.now() - month.getTime() < 6 * HOUR_MS) return
    const now = new Date()
    await w.h.db.insert(schema.powerIntervals).values({
      serverId: server.id,
      memoryTier: '3g',
      startedAt: new Date(now.getTime() - 5 * HOUR_MS),
      stoppedAt: now,
    })
    await w.h.app.billing.usage.count(owner.userId, now)
    const [row] = await w.h.db
      .select()
      .from(schema.extraPlayMonths)
      .where(
        and(
          eq(schema.extraPlayMonths.userId, owner.userId),
          eq(schema.extraPlayMonths.month, month.toISOString().slice(0, 10)),
        ),
      )
    // Five hours played: one included, two allowed and counted, the rest not billed.
    expect(row?.accruedMilli).toBe(2000)
  }, 60_000)
})

describe.skipIf(!hasDatabase)('moving from Plus to Core at the month’s end', () => {
  test('Plus stays until Polar applies the move, then Core’s limits apply and nothing is lost', async () => {
    const owner = await w.h.user('Ida')
    const sub = randomUUID()
    const end = new Date(Date.now() + 10 * DAY_MS)
    await pays(owner, [{ sub, product: PLUS_PRODUCT, at: '2026-10-01T00:00:00Z' }])
    w.subscriptions.set(
      sub,
      subscription(sub, {
        status: 'active',
        current_period_end: end.toISOString(),
        ended_at: null,
        canceled_at: null,
      }),
    )
    const modded = await create(owner, { name: 'Modded', loader: 'fabric', gameVersion: '26.2' })
    await w.h.until(modded.id, 'running')

    // Core over Plus is not a second payment: the checkout points at the move.
    expect(await refusal(w.h.app.billing.startCheckout(owner, 'core'))).toMatchObject({
      code: 'invalid_choice',
      message: expect.stringContaining('Move to Core from your account'),
    })
    expect(await w.h.app.billing.moveToSmaller(owner, 'core')).toEqual({ plan: 'core', at: end })
    // Asked of Polar as the next period's change; the subscription keeps its product until then.
    expect(w.updates).toContainEqual({
      id: sub,
      body: { product_id: CORE_PRODUCT, proration_behavior: 'next_period' },
    })
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('plus')
    const { plan } = await w.h.app.accountQueries.overview(owner)
    expect(plan).toMatchObject({
      key: 'plus',
      billed: { planKey: 'plus', movesTo: { plan: 'core', at: end } },
    })
    expect((await w.h.server(modded.id)).lifecycle.status).toBe('running')
    expect((await w.audited(owner, 'billing.plan_move_scheduled'))[0]).toMatchObject({
      from: 'plus',
      to: 'core',
    })

    // Nothing else moves: not a larger plan, not a free account, not twice over a cancel.
    expect(await refusal(w.h.app.billing.moveToSmaller(owner, 'plus'))).toMatchObject({
      code: 'invalid_choice',
    })
    const free = await w.h.user('Jon')
    expect(await refusal(w.h.app.billing.moveToSmaller(free, 'core'))).toMatchObject({
      code: 'invalid_choice',
    })

    // The month ends and Polar says the same subscription is Core's now.
    await pays(owner, [{ sub, product: CORE_PRODUCT, at: '2026-10-01T00:00:00Z' }])
    expect((await loadStanding(w.h.db, owner.userId)).plan).toBe('core')
    const after = await w.h.app.accountQueries.overview(owner)
    expect(after.plan.billed).toMatchObject({ planKey: 'core', movesTo: null })
    // As on any move down: the modded server stops whole and says which plan runs it.
    expect((await w.h.until(modded.id, 'stopped')).lifecycle.stopReason).toBe('entitlement')
  }, 60_000)
})

describe.skipIf(!hasDatabase)('a plan set to end beats a move to a smaller one', () => {
  test('Polar saying Plus ends clears the move, and the account says it ends', async () => {
    const owner = await w.h.user('Fay')
    const sub = randomUUID()
    const end = new Date(Date.now() + 10 * DAY_MS)
    await pays(owner, [{ sub, product: PLUS_PRODUCT, at: '2026-10-01T00:00:00Z' }])
    w.subscriptions.set(
      sub,
      subscription(sub, { status: 'active', current_period_end: end.toISOString(), ended_at: null }),
    )
    await w.h.app.billing.moveToSmaller(owner, 'core')
    expect((await w.h.app.accountQueries.overview(owner)).plan.billed).toMatchObject({
      movesTo: { plan: 'core', at: end },
      cancelAtPeriodEnd: false,
    })

    const state = w.polar.states.get(owner.userId)
    const [held] = state?.active_subscriptions ?? []
    if (state === undefined || held === undefined) throw new Error('Polar holds the subscription')
    held.cancel_at_period_end = true
    await w.post(stateChanged(state))
    expect((await w.h.app.accountQueries.overview(owner)).plan.billed).toMatchObject({
      movesTo: null,
      cancelAtPeriodEnd: true,
    })
  })
})
