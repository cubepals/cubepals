/**
 * Payments that carry extra play, through the real Polar adapter against a stand-in for Polar's
 * API: when one that didn't go through is owed (only once Polar, asked again, says it is still
 * unpaid), and what an owner pays it with, the balance: what clears it, and what never does.
 *
 * Counting and sending extra play, and the first fail → told → owed → blocked run, are in
 * `extra-usage.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
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

/** An hour on, when an order made now may be owed. */
const anHourOn = () => new Date(Date.now() + 61 * 60_000)

const extraOf = async (owner: UserActor) => (await w.h.app.accountQueries.overview(owner)).usage.extra

/** A server the owner made and stopped. */
const stoppedServer = async (owner: UserActor) => {
  const { h } = w
  const server = await h.create(owner)
  await h.until(server.id, 'running')
  await h.settled(server.id)
  await h.app.servers.stop(owner, server.id, crypto.randomUUID(), 'user')
  await h.until(server.id, 'stopped')
  await h.settled(server.id)
  return server
}

test.skipIf(!hasDatabase)(
  'a cancelled subscription’s final charge is owed only once it failed or was voided, an hour on',
  async () => {
    const { owner, sub } = await w.subscriber('Zia')
    const server = await stoppedServer(owner)
    // Set to end, then ended: its final charge, with the extra on it, is made and waits.
    await w.subscriptionNow(owner, sub, { status: 'canceled' })
    const madeAt = new Date()
    const final = await w.renewalWithExtra(owner, sub, madeAt)
    // Made a moment ago: nothing owed, nothing emailed, the server starts.
    await w.h.app.billing.tellAboutPayments()
    expect(await extraOf(owner)).toMatchObject({ owedCents: 0, settleCents: 0 })
    expect(await w.mailTo(owner)).toEqual([])
    await w.h.app.servers.start(owner, server.id, crypto.randomUUID())
    await w.h.until(server.id, 'running')
    await w.h.settled(server.id)
    // An hour on, still pending and not yet tried: still not owed.
    expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(0)
    // Tried and declined: owed, and the server stops for it.
    w.declined.add(final)
    expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(1)
    expect(await extraOf(owner)).toMatchObject({ owedCents: 1750, settleCents: 1750 })
    expect((await w.h.until(server.id, 'stopped')).lifecycle.stopReason).toBe('unpaid')
    // Another, voided by Polar without a try, is owed too.
    await w.renewalWithExtra(owner, sub, madeAt, { status: 'void' })
    expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(1)
    expect(await extraOf(owner)).toMatchObject({ owedCents: 3500 })
  },
  60_000,
)

test.skipIf(!hasDatabase)(
  'a week-old charge Polar says was paid, its webhook lost, is never owed or emailed',
  async () => {
    const { owner, sub } = await w.subscriber('Ada')
    const weekAgo = new Date(Date.now() - 8 * 24 * 3_600_000)
    // Pending a week while the subscription stays active: the paid webhook never came.
    const renewal = await w.renewalWithExtra(owner, sub, weekAgo)
    w.declined.add(renewal)
    w.orders.set(renewal, { ...w.orders.get(renewal), status: 'paid', paid: true })
    await w.h.app.billing.tellAboutPayments()
    expect(await w.mailTo(owner)).toEqual([])
    expect(await extraOf(owner)).toMatchObject({ owedCents: 0 })
    expect(await w.kept(renewal)).toMatchObject({ status: 'paid', owedAt: null })
    // One Polar says is still unpaid after the week is owed, and emailed once.
    await w.renewalWithExtra(owner, sub, weekAgo)
    await w.h.app.billing.tellAboutPayments()
    await w.h.app.billing.tellAboutPayments()
    expect(await extraOf(owner)).toMatchObject({ owedCents: 1750 })
    expect((await w.mailTo(owner)).map((m) => m.subject)).toEqual([
      'Your Cubepals servers can’t start until a payment is made',
    ])
  },
  60_000,
)

test.skipIf(!hasDatabase)('Polar not answering leaves an order unowed until it does', async () => {
  const { owner, sub } = await w.subscriber('Bo')
  await w.subscriptionNow(owner, sub, { status: 'canceled' })
  await w.renewalWithExtra(owner, sub, new Date(), { status: 'void' })
  w.polar.down = true
  try {
    expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(0)
  } finally {
    w.polar.down = false
  }
  expect(await w.h.app.billing.confirmOwed(anHourOn())).toBe(1)
})
