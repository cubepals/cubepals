// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Friends chipping in to a server, through the real Polar adapter against a stand-in for Polar's
 * API: the checkout from an invitation and every refusal before it (the caps, the owner, a server
 * that doesn't take them), the order that keeps it, what the owner sees, and the play it covers
 * once the month's hours are used: a start the policy would refuse, and hours never billed as extra.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import type { models } from '../../infra/polar/polar-models.ts'
import { hasDatabase } from '../../testing/harness.ts'
import { failing, orderEvent } from '../../testing/polar.ts'
import { CHIP_IN, PolarWorld } from '../../testing/polar-world.ts'
import type { UserActor } from '../actor.ts'
import { installTuning, tuning } from '../tuning.ts'
import { extraThisMonth } from './extra-usage.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

/** The tuning in force before any test here installs its own. */
const DEFAULTS = tuning()
afterEach(() => installTuning(DEFAULTS))

beforeEach(() => w.reset())

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { message?: string }) => error.message ?? '',
  )

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

/** A chip-in started from the server's invitation, as the page asks for it. */
const chipIn = async (payer: UserActor, code: string, cents: number) => {
  const reached = await w.h.app.sharingQueries.reach({ code }, payer)
  return w.h.app.billing.chipIns.start(payer, reached?.server ?? null, cents, reached?.page ?? '/')
}

/** The 15th of next month, after anything the harness really ran. */
const today = new Date()
const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 15))

/** A run on the stopped server of `hours`, ending a minute before `end`. */
const ran = (serverId: string, hours: number, end: Date) =>
  w.h.db.insert(schema.powerIntervals).values({
    serverId,
    memoryTier: '3g',
    startedAt: new Date(end.getTime() - MINUTE_MS - hours * HOUR_MS),
    stoppedAt: new Date(end.getTime() - MINUTE_MS),
  })

/** The owner starting a server with the policy deciding at `when`: null, or what they are told. */
const startAt = async (owner: UserActor, serverId: string, when: Date) => {
  const policy = w.h.app.policy
  const check = policy.check.bind(policy)
  const pinned = spyOn(policy, 'check').mockImplementation((tx, id, capability, _now, options) =>
    check(tx, id, capability, when, options),
  )
  try {
    return await refusal(w.h.app.servers.start(owner, serverId, crypto.randomUUID()))
  } finally {
    pinned.mockRestore()
  }
}

test.skipIf(!hasDatabase)(
  'a friend chips in from an invitation, at what they chose with tax included, within the caps',
  async () => {
    const { owner } = await w.subscriber('Ana')
    const server = await stoppedServer(owner)
    const friend = await w.h.user('Ben')

    const { url } = await chipIn(friend, server.inviteCode, 500)
    expect(url).toStartWith('https://polar.test/checkout/')
    const [made] = [...w.checkouts.values()].slice(-1)
    expect(made?.asked).toMatchObject({
      products: [CHIP_IN],
      prices: {
        [CHIP_IN]: [
          { amount_type: 'fixed', price_amount: 500, price_currency: 'usd', tax_behavior: 'inclusive' },
        ],
      },
      metadata: { server: server.id },
      allow_discount_codes: false,
      external_customer_id: friend.userId,
    })
    expect(made?.asked.success_url).toEndWith(`/join/${server.inviteCode}?chipped=1`)

    // The owner pays for extra on their own account, not here.
    expect(await refusal(chipIn(owner, server.inviteCode, 500))).toBe(
      'This is your own server. Extra hours for it are on your account.',
    )
    // A payer's day, counted from what they started, paid or not, and a server's from everyone.
    const was = tuning()
    installTuning({ ...was, abuse: { ...was.abuse, chipIn: { payerDayCents: 6000, serverDayCents: 11000 } } })
    try {
      await chipIn(friend, server.inviteCode, 2000)
      await chipIn(friend, server.inviteCode, 2000)
      await chipIn(friend, server.inviteCode, 1000)
      expect(await refusal(chipIn(friend, server.inviteCode, 1000))).toBe(
        'You can chip in up to $60.00 a day. Try again tomorrow.',
      )
      await chipIn(await w.h.user('Cai'), server.inviteCode, 5000)
      expect(await refusal(chipIn(await w.h.user('Dee'), server.inviteCode, 1000))).toBe(
        'Test server has had all the chip-ins it can take today. Try again tomorrow.',
      )
    } finally {
    }

    // The owner turns it off: the page stops offering it, and a chip-in is refused.
    const other = await stoppedServer(owner)
    expect((await w.h.app.sharingQueries.invite(other.inviteCode, friend))?.chipIn).toEqual({
      hoursPerDollar: 4,
    })
    expect((await w.h.app.billing.chipIns.setOpen(owner, other.id, false)).open).toBe(false)
    expect((await w.h.app.sharingQueries.invite(other.inviteCode, friend))?.chipIn).toBeNull()
    expect(await refusal(chipIn(await w.h.user('Eli'), other.inviteCode, 500))).toBe(
      'This server doesn’t take chip-ins right now.',
    )
    // Nor does a server on Free, which has no month of hours to add to.
    const free = await w.h.user('Fay')
    const freeServer = await stoppedServer(free)
    expect(await refusal(chipIn(friend, freeServer.inviteCode, 500))).toBe(
      'This server doesn’t take chip-ins right now.',
    )
  },
)

