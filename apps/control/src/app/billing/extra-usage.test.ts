/**
 * Extra play end to end, through the real Polar adapter against a stand-in for Polar's API: who
 * may allow it (each guard, from what Polar's webhooks said), the servers that stop when it runs
 * out, the hours counted and sent to Polar through the outbox (retries, duplicates, a batch Polar
 * refuses, a month boundary, a renewal in the middle), a cancel, and a payment that fails until it
 * is owed and then is paid.
 */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
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
import { warnAboutExtra } from '../accounts/extra-play.ts'
import type { UserActor } from '../actor.ts'
import { extraThisMonth } from './extra-usage.ts'

const FIXED_PRICE = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c001'
const METERED_PRICE = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c002'

let h: Harness
let webhook: ReturnType<typeof createBillingWebhook>
const polar = new PolarStandIn()
const secret = webhookSecret()
/** Subscriptions as Polar holds them now, by id: what `pastDueSince` reads. */
const subscriptions = new Map<string, Record<string, unknown>>()
/** What Polar answers an ingest with; a test sets it to fail. */
let ingest: () => { status: number; body: unknown } = () => ({
  status: 200,
  body: { inserted: 1, duplicates: 0 },
})

beforeAll(async () => {
  if (!hasDatabase) return
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
  if (!hasDatabase) return
  await h.close()
  polar.close()
})

beforeEach(() => {
  ingest = () => ({ status: 200, body: { inserted: 1, duplicates: 0 } })
  polar.reply = ({ method, path }) => {
    if (method === 'POST' && path.startsWith('/v1/events/ingest')) return ingest()
    if (path.startsWith(`/v1/products/${PLUS_PRODUCT}`))
      return {
        status: 200,
        body: {
          id: PLUS_PRODUCT,
          prices: [
            { id: FIXED_PRICE, amount_type: 'fixed' },
            { id: METERED_PRICE, amount_type: 'metered_unit' },
          ],
        },
      }
    const id = path.startsWith('/v1/subscriptions/') ? path.slice('/v1/subscriptions/'.length) : null
    if (id !== null) return { status: 200, body: subscriptions.get(id) ?? subscription(id) }
    return { status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } }
  }
})

const post = (event: unknown) => {
  const delivery = signed(event, secret)
  return webhook.request('/api/billing/webhook', {
    method: 'POST',
    body: delivery.body,
    headers: { 'content-type': 'application/json', ...delivery.headers },
  })
}

/** Polar's word on the account's subscription, as a customer state now and its delivery. */
const standing = async (
  owner: UserActor,
  sub: string,
  patch: Record<string, unknown> = {},
  paying = true,
) => {
  const state = customerState(owner.userId, paying ? {} : { active_subscriptions: [] }, {
    id: sub,
    ...patch,
  })
  polar.states.set(owner.userId, state)
  await post(stateChanged(state))
}

/** An order for the subscription, as Polar delivers it; paid, for Plus alone, unless patched. */
const ordered = async (
  owner: UserActor,
  sub: string,
  patch: Record<string, unknown> = {},
  type = 'order.paid',
) => {
  const id = `order-${randomUUID()}`
  await post(orderEvent(order(owner.userId, { id, subscription_id: sub, ...patch }), type))
  return id
}

/** A new Plus subscriber, its first payment made unless `paid` is false. */
const subscriber = async (name: string, paid = true) => {
  const owner = await h.user(name)
  const sub = randomUUID()
  await standing(owner, sub)
  if (paid) await ordered(owner, sub, { created_at: new Date().toISOString() })
  return { owner, sub }
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { message?: string }) => error.message ?? '',
  )

/** The 15th of next month: two weeks of room behind it, after anything the harness really ran. */
const today = new Date()
const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 15))

/** A run that happened on a stopped server: one closed interval of `hours`, ending before `end`. */
const ran = (serverId: string, hours: number, end = at, tier = '3g') =>
  h.db.insert(schema.powerIntervals).values({
    serverId,
    memoryTier: tier,
    startedAt: new Date(end.getTime() - 60_000 - hours * 3_600_000),
    stoppedAt: new Date(end.getTime() - 60_000),
  })

