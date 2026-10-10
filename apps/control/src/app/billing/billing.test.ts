import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { PolarBilling } from '../../infra/polar/polar-billing.ts'
import { createBillingWebhook } from '../../interfaces/billing/webhook.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import {
  customerState,
  order,
  orderEvent,
  PLUS_PRODUCT,
  PolarStandIn,
  signed,
  stateChanged,
  subscription,
  webhookSecret,
} from '../../testing/polar.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { UserActor } from '../actor.ts'
import { PAST_DUE_GRACE_MS } from './persistence.ts'

/**
 * A checkout from where someone met their plan's edge, with the agreement the checkout page asks
 * for (the Terms, and starting now), which the audit log keeps with it.
 */
const FROM_A_MODPACK = {
  reason: 'modpack',
  next: '/servers/new?pack=abc',
  consent: { terms: TERMS_VERSION, startNow: true },
} as const

// Billing end to end (§15.4): checkout and portal links from the real Polar adapter
// against a stand-in for Polar's API, webhooks signed with the deployment's secret through the
// route Polar calls, the plan they put an account on, and what a smaller plan stops.
describe.skipIf(!hasDatabase)('billing', () => {
  let h: Harness
  let webhook: ReturnType<typeof createBillingWebhook>
  const polar = new PolarStandIn()
  const secret = webhookSecret()

  beforeAll(async () => {
    await polar.start()
    const billing = new PolarBilling({
      accessToken: 'polar_oat_test',
      webhookSecret: secret,
      server: 'sandbox',
      products: { plus: PLUS_PRODUCT },
      baseUrl: polar.url,
    })
    h = await startHarness({ capabilities: { archives: null, billing } })
    webhook = createBillingWebhook({ billing: h.app.billing })
  }, 30_000)

  afterAll(async () => {
    await h.close()
    polar.close()
  })

  // Polar, unless a test says otherwise: a subscription a standing leaves out has ended.
  beforeEach(() => {
    polar.reply = ({ path }) =>
      path.startsWith('/v1/subscriptions/')
        ? { status: 200, body: subscription(path.slice('/v1/subscriptions/'.length)) }
        : { status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } }
  })

  /** What Polar does when a customer's state changes: holds the new state, and says so. */
  const deliver = (data: unknown, key = secret) => {
    const externalId = (data as { external_id?: string | null }).external_id
    if (externalId) polar.states.set(externalId, data)
    const delivery = signed(stateChanged(data), key)
    return webhook.request('/api/billing/webhook', {
      method: 'POST',
      body: delivery.body,
      headers: { 'content-type': 'application/json', ...delivery.headers },
    })
  }
  const plus = (owner: UserActor) => deliver(customerState(owner.userId))
  const free = (owner: UserActor) => deliver(customerState(owner.userId, { active_subscriptions: [] }))
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { code?: string }) => error.code ?? 'error',
    )
  const create = (owner: UserActor, name: string) =>
    h.app.servers.createMinecraftServer(owner, {
      idempotencyKey: randomUUID(),
      name,
      playStyle: 'survival',
      partySize: '5',
      regionKey: 'local',
    })

  test('a checkout is for a paid plan and comes back to the account page; the portal is for customers', async () => {
    const owner = await h.user()
    polar.reply = () => ({
      status: 201,
      body: { id: 'co_1', url: 'https://sandbox.polar.sh/checkout/polar_c_1' },
    })
    expect(await h.app.billing.startCheckout(owner, 'plus')).toEqual({
      url: 'https://sandbox.polar.sh/checkout/polar_c_1',
    })
    expect(JSON.parse(polar.requests.at(-1)?.body ?? '')).toMatchObject({
      products: [PLUS_PRODUCT],
      external_customer_id: owner.userId,
      success_url: 'http://localhost:3000/account?from=billing',
    })
    // Paying from where the person met their plan's edge brings them back there, and says why.
    await h.app.billing.startCheckout(owner, 'plus', FROM_A_MODPACK)
    expect(JSON.parse(polar.requests.at(-1)?.body ?? '').success_url).toBe(
      'http://localhost:3000/account?from=billing&next=%2Fservers%2Fnew%3Fpack%3Dabc',
    )
    // Only ever a path in the app: another site is never where a checkout lands.
    for (const away of ['//evil.test/x', '/\\evil.test', 'https://evil.test/'])
      await h.app.billing.startCheckout(owner, 'plus', { next: away })
    for (const request of polar.requests.slice(-3))
      expect(JSON.parse(request.body).success_url).toBe('http://localhost:3000/account?from=billing')
    const started = await h.db
      .select({ data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.subjectId, owner.userId),
          eq(schema.auditLog.action, 'billing.checkout_started'),
        ),
      )
    expect(started.map((row) => row.data)).toEqual([
      { plan: 'plus', reason: 'account' },
      { plan: 'plus', reason: 'modpack', terms: TERMS_VERSION, startNow: true },
      { plan: 'plus', reason: 'account' },
      { plan: 'plus', reason: 'account' },
      { plan: 'plus', reason: 'account' },
    ])
    expect(await refusal(h.app.billing.startCheckout(owner, 'free'))).toBe('invalid_choice')
    expect(await refusal(h.app.billing.customerPortal(owner))).toBe('invalid_choice')

    await plus(owner)
    expect(await refusal(h.app.billing.startCheckout(owner, 'plus'))).toBe('invalid_choice')
    polar.reply = () => ({
      status: 201,
      body: { id: 'cs_1', customer_portal_url: 'https://sandbox.polar.sh/portal?t=1' },
    })
    expect(await h.app.billing.customerPortal(owner)).toEqual({ url: 'https://sandbox.polar.sh/portal?t=1' })

    // Polar down is a refusal people can read.
    polar.down = true
    expect(await refusal(h.app.billing.refresh(owner))).toBe('billing_unavailable')
    polar.down = false
  })

  test('a signed webhook puts the account on its plan; a forged one changes nothing', async () => {
    const owner = await h.user()
    const forged = await deliver(customerState(owner.userId), webhookSecret())
    expect(forged.status).toBe(401)
    polar.states.delete(owner.userId)
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('free')

    const delivered = await plus(owner)
    expect(delivered.status).toBe(200)
    expect(await delivered.json()).toEqual({ outcome: 'synced' })
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('plus')
    const [row] = await h.db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.userId, owner.userId))
    expect(row).toMatchObject({
      provider: 'polar',
      planKey: 'plus',
      status: 'active',
      cancelAtPeriodEnd: false,
    })
    const [audit] = await h.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.subjectId, owner.userId), eq(schema.auditLog.action, 'account.plan_changed')),
      )
    expect(audit).toMatchObject({ actor: 'system:billing', data: { from: 'free', to: 'plus' } })

    // Someone this deployment doesn't know, and events that report no standing, change nothing.
    expect(await (await deliver(customerState(`someone-${randomUUID()}`))).json()).toEqual({
      outcome: 'synced',
    })
    const other = signed(
      { type: 'product.updated', timestamp: new Date().toISOString(), api_version: '2026-10', data: {} },
      secret,
    )
    const ignored = await webhook.request('/api/billing/webhook', {
      method: 'POST',
      body: other.body,
      headers: { 'content-type': 'application/json', ...other.headers },
    })
    expect(await ignored.json()).toEqual({ outcome: 'ignored' })
  })

  test('a downgrade stops what the smaller plan runs past its limit, and starts wait until it fits', async () => {
    const owner = await h.user()
    await plus(owner)
    const first = await create(owner, 'First')
    await h.until(first.id, 'running')
    await h.settled(first.id)
    const third = await create(owner, 'Third')
    await h.until(third.id, 'running')
    await h.settled(third.id)
    await h.app.servers.stop(owner, third.id, randomUUID())
    await h.until(third.id, 'stopped')
    await h.settled(third.id)
    const second = await create(owner, 'Second')
    await h.until(second.id, 'running')
    await h.settled(second.id)

    // Plus ran two at once; free runs one, and has room for one server.
    await free(owner)
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('free')
    const stopped = await h.until(second.id, 'stopped')
    expect(stopped.lifecycle.stopReason).toBe('entitlement')
    expect((await h.server(first.id)).lifecycle.status).toBe('running')
    expect(await refusal(h.app.servers.start(owner, third.id, randomUUID()))).toBe('limit_reached')

    // Nothing was deleted; once two are gone, what is left starts.
    for (const server of [second, third]) {
      await h.app.servers.deleteServer(owner, server.id, server.name)
      await h.settled(server.id)
    }
    await h.app.servers.stop(owner, first.id, randomUUID())
    await h.until(first.id, 'stopped')
    await h.settled(first.id)
    await h.app.servers.start(owner, first.id, randomUUID())
    await h.until(first.id, 'running')
  }, 60_000)

  test('when Plus ends, a modded world is kept as it is: it stops, says why, and starts again with Plus', async () => {
    const owner = await h.user()
    await plus(owner)
    const modded = await h.create(owner, { name: 'Modded', loader: 'fabric', gameVersion: '26.2' })
    await h.until(modded.id, 'running')
    await h.settled(modded.id)

    await free(owner)
    const stopped = await h.until(modded.id, 'stopped')
    expect(stopped.lifecycle.stopReason).toBe('entitlement')
    await h.settled(modded.id)
    // Nothing about it was changed to fit Free: same server type, same world.
    const [revision] = await h.db
      .select({ loader: schema.serverRevisions.loader })
      .from(schema.serverRevisions)
      .where(eq(schema.serverRevisions.id, stopped.desiredRevisionId))
    expect(revision?.loader).toBe('fabric')
    expect(stopped.activeWorldId).toBe(modded.activeWorldId)
    const denied = await h.app.servers.start(owner, modded.id, randomUUID()).then(
      () => null,
      (error: Error) => error.message,
    )
    expect(denied).toBe(
      'This server’s type comes with Plus. Its world is safe, and it starts again with Plus.',
    )
    // A sweep doesn't stop it twice, or change it either.
    expect(await h.app.accounts.enforce()).toMatchObject({ stopped: 0 })

    // Plus again, and it starts as it was.
    await plus(owner)
    await h.app.servers.start(owner, modded.id, randomUUID())
    await h.until(modded.id, 'running')
    await h.settled(modded.id)
  }, 60_000)

  test('a renewal that fails to charge keeps Plus for a week while Polar retries it, and says so', async () => {
    const owner = await h.user()
    const id = randomUUID()
    const paying = () => deliver(customerState(owner.userId, {}, { id }))
    await paying()
    const failedAt = new Date()
    const retrying = subscription(id, {
      status: 'past_due',
      past_due_at: failedAt.toISOString(),
      canceled_at: null,
      ended_at: null,
    })
    polar.reply = ({ path }) =>
      path === `/v1/subscriptions/${id}`
        ? { status: 200, body: retrying }
        : { status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } }
    // Polar's standing after a failed renewal lists nothing that pays.
    expect(await (await free(owner)).json()).toEqual({ outcome: 'synced' })
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('plus')
    const until = new Date(failedAt.getTime() + PAST_DUE_GRACE_MS)
    expect((await h.app.accountQueries.overview(owner)).plan).toMatchObject({
      key: 'plus',
      billed: { status: 'past_due', pastDueUntil: until },
    })
    // Delivered again, nothing moves: the grace still counts from the failure.
    await free(owner)
    expect((await h.app.accountQueries.overview(owner)).plan.billed?.pastDueUntil).toEqual(until)
    // A week on and still unpaid, it's Free.
    const later = new Date(until.getTime() + 60_000)
    expect((await loadStanding(h.db, owner.userId, later)).plan).toBe('free')

    // A retry that pays brings Plus back, no longer past due.
    await paying()
    expect((await h.app.accountQueries.overview(owner)).plan.billed).toMatchObject({
      status: 'active',
      pastDueUntil: null,
    })
    expect((await loadStanding(h.db, owner.userId, later)).plan).toBe('plus')

    // When Polar stops retrying, the subscription is cancelled and Plus ends then, not a week on.
    polar.reply = ({ path }) =>
      path === `/v1/subscriptions/${id}`
        ? { status: 200, body: subscription(id) }
        : { status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } }
    await free(owner)
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('free')
    expect((await h.app.accountQueries.overview(owner)).plan.billed).toMatchObject({ status: 'ended' })

    // Polar not answering is retried, as any delivery that fails is: nothing is decided without it.
    await paying()
    polar.down = true
    expect((await free(owner)).status).toBe(500)
    polar.down = false
    polar.states.set(owner.userId, customerState(owner.userId, {}, { id }))
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('plus')
  })

  test('a delivery Polar sends again late, after a newer one, changes nothing back', async () => {
    const owner = await h.user()
    const id = randomUUID()
    const said = signed(stateChanged(customerState(owner.userId, {}, { id })), secret)
    const send = (delivery: { body: string; headers: Record<string, string> }) =>
      webhook.request('/api/billing/webhook', {
        method: 'POST',
        body: delivery.body,
        headers: { 'content-type': 'application/json', ...delivery.headers },
      })
    polar.states.set(owner.userId, customerState(owner.userId, {}, { id }))
    await send(said)
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('plus')
    // Plus ends, and Polar says so.
    await free(owner)
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('free')
    // Then the first delivery again, as Polar retries one it thinks wasn't taken: still Free.
    expect(await (await send(said)).json()).toEqual({ outcome: 'synced' })
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('free')
    // The same delivery twice in a row is the same as once.
    await deliver(customerState(owner.userId, {}, { id }))
    await deliver(customerState(owner.userId, {}, { id }))
    const rows = await h.db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.userId, owner.userId))
    expect(rows.map((row) => row.status)).toEqual(['active'])
  })

  test('Plus sells extra hours, but none before its first payment is on record', async () => {
    const owner = await h.user()
    await plus(owner)
    const overview = await h.app.accountQueries.overview(owner)
    expect(overview.entitlements).toMatchObject({ includedUnits: 60, mayBuyMore: true })
    const refused = await h.app.accounts.allowExtraPlay(owner, 10).then(
      () => null,
      (error: Error) => error.message,
    )
    expect(refused).toBe('Extra hours open once your first Plus payment has gone through.')
    expect((await loadStanding(h.db, owner.userId)).extraUnitsAllowed).toBe(0)
  })

  test('a paid order is kept as revenue, once, and a refund updates it', async () => {
    const owner = await h.user()
    const send = async (data: unknown, type?: string) => {
      const delivery = signed(orderEvent(data, type), secret)
      const response = await webhook.request('/api/billing/webhook', {
        method: 'POST',
        body: delivery.body,
        headers: { 'content-type': 'application/json', ...delivery.headers },
      })
      return (await response.json()) as { outcome: string }
    }
    const ordersOf = () =>
      h.db.select().from(schema.billingOrders).where(eq(schema.billingOrders.userId, owner.userId))
    const paid = order(owner.userId, { id: `order-${randomUUID()}` })
    expect(await send(paid)).toEqual({ outcome: 'recorded' })
    // Polar delivers again when it isn't sure: still one order.
    expect(await send(paid)).toEqual({ outcome: 'recorded' })
    expect(await ordersOf()).toMatchObject([
      {
        provider: 'polar',
        planKey: 'plus',
        netCents: 1500,
        totalCents: 1500,
        refundedCents: 0,
        currency: 'usd',
      },
    ])
    expect(await send({ ...paid, refunded_amount: 1500 }, 'order.refunded')).toEqual({ outcome: 'recorded' })
    expect((await ordersOf()).map((row) => row.refundedCents)).toEqual([1500])
    // Polar sending the paid delivery again, late, doesn't take the refund back.
    expect(await send(paid)).toEqual({ outcome: 'recorded' })
    expect((await ordersOf()).map((row) => row.refundedCents)).toEqual([1500])
    // Someone this deployment never made isn't its revenue.
    expect(await send(order(`someone-${randomUUID()}`, { id: `order-${randomUUID()}` }))).toEqual({
      outcome: 'ignored',
    })
  })

  test('returning from a checkout reads the provider’s word before its webhook arrives', async () => {
    const owner = await h.user()
    polar.states.set(owner.userId, customerState(owner.userId))
    await h.app.billing.refresh(owner)
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('plus')

    const never = await h.user()
    await h.app.billing.refresh(never)
    expect((await loadStanding(h.db, never.userId)).plan).toBe('free')
  })

  test('the account overview answers each feature as the API would', async () => {
    const owner = await h.user()
    const before = await h.app.accountQueries.overview(owner)
    expect(before.plan).toEqual({ key: 'free', billed: null })
    const feature = (o: typeof before, name: string) => o.features.find((f) => f.feature === name)
    expect(feature(before, 'upload_mod')).toMatchObject({ available: false, code: 'deployment_unsupported' })
    expect(feature(before, 'billing')).toEqual({ feature: 'billing', available: true })
    expect(feature(before, 'create_server')).toEqual({ feature: 'create_server', available: true })

    await deliver(customerState(owner.userId, {}, { cancel_at_period_end: true }))
    const after = await h.app.accountQueries.overview(owner)
    expect(after.plan).toMatchObject({ key: 'plus', billed: { planKey: 'plus', cancelAtPeriodEnd: true } })
    expect(after.entitlements.maxServers).toBe(3)
    expect(after.plans.map((p) => p.key)).toEqual(['free', 'plus'])
  })
})
