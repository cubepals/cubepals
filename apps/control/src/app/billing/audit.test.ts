// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The billing audit trail: every change to a subscription, and to the plan it gives,
 * is in the audit log with who made it, when, and from where (a webhook, the person, or the
 * standing sweep finding paid time that ran out), so a billing dispute can be answered.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, asc, eq } from 'drizzle-orm'
import { PolarBilling } from '../../infra/polar/polar-billing.ts'
import { createBillingWebhook } from '../../interfaces/billing/webhook.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import {
  customerState,
  PLUS_PRODUCT,
  PolarStandIn,
  signed,
  stateChanged,
  subscription,
  webhookSecret,
} from '../../testing/polar.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { UserActor } from '../actor.ts'
import { type SubscriptionSnapshot, subscriptionChanges } from './audit.ts'
import { PAST_DUE_GRACE_MS, RENEWAL_GRACE_MS } from './persistence.ts'

const snap = (patch: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  id: 'sub_1',
  provider: 'polar',
  planKey: 'plus',
  status: 'active',
  currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
  cancelAtPeriodEnd: false,
  pastDueAt: null,
  ...patch,
})
const changes = (before: SubscriptionSnapshot | null, after: SubscriptionSnapshot) =>
  subscriptionChanges(
    new Map(before === null ? [] : [['polar:sub_1', before]]),
    new Map([['polar:sub_1', after]]),
  ).map((entry) => entry.action)

describe('subscription changes', () => {
  test('each change to a subscription is one entry, and no change is none', () => {
    expect(changes(null, snap())).toEqual(['billing.subscribed'])
    expect(changes(null, snap({ cancelAtPeriodEnd: true }))).toEqual([
      'billing.subscribed',
      'billing.cancel_scheduled',
    ])
    expect(changes(snap({ status: 'ended' }), snap())).toEqual(['billing.subscribed'])
    expect(changes(snap(), snap())).toEqual([])
    expect(changes(snap(), snap({ cancelAtPeriodEnd: true }))).toEqual(['billing.cancel_scheduled'])
    expect(changes(snap({ cancelAtPeriodEnd: true }), snap())).toEqual(['billing.cancel_undone'])
    expect(changes(snap({ planKey: 'pro' }), snap())).toEqual(['billing.plan_switched'])
    expect(changes(snap(), snap({ status: 'past_due', pastDueAt: new Date() }))).toEqual([
      'billing.renewal_failed',
    ])
    expect(changes(snap({ status: 'past_due' }), snap())).toEqual(['billing.renewal_recovered'])
    expect(changes(snap(), snap({ status: 'ended' }))).toEqual(['billing.subscription_ended'])
    expect(changes(snap({ status: 'past_due' }), snap({ status: 'ended' }))).toEqual([
      'billing.subscription_ended',
    ])
    expect(changes(snap({ status: 'ended' }), snap({ status: 'ended' }))).toEqual([])
  })
})

let h: Harness
let webhook: ReturnType<typeof createBillingWebhook>
const polar = new PolarStandIn()
const secret = webhookSecret()

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
  polar.reply = ({ path }) =>
    path.startsWith('/v1/subscriptions/')
      ? { status: 200, body: subscription(path.slice('/v1/subscriptions/'.length)) }
      : { status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } }
})

const deliver = (owner: UserActor, data: unknown) => {
  polar.states.set(owner.userId, data)
  const delivery = signed(stateChanged(data), secret)
  return webhook.request('/api/billing/webhook', {
    method: 'POST',
    body: delivery.body,
    headers: { 'content-type': 'application/json', ...delivery.headers },
  })
}
const holding = (owner: UserActor, id: string, patch: Record<string, unknown> = {}) =>
  deliver(owner, customerState(owner.userId, {}, { id, ...patch }))
const revoked = (owner: UserActor) =>
  deliver(owner, customerState(owner.userId, { active_subscriptions: [] }))
/** The account's billing audit trail, oldest first, as `action by actor (source)`. */
const trail = async (owner: UserActor) => {
  const rows = await h.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectType, 'account'), eq(schema.auditLog.subjectId, owner.userId)))
    .orderBy(asc(schema.auditLog.at))
  return rows.map((row) => ({ ...row, data: row.data as Record<string, unknown> }))
}
const said = async (owner: UserActor) =>
  (await trail(owner)).map((row) => `${row.action} by ${row.actor} (${row.data.source})`)
const periodEnd = (owner: UserActor, at: Date) =>
  h.db
    .update(schema.billingSubscriptions)
    .set({ currentPeriodEnd: at })
    .where(eq(schema.billingSubscriptions.userId, owner.userId))