/** A server the owner made and stopped, for runs to be written against. */
const stoppedServer = async (owner: UserActor) => {
  const server = await h.create(owner)
  await h.until(server.id, 'running')
  await h.settled(server.id)
  await h.app.servers.stop(owner, server.id, crypto.randomUUID(), 'user')
  await h.until(server.id, 'stopped')
  await h.settled(server.id)
  return server
}

/** The owner starting a server with the policy deciding at `when`: null, or what they are told. */
const startAt = async (owner: UserActor, serverId: string, when = at) => {
  const policy = h.app.policy
  const check = policy.check.bind(policy)
  const pinned = spyOn(policy, 'check').mockImplementation((tx, id, capability, _now, options) =>
    check(tx, id, capability, when, options),
  )
  try {
    return await refusal(h.app.servers.start(owner, serverId, crypto.randomUUID()))
  } finally {
    pinned.mockRestore()
  }
}

const reportsOf = (owner: UserActor) =>
  h.db.select().from(schema.extraPlayReports).where(eq(schema.extraPlayReports.userId, owner.userId))
const ingested = () =>
  polar.requests
    .filter((r) => r.path.startsWith('/v1/events/ingest'))
    .flatMap((r) => (JSON.parse(r.body) as { events: Array<Record<string, unknown>> }).events)

test.skipIf(!hasDatabase)(
  'only a paying Plus subscriber may allow extra, up to $5 until a renewal is paid',
  async () => {
    const { owner, sub } = await subscriber('Ash', false)
    // Subscribed, but nothing paid yet.
    expect(await refusal(h.app.accounts.allowExtraPlay(owner, 20))).toBe(
      'Extra hours open once your first Plus payment has gone through.',
    )
    // The first payment: up to 20, and no further.
    await ordered(owner, sub)
    expect(await h.app.accounts.allowExtraPlay(owner, 20)).toBe(20)
    expect(await refusal(h.app.accounts.allowExtraPlay(owner, 21))).toBe(
      'You can allow up to 20 extra hours a month until your first renewal is paid, then up to 100.',
    )
    const before = await h.app.accountQueries.overview(owner)
    expect(before.usage.extra).toMatchObject({ may: true, ceiling: 20, nextCeiling: 100, choices: [0, 20] })
    // A renewal paid: up to 100.
    await ordered(owner, sub, { billing_reason: 'subscription_cycle' })
    expect(await h.app.accounts.allowExtraPlay(owner, 100)).toBe(100)
    const after = await h.app.accountQueries.overview(owner)
    expect(after.usage.extra).toMatchObject({ ceiling: 100, nextCeiling: null, choices: [0, 20, 50, 100] })
    // A refund in full of every payment takes it back to nothing paid.
    const free = await h.user('Kim')
    expect(await refusal(h.app.accounts.allowExtraPlay(free, 20))).toBe('Extra hours come with Plus.')
    // None is always allowed, whatever the account.
    expect(await h.app.accounts.allowExtraPlay(free, 0)).toBe(0)
  },
)

test.skipIf(!hasDatabase)('a $0 order, or one refunded in full, is not a payment', async () => {
  const { owner, sub } = await subscriber('Lee', false)
  await ordered(owner, sub, { net_amount: 0, total_amount: 0, subtotal_amount: 0, discount_amount: 1500 })
  const refunded = await ordered(owner, sub)
  expect(await h.app.accounts.allowExtraPlay(owner, 20)).toBe(20)
  await post(
    orderEvent(
      order(owner.userId, { id: refunded, subscription_id: sub, refunded_amount: 1500 }),
      'order.refunded',
    ),
  )
  expect(await refusal(h.app.accounts.allowExtraPlay(owner, 20))).toBe(
    'Extra hours open once your first Plus payment has gone through.',
  )
})