test.skipIf(!hasDatabase)(
  'chip-ins started at once are each counted against the day’s caps, and so is one Polar didn’t answer',
  async () => {
    const { owner } = await w.subscriber('Kim')
    const server = await stoppedServer(owner)
    const friend = await w.h.user('Lou')
    const was = tuning()
    installTuning({ ...was, abuse: { ...was.abuse, chipIn: { payerDayCents: 6000, serverDayCents: 8000 } } })

    // Polar doesn't answer, so it may have made the checkout: the start stays counted.
    const held = w.polar.reply
    w.polar.reply = (request) =>
      request.method === 'POST' && request.path.startsWith('/v1/checkouts') ? failing() : held(request)
    expect(await refusal(chipIn(friend, server.inviteCode, 2000))).toBe(
      'Payments are not answering right now. Try again in a minute.',
    )
    w.reset()

    const results = await Promise.all(
      Array.from({ length: 6 }, () => refusal(chipIn(friend, server.inviteCode, 2000))),
    )
    expect(results.filter((r) => r === null)).toHaveLength(2)
    expect(
      results.filter((r) => r === 'You can chip in up to $60.00 a day. Try again tomorrow.'),
    ).toHaveLength(4)

    // From everyone at once, the server's own cap holds too.
    const others = await Promise.all(['Max', 'Ned', 'Oli'].map((name) => w.h.user(name)))
    const toServer = await Promise.all(others.map((payer) => refusal(chipIn(payer, server.inviteCode, 1500))))
    expect(toServer.filter((r) => r === null)).toHaveLength(1)
  },
)

test.skipIf(!hasDatabase)(
  'what was chipped in is the server’s, covers its play past the month’s hours, and is never billed',
  async () => {
    // 20 extra allowed, the most until a renewal is paid.
    const was = tuning()
    installTuning({ ...was, abuse: { ...was.abuse, extraCeiling: { untilRenewed: 20, renewed: 50 } } })
    const { owner } = await w.subscriber('Gus')
    expect(await w.h.app.accounts.allowExtraPlay(owner, 20)).toBe(20)
    const server = await stoppedServer(owner)
    const friend = await w.h.user('Hal Jordan')
    const order = await w.chippedIn(friend, server.id, 500)

    const seen = await w.h.app.billing.chipIns.view(owner, server.id)
    expect(seen).toMatchObject({ open: true, offered: true, hoursLeft: 20 })
    // Named as a guestbook names them, never by the whole account name.
    expect(seen.people).toEqual([{ name: 'Hal J.', hours: 20, at: expect.any(String) }])
    // Polar delivering the same order again keeps one chip-in.
    await w.post(orderEvent(w.orders.get(order) as models.Order, 'order.paid'))
    expect((await w.h.app.billing.chipIns.view(owner, server.id)).people).toHaveLength(1)

    // The month's 120 hours and the 20 extra allowed, all played on another server: only the one
    // with hours chipped in left still starts.
    const plain = await stoppedServer(owner)
    await ran(plain.id, 140, at)
    expect(await startAt(owner, plain.id, at)).toBe(
      'You have used the most extra play you can allow this month. It resets on the 1st.',
    )
    expect(await startAt(owner, server.id, at)).toBeNull()
    await w.h.until(server.id, 'running')
    await w.h.settled(server.id)
    await w.h.app.servers.stop(owner, server.id, crypto.randomUUID(), 'user')
    await w.h.until(server.id, 'stopped')
    await w.h.settled(server.id)

    // Five more hours on it are covered, drawn and kept, and none of them is extra.
    const later = new Date(at.getTime() + 6 * HOUR_MS)
    await ran(server.id, 5, later)
    await w.h.app.billing.chipIns.draw(later)
    await w.h.app.billing.usage.count(owner.userId, later)
    expect(await extraThisMonth(w.h.db, { userId: owner.userId, timeZone: null }, later)).toMatchObject({
      countedUnits: 20,
    })
    const left = await w.h.app.billing.chipIns.view(owner, server.id)
    expect(left.hoursLeft).toBeCloseTo(15, 1)

    // Half refunded: half its hours go back, from what was left.
    const held = w.orders.get(order)
    if (held === undefined) throw new Error('Polar holds no such order')
    await w.post(
      orderEvent({ ...held, status: 'partially_refunded', refunded_amount: 250 }, 'order.refunded'),
    )
    const refunded = await w.h.app.billing.chipIns.view(owner, server.id)
    expect(refunded.people).toEqual([{ name: 'Hal J.', hours: 10, at: expect.any(String) }])
    expect(refunded.hoursLeft).toBeCloseTo(5, 1)
  },
)