describe.skipIf(!hasDatabase)('billing audit: a subscription’s life', () => {
  test('subscribe, cancel, cancel undone, cancel again, lapse and revoke each leave a record', async () => {
    const owner = await h.user()
    const id = randomUUID()
    await holding(owner, id)
    await holding(owner, id, { cancel_at_period_end: true })
    await holding(owner, id)
    // Delivered again, nothing changed: nothing more is recorded.
    await holding(owner, id)
    await holding(owner, id, { cancel_at_period_end: true })
    expect(await said(owner)).toEqual([
      'billing.subscribed by system:billing (webhook)',
      'account.plan_changed by system:billing (webhook)',
      'billing.cancel_scheduled by system:billing (webhook)',
      'billing.cancel_undone by system:billing (webhook)',
      'billing.cancel_scheduled by system:billing (webhook)',
    ])
    const scheduled = (await trail(owner)).filter((row) => row.action === 'billing.cancel_scheduled')
    expect(scheduled[0]?.data).toMatchObject({
      subscription: id,
      plan: 'plus',
      endsAt: '2099-10-01T00:00:00.000Z',
    })

    // The period ends and nothing comes from Polar: past its grace the plan is Free by the clock,
    // and the sweep records it, once, with the plan change.
    const ended = new Date(Date.now() - RENEWAL_GRACE_MS - 60_000)
    await periodEnd(owner, ended)
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('free')
    expect(await h.app.billing.recordLapses()).toBeGreaterThanOrEqual(1)
    await h.app.billing.recordLapses()
    const lapse = (await trail(owner)).slice(5)
    expect(lapse.map((row) => `${row.action} by ${row.actor} (${row.data.source})`)).toEqual([
      'billing.subscription_lapsed by system:billing (scheduled)',
      'account.plan_changed by system:billing (scheduled)',
    ])
    expect(lapse[0]?.data).toMatchObject({
      subscription: id,
      plan: 'plus',
      cancelAtPeriodEnd: true,
      lapsedAt: new Date(ended.getTime() + RENEWAL_GRACE_MS).toISOString(),
    })
    expect(lapse[1]?.data).toMatchObject({ from: 'plus', to: 'free' })

    // Polar revokes it: the subscription ends, and the plan, already Free, doesn't change again.
    await revoked(owner)
    expect((await said(owner)).slice(7)).toEqual(['billing.subscription_ended by system:billing (webhook)'])
  })

  test('revoked while it still pays drops to Free at once, and says so', async () => {
    const owner = await h.user()
    const id = randomUUID()
    await holding(owner, id)
    await revoked(owner)
    const rows = await trail(owner)
    expect(rows.map((row) => row.action)).toEqual([
      'billing.subscribed',
      'account.plan_changed',
      'billing.subscription_ended',
      'account.plan_changed',
    ])
    expect(rows[3]?.data).toMatchObject({ from: 'plus', to: 'free', source: 'webhook' })
    // Nothing is left to lapse.
    await h.app.billing.recordLapses()
    expect(await trail(owner)).toHaveLength(4)
  })
})

describe.skipIf(!hasDatabase)('billing audit: failed renewals and the person asking', () => {
  test('a renewal that fails, then runs past its grace, is recorded each step', async () => {
    const owner = await h.user()
    const id = randomUUID()
    await holding(owner, id)
    const failedAt = new Date(Date.now() - PAST_DUE_GRACE_MS - 60_000)
    polar.reply = ({ path }) =>
      path === `/v1/subscriptions/${id}`
        ? {
            status: 200,
            body: subscription(id, {
              status: 'past_due',
              past_due_at: failedAt.toISOString(),
              canceled_at: null,
              ended_at: null,
            }),
          }
        : { status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } }
    // The failure arrives late, its grace already gone: the failure, then the lapse, both kept.
    await revoked(owner)
    expect(await said(owner)).toEqual([
      'billing.subscribed by system:billing (webhook)',
      'account.plan_changed by system:billing (webhook)',
      'billing.renewal_failed by system:billing (webhook)',
      'account.plan_changed by system:billing (webhook)',
    ])
    // The plan changed then because the failure was already past its grace; the sweep finds the
    // lapse itself and records it once, with no second plan change.
    await h.app.billing.recordLapses()
    await h.app.billing.recordLapses()
    expect((await said(owner)).slice(4)).toEqual([
      'billing.subscription_lapsed by system:billing (scheduled)',
    ])
  })

  test('the person asking for their standing is the one recorded', async () => {
    const owner = await h.user()
    polar.states.set(owner.userId, customerState(owner.userId, {}, { id: randomUUID() }))
    await h.app.billing.refresh(owner)
    expect(await said(owner)).toEqual([
      `billing.subscribed by user:${owner.userId} (user)`,
      `account.plan_changed by user:${owner.userId} (user)`,
    ])
  })
})