test.skipIf(!hasDatabase)(
  'without extra it sleeps at the block; allowing some starts it; at the limit it sleeps',
  async () => {
    const { owner } = await subscriber('Mo')
    const server = await stoppedServer(owner)
    await ran(server.id, 60)
    expect(await startAt(owner, server.id)).toBe(
      'You have used this month’s play time. Allow extra play in your account, or wait for the 1st.',
    )
    await h.app.accounts.allowExtraPlay(owner, 20)
    expect(await startAt(owner, server.id)).toBeNull()
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.servers.stop(owner, server.id, crypto.randomUUID(), 'user')
    await h.until(server.id, 'stopped')
    await h.settled(server.id)
    await ran(server.id, 20, new Date(at.getTime() - 2 * 3_600_000))
    expect(await startAt(owner, server.id)).toBe(
      'You have used the extra play you allowed this month. Raise it in your account, or wait for the 1st.',
    )
  },
  60_000,
)

// The sweep stops a server already running once the month's play, with any extra allowed,
// runs out. Runs written in this month, so the sweep's own clock counts them; an hour of room.
const monthRoom = Date.now() - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)
test.skipIf(!hasDatabase || monthRoom < 3 * 3_600_000)(
  'a running server stops for hours when what was allowed runs out, and says so',
  async () => {
    const { owner } = await subscriber('Nia')
    const admin = { kind: 'admin', userId: 'admin' } as const
    await h.app.accounts.setLimits(admin, owner.userId, {
      maxServers: null,
      maxRunning: null,
      includedUnits: 1,
    })
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    // Still within the hour: nothing stops.
    expect(await h.app.accounts.enforceLimits(owner.userId)).toBe(0)
    await ran(server.id, 1, new Date())
    expect(await h.app.accounts.enforceLimits(owner.userId)).toBe(1)
    const stopped = await h.until(server.id, 'stopped')
    expect(stopped.lifecycle.stopReason).toBe('hours')
    // An extra hour allowed: it starts, and stops again once that hour is played too.
    await h.app.accounts.allowExtraPlay(owner, 1)
    await h.settled(server.id)
    await h.app.servers.start(owner, server.id, crypto.randomUUID())
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect(await h.app.accounts.enforceLimits(owner.userId)).toBe(0)
    await ran(server.id, 1, new Date())
    expect(await h.app.accounts.enforceLimits(owner.userId)).toBe(1)
    expect((await h.until(server.id, 'stopped')).lifecycle.stopReason).toBe('hours')
  },
  60_000,
)

test.skipIf(!hasDatabase)(
  'extra play is counted as played, held to the limit, and sent once under its own id',
  async () => {
    const { owner } = await subscriber('Ola')
    await h.app.accounts.allowExtraPlay(owner, 20)
    const server = await stoppedServer(owner)
    const usage = h.app.billing.usage
    // Within the included hours: nothing is counted.
    await ran(server.id, 59, new Date(at.getTime() - 30 * 3_600_000))
    expect(await usage.count(owner.userId, at)).toBe(false)
    // An hour and a half past them, on a large server: three hours, counted in thousandths.
    await ran(server.id, 1, new Date(at.getTime() - 20 * 3_600_000))
    await ran(server.id, 1.5, new Date(at.getTime() - 10 * 3_600_000), '8g')
    expect(await usage.count(owner.userId, at)).toBe(true)
    expect(await extraThisMonth(h.db, owner.userId, at)).toEqual({ countedUnits: 3, reportedUnits: 0 })
    // Counting again finds nothing new.
    expect(await usage.count(owner.userId, at)).toBe(false)

    // A quarter of an hour waits, so an event is cut, and sent.
    expect(await usage.cut(at)).toBe(1)
    expect(await usage.send()).toEqual({ sent: 1, failed: 0 })
    const month = at.toISOString().slice(0, 7)
    const [event] = ingested().filter((e) => e.external_customer_id === owner.userId)
    expect(event).toEqual({
      name: 'play.extra',
      external_customer_id: owner.userId,
      external_id: `extra:${owner.userId}:${month}:1`,
      timestamp: new Date(at.getTime() - 60_000).toISOString(),
      metadata: { hours: 3 },
    })
    // Sent is sent: nothing goes again.
    expect(await usage.send()).toEqual({ sent: 0, failed: 0 })

    // Far past the limit: only up to the 20 allowed are ever counted.
    await ran(server.id, 40, new Date(at.getTime() - 3 * 3_600_000))
    await usage.count(owner.userId, at)
    expect(await extraThisMonth(h.db, owner.userId, at)).toEqual({ countedUnits: 20, reportedUnits: 3 })
    await usage.cut(at)
    await usage.send()
    expect((await reportsOf(owner)).map((r) => [r.milli, r.sentAt !== null])).toEqual([
      [3000, true],
      [17000, true],
    ])
    // A lower limit later never takes back what was played.
    await h.app.accounts.allowExtraPlay(owner, 0)
    expect(await usage.count(owner.userId, at)).toBe(false)
    expect(await extraThisMonth(h.db, owner.userId, at)).toEqual({ countedUnits: 20, reportedUnits: 20 })
  },
  60_000,
)

