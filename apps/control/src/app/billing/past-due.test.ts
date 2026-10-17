// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A renewal whose charge failed: Plus lasts 7 days (`PAST_DUE_GRACE_MS`) while Polar retries the
 * card. When the 7 days run out with the renewal still unpaid, the account moves to Free and Blockly
 * ends the subscription in Polar, so a later retry never charges for the days on Free. The owner is
 * told the card won't be charged again, the account page says so, and the audit log keeps it. A
 * renewal paid since is left as Polar says it is.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { DAY_MS } from '@blockly/contracts/durations'
import { hasDatabase } from '../../testing/harness.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import type { UserActor } from '../actor.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

/** Whether Blockly asked Polar to end the subscription since `asked` requests. */
const endedInPolar = (sub: string, asked: number) =>
  w.polar.requests
    .slice(asked)
    .some(
      (r) => r.path.startsWith(`/v1/subscriptions/${sub}`) && (r.method === 'DELETE' || r.method === 'PATCH'),
    )

/** Polar's word that the subscription's renewal failed `days` ago, and is still retried. */
function failed(owner: UserActor, sub: string, days: number) {
  const failedAt = new Date(Date.now() - days * DAY_MS)
  return w.subscriptionNow(owner, sub, {
    status: 'past_due',
    past_due_at: failedAt.toISOString(),
    current_period_start: failedAt.toISOString(),
    current_period_end: new Date(failedAt.getTime() + 30 * DAY_MS).toISOString(),
    ended_at: null,
    canceled_at: null,
  })
}

test.skipIf(!hasDatabase)(
  'an account is never on Free while Polar can still charge it for Plus',
  async () => {
    const { owner, sub } = await w.subscriber('Zed')
    const failedAt = new Date(Date.now() - 8 * DAY_MS)
    const asked = w.polar.requests.length
    // Eight days past due: Polar still retries (day 14 and day 21 to come).
    await w.subscriptionNow(owner, sub, {
      status: 'past_due',
      past_due_at: failedAt.toISOString(),
      current_period_start: failedAt.toISOString(),
      current_period_end: new Date(failedAt.getTime() + 30 * DAY_MS).toISOString(),
      ended_at: null,
      canceled_at: null,
    })
    const plan = (await w.h.app.accountQueries.overview(owner)).plan.key
    const stopped = w.polar.requests
      .slice(asked)
      .some(
        (r) =>
          r.path.startsWith(`/v1/subscriptions/${sub}`) && (r.method === 'DELETE' || r.method === 'PATCH'),
      )
    // Either Plus holds while the charge can still be taken, or the charge is stopped with it.
    expect(plan === 'plus' || stopped).toBe(true)
  },
)

test.skipIf(!hasDatabase)('within its 7 days a failed renewal keeps Plus and its subscription', async () => {
  const { owner, sub } = await w.subscriber('Ada')
  const asked = w.polar.requests.length
  await failed(owner, sub, 3)
  expect(endedInPolar(sub, asked)).toBe(false)
  expect((await w.h.app.accountQueries.overview(owner)).plan.key).toBe('plus')
})

test.skipIf(!hasDatabase)(
  'past its 7 days the owner is told once, the account page says so, and the audit log keeps it',
  async () => {
    const { owner, sub } = await w.subscriber('Bo')
    await failed(owner, sub, 8)
    // Polar's word that it was revoked comes after: nothing is ended or said twice.
    await w.standing(owner, sub, {}, false)
    await w.h.app.billing.sweep()
    expect((await w.mailTo(owner)).map((m) => m.subject)).toEqual(['Your Cubepals Plus has ended'])
    expect((await w.mailTo(owner))[0]?.text).toContain('won’t charge this card for it again')
    const overview = await w.h.app.accountQueries.overview(owner)
    expect(overview.plan).toMatchObject({ key: 'free', billed: { status: 'ended', endedFor: 'unpaid' } })
    expect(await w.audited(owner, 'billing.subscription_revoked')).toEqual([
      { provider: 'polar', subscription: sub, plan: 'plus', why: 'unpaid', source: 'webhook' },
    ])
  },
)

test.skipIf(!hasDatabase)('the sweep ends one whose 7 days ran out with no word from Polar', async () => {
  const { owner, sub } = await w.subscriber('Cy')
  await failed(owner, sub, 6)
  const asked = w.polar.requests.length
  await w.h.app.billing.sweep(new Date(Date.now() + 2 * DAY_MS))
  expect(endedInPolar(sub, asked)).toBe(true)
  expect(await w.audited(owner, 'billing.subscription_revoked')).toMatchObject([
    { why: 'unpaid', source: 'scheduled' },
  ])
})

test.skipIf(!hasDatabase)('a renewal Polar says was paid since is left to run', async () => {
  const { owner, sub } = await w.subscriber('Di')
  await failed(owner, sub, 6)
  // Its retry went through, and the word of it hasn't arrived.
  const held = w.subscriptions.get(sub)
  if (held === undefined) throw new Error('no subscription')
  w.subscriptions.set(sub, { ...held, status: 'active', past_due_at: null })
  const asked = w.polar.requests.length
  await w.h.app.billing.sweep(new Date(Date.now() + 2 * DAY_MS))
  expect(endedInPolar(sub, asked)).toBe(false)
  expect(await w.mailTo(owner)).toEqual([])
})