test.skipIf(!hasDatabase)(
  'a small remainder waits ten minutes, then goes on its own',
  async () => {
    const { owner } = await subscriber('Pat')
    await h.app.accounts.allowExtraPlay(owner, 20)
    const server = await stoppedServer(owner)
    await ran(server.id, 60.1, new Date(at.getTime() - 3_600_000))
    await h.app.billing.usage.count(owner.userId, at)
    expect(await h.app.billing.usage.cut(at)).toBe(0)
    expect(await h.app.billing.usage.cut(new Date(at.getTime() + 10 * 60_000))).toBe(1)
    expect((await reportsOf(owner)).map((r) => r.milli)).toEqual([100])
  },
  60_000,
)

test.skipIf(!hasDatabase)(
  'Polar down, or a batch it refuses: nothing is lost, and nothing is billed twice',
  async () => {
    const { owner } = await subscriber('Quinn')
    await h.app.accounts.allowExtraPlay(owner, 20)
    const server = await stoppedServer(owner)
    await ran(server.id, 62, new Date(at.getTime() - 5 * 3_600_000))
    await h.app.billing.usage.count(owner.userId, at)
    await h.app.billing.usage.cut(at)
    // Down: nothing is taken, and the event waits under its id.
    polar.down = true
    const down = await h.app.billing.usage.send()
    polar.down = false
    expect(down.sent).toBe(0)
    const [waiting] = await reportsOf(owner)
    expect(waiting).toMatchObject({ sentAt: null, attempts: 1 })
    expect(waiting?.lastError).toContain('maintenance')
    // Back: the same id goes again, and Polar counting it a duplicate is as good as taking it.
    ingest = () => ({ status: 200, body: { inserted: 0, duplicates: 1 } })
    expect((await h.app.billing.usage.send()).failed).toBe(0)
    const ids = ingested()
      .filter((e) => e.external_customer_id === owner.userId)
      .map((e) => e.external_id)
    expect(new Set(ids)).toEqual(new Set([`extra:${owner.userId}:${at.toISOString().slice(0, 7)}:1`]))
    expect((await reportsOf(owner)).every((r) => r.sentAt !== null)).toBe(true)

    // A batch Polar refuses is sent one at a time: one it won't take holds back nothing else.
    const other = await subscriber('Rae')
    await h.app.accounts.allowExtraPlay(other.owner, 20)
    const theirs = await stoppedServer(other.owner)
    await ran(theirs.id, 61, new Date(at.getTime() - 5 * 3_600_000))
    await ran(server.id, 2, new Date(at.getTime() - 2 * 3_600_000))
    await h.app.billing.usage.count(owner.userId, at)
    await h.app.billing.usage.count(other.owner.userId, at)
    await h.app.billing.usage.cut(at)
    ingest = () => {
      const last = polar.requests.at(-1)?.body ?? ''
      return last.includes(other.owner.userId)
        ? {
            status: 422,
            body: { detail: [{ loc: ['body', 'events', 0, 'timestamp'], msg: 'in the future' }] },
          }
        : { status: 200, body: { inserted: 1, duplicates: 0 } }
    }
    const partly = await h.app.billing.usage.send()
    expect(partly.sent).toBeGreaterThanOrEqual(1)
    expect((await reportsOf(owner)).every((r) => r.sentAt !== null)).toBe(true)
    expect((await reportsOf(other.owner)).map((r) => r.sentAt)).toEqual([null])
    // Taken later, still under its first id.
    ingest = () => ({ status: 200, body: { inserted: 1, duplicates: 0 } })
    await h.app.billing.usage.send()
    expect(
      (await reportsOf(other.owner)).map((r) => [r.externalId.endsWith(':1'), r.sentAt !== null]),
    ).toEqual([[true, true]])
  },
  90_000,
)

test.skipIf(!hasDatabase)(
  'a month ends: its last hour is counted, and what is left of it goes',
  async () => {
    const { owner } = await subscriber('Sky')
    await h.app.accounts.allowExtraPlay(owner, 20)
    const server = await stoppedServer(owner)
    const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
    // Ten minutes into the next month, a run that ended just before midnight.
    await ran(server.id, 60.05, new Date(next.getTime() - 60_000))
    const tenPast = new Date(next.getTime() + 10 * 60_000)
    expect(await h.app.billing.usage.count(owner.userId, tenPast)).toBe(true)
    // Fifty units' worth of thousandths: under a quarter of an hour, but the month is over.
    expect(await h.app.billing.usage.cut(tenPast)).toBe(1)
    const [report] = await reportsOf(owner)
    expect(report).toMatchObject({ month: at.toISOString().slice(0, 7).concat('-01'), milli: 50 })
    expect(report?.externalId).toBe(`extra:${owner.userId}:${at.toISOString().slice(0, 7)}:1`)
  },
  60_000,
)

test.skipIf(!hasDatabase)(
  'a renewal in the middle raises the ceiling and the count carries on',
  async () => {
    const { owner, sub } = await subscriber('Tao')
    await h.app.accounts.allowExtraPlay(owner, 20)
    const server = await stoppedServer(owner)
    await ran(server.id, 70, new Date(at.getTime() - 50 * 3_600_000))
    await h.app.billing.usage.count(owner.userId, at)
    await h.app.billing.usage.cut(at)
    await ordered(owner, sub, { billing_reason: 'subscription_cycle' })
    await h.app.accounts.allowExtraPlay(owner, 50)
    await ran(server.id, 30, new Date(at.getTime() - 3_600_000))
    await h.app.billing.usage.count(owner.userId, at)
    await h.app.billing.usage.cut(at)
    expect((await reportsOf(owner)).map((r) => [r.externalId.split(':').at(-1), r.milli])).toEqual([
      ['1', 10_000],
      ['2', 30_000],
    ])
  },
  60_000,
)

test.skipIf(!hasDatabase)(
  'a paid renewal is checked against what was sent for it, once',
  async () => {
    const { owner, sub } = await subscriber('Ira')
    await h.app.accounts.allowExtraPlay(owner, 20)
    const server = await stoppedServer(owner)
    await ran(server.id, 63.5, new Date(at.getTime() - 5 * 3_600_000))
    await h.app.billing.usage.count(owner.userId, at)
    await h.app.billing.usage.cut(at)
    await h.app.billing.usage.send()
    const renewal = {
      status: 'paid',
      billing_reason: 'subscription_cycle',
      created_at: new Date(Date.now() + 60_000).toISOString(),
      items: [
        { amount: 1500, product_price_id: FIXED_PRICE },
        { amount: 88, product_price_id: METERED_PRICE },
      ],
    }
    const id = await ordered(owner, sub, renewal)
    // Polar's word again is the same order: still one entry.
    await post(orderEvent(order(owner.userId, { id, subscription_id: sub, ...renewal })))
    const entries = await h.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectId, owner.userId))
    expect(entries.filter((e) => e.action === 'billing.extra_billed').map((e) => e.data)).toEqual([
      { order: id, billedCents: 88, reportedCents: 88, matches: true },
    ])
  },
  60_000,
)

test.skipIf(!hasDatabase)(
  'cancelling stops extra at once, and what was played still goes to Polar',
  async () => {
    const { owner, sub } = await subscriber('Uma')
    await h.app.accounts.allowExtraPlay(owner, 20)
    const server = await stoppedServer(owner)
    await ran(server.id, 61, new Date(at.getTime() - 5 * 3_600_000))
    await h.app.billing.usage.count(owner.userId, at)
    await standing(owner, sub, { cancel_at_period_end: true })
    const overview = await h.app.accountQueries.overview(owner)
    expect(overview.usage.extra).toMatchObject({
      may: false,
      why: 'Your Plus is set to end, so extra hours are off. Keep Plus in Manage billing to allow them.',
      choices: [],
    })
    expect(await startAt(owner, server.id)).toBe(
      'You have used this month’s play time, and it resets on the 1st. Your Plus is set to end, so extra hours are off. Keep Plus in Manage billing to allow them.',
    )
    // Nothing more is counted, but the hour played before is cut and sent.
    await ran(server.id, 2, new Date(at.getTime() - 2 * 3_600_000))
    expect(await h.app.billing.usage.count(owner.userId, at)).toBe(false)
    await h.app.billing.usage.cut(at)
    await h.app.billing.usage.send()
    expect((await reportsOf(owner)).map((r) => [r.milli, r.sentAt !== null])).toEqual([[1000, true]])
  },
  60_000,
)

test.skipIf(!hasDatabase)(
  'a payment carrying extra fails, is told, becomes owed, blocks, and paying clears it',
  async () => {
    const { owner, sub } = await subscriber('Vic')
    await h.app.accounts.allowExtraPlay(owner, 20)
    const server = await stoppedServer(owner)
    // The renewal is made, with $2.50 of extra hours on it, and its charge fails.
    const madeAt = new Date()
    const renewal = await ordered(
      owner,
      sub,
      {
        status: 'pending',
        paid: false,
        billing_reason: 'subscription_cycle',
        created_at: madeAt.toISOString(),
        subtotal_amount: 1750,
        net_amount: 1750,
        total_amount: 1750,
        items: [
          { amount: 1500, product_price_id: FIXED_PRICE },
          { amount: 250, product_price_id: METERED_PRICE },
        ],
      },
      'order.created',
    )
    subscriptions.set(
      sub,
      subscription(sub, { status: 'past_due', past_due_at: madeAt.toISOString(), ended_at: null }),
    )
    await standing(owner, sub, {}, false)
    const [kept] = await h.db
      .select()
      .from(schema.billingOrders)
      .where(eq(schema.billingOrders.externalOrderId, renewal))
    expect(kept).toMatchObject({ status: 'pending', extraCents: 250, externalSubscriptionId: sub })
    expect(await refusal(h.app.accounts.allowExtraPlay(owner, 20))).toBe(
      'Your last payment didn’t go through, so extra hours are off until it does.',
    )
    // Told once, with what to do; not blocked yet, while the card is tried again.
    const mails = h.mail.sent.length
    await h.app.billing.tellAboutPayments(madeAt)
    await h.app.billing.tellAboutPayments(madeAt)
    const failed = h.mail.sent.slice(mails)
    expect(failed.map((m) => m.subject)).toEqual(['Your Cubepals payment didn’t go through'])
    expect(failed[0]?.text).toContain('Your Plus payment of $17.50, with $2.50 of extra hours in it')
    expect(await startAt(owner, server.id, madeAt)).toBeNull()
    await h.until(server.id, 'running')
    await h.settled(server.id)

    // The subscription ends unpaid: the account owes it, its servers stop, and nothing new starts.
    subscriptions.set(sub, subscription(sub, { status: 'canceled' }))
    await standing(owner, sub, {}, false)
    expect((await h.until(server.id, 'stopped')).lifecycle.stopReason).toBe('unpaid')
    await h.settled(server.id)
    await h.app.billing.tellAboutPayments()
    expect(h.mail.sent.at(-1)?.subject).toBe('Your Cubepals servers can’t start until a payment is made')
    expect(h.mail.sent.at(-1)?.text).toContain('You owe $17.50 from a Plus payment')
    const owes =
      'You owe $17.50 from a payment that didn’t go through. Pay it in Manage billing on your account, and your servers can start again.'
    expect(await refusal(h.app.servers.start(owner, server.id, crypto.randomUUID()))).toBe(owes)
    expect(await refusal(h.create(owner, { name: 'Another' }))).toBe(owes)
    expect(
      await refusal(
        h.app.billing.startCheckout(owner, 'plus', { consent: { terms: TERMS_VERSION, startNow: true } }),
      ),
    ).toBe('You owe $17.50 from a payment that didn’t go through. Pay it in Manage billing first.')
    expect((await h.app.accountQueries.overview(owner)).usage.extra.owedCents).toBe(1750)
    // The portal, where it is paid, stays open.
    polar.reply = () => ({ status: 201, body: { customer_portal_url: 'https://polar.test/portal' } })
    expect(await h.app.billing.customerPortal(owner)).toEqual({ url: 'https://polar.test/portal' })

    // Paid: the block clears on its own.
    await post(
      orderEvent(
        order(owner.userId, {
          id: renewal,
          subscription_id: sub,
          status: 'paid',
          billing_reason: 'subscription_cycle',
          total_amount: 1750,
          net_amount: 1750,
          subtotal_amount: 1750,
          items: [],
        }),
        'order.paid',
      ),
    )
    // A late delivery of the order as it was made doesn't make it unpaid again.
    await post(
      orderEvent(
        order(owner.userId, { id: renewal, subscription_id: sub, status: 'pending' }),
        'order.updated',
      ),
    )
    expect((await h.app.accountQueries.overview(owner)).usage.extra.owedCents).toBe(0)
    expect(await refusal(h.app.servers.start(owner, server.id, crypto.randomUUID()))).toBeNull()
  },
  90_000,
)

test.skipIf(!hasDatabase)(
  'extra play is emailed when it starts, at 80% and at 100% of the limit, once each',
  async () => {
    const { owner } = await subscriber('Wren')
    await h.app.accounts.allowExtraPlay(owner, 20)
    const server = await stoppedServer(owner)
    const send = { db: h.db, mailer: h.mail, origin: 'http://localhost:3000' }
    const email =
      (await h.db.select().from(schema.users).where(eq(schema.users.id, owner.userId)))[0]?.email ?? ''
    const subjects = () => h.mail.to(email).map((m) => m.subject)
    await ran(server.id, 60, new Date(at.getTime() - 40 * 3_600_000))
    expect(await warnAboutExtra(send, owner.userId, at)).toBeNull()
    await ran(server.id, 1, new Date(at.getTime() - 30 * 3_600_000))
    expect(await warnAboutExtra(send, owner.userId, at)).toBe(0)
    expect(await warnAboutExtra(send, owner.userId, at)).toBeNull()
    await ran(server.id, 15, new Date(at.getTime() - 20 * 3_600_000))
    expect(await warnAboutExtra(send, owner.userId, at)).toBe(80)
    await ran(server.id, 4, new Date(at.getTime() - 10 * 3_600_000))
    expect(await warnAboutExtra(send, owner.userId, at)).toBe(100)
    expect(await warnAboutExtra(send, owner.userId, at)).toBeNull()
    expect(subjects().slice(-3)).toEqual([
      'You’re on extra hours now',
      'You’ve used 80% of the extra hours you allowed',
      'Your Cubepals servers are asleep until the 1st',
    ])
    expect(h.mail.sent.at(-1)?.text).toContain(
      'You’ve played the 20 extra hours you allowed this month: $5.00',
    )
  },
  60_000,
)
