// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Extra-play warnings follow recorded usage and paid status, and are kept only after delivery. */
import { afterAll, describe, expect, test } from 'bun:test'
import { HOUR_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsOf, planName } from '../../domain/account/entitlements.ts'
import { UNIT_CENTS, unitsFor } from '../../domain/account/meter.ts'
import { DEFAULT_TIME_ZONE, monthOf } from '../../domain/account/play-day.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { order, subscription } from '../../testing/polar.ts'
import { meteredMonth } from '../billing/chip-in-meter.ts'
import { extraWarning } from '../emails/play.ts'
import { installTuning, tuning } from '../tuning.ts'
import { renewedCeiling, warnAboutExtra } from './extra-play.ts'
import { loadStanding } from './persistence.ts'

let harness: ReturnType<typeof startHarness> | undefined
const original = tuning()
const origin = 'http://localhost:3000'
afterAll(async () => {
  try {
    await harness?.then(
      (h) => h.close(),
      () => undefined,
    )
  } finally {
    installTuning(original)
  }
})
async function control(): Promise<Harness> {
  harness ??= startHarness()
  const h = await harness
  installTuning({
    ...original,
    abuse: { ...original.abuse, extraCeiling: { untilRenewed: 20, renewed: 30 } },
  })
  return h
}

/** A paid monthly account and closed intervals in a controlled future month, without setup usage. */
async function fixture() {
  const h = await control()
  const owner = await h.user('Warning', 'plus')
  const made = await h.create(owner)
  await h.until(made.id, 'running', 3 * SECOND_MS)
  await h.settled(made.id, 3 * SECOND_MS)
  await h.app.servers.stop(owner, made.id, crypto.randomUUID())
  await h.until(made.id, 'stopped', 3 * SECOND_MS)
  await h.settled(made.id, 3 * SECOND_MS)
  await h.db.delete(schema.powerIntervals).where(eq(schema.powerIntervals.serverId, made.id))
  const today = new Date()
  const now = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 25))
  const provider = 'warning-fixture'
  const sub = subscription(crypto.randomUUID(), { status: 'active', canceled_at: null, ended_at: null })
  await h.db.insert(schema.billingSubscriptions).values({
    userId: owner.userId,
    provider,
    externalCustomerId: sub.customer_id,
    externalSubscriptionId: sub.id,
    planKey: 'plus',
    status: sub.status,
    currentPeriodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  })
  const paid = order(owner.userId)
  await h.db.insert(schema.billingOrders).values({
    userId: owner.userId,
    provider,
    externalOrderId: crypto.randomUUID(),
    planKey: 'plus',
    billingReason: paid.billing_reason,
    currency: paid.currency,
    subtotalCents: paid.subtotal_amount,
    discountCents: paid.discount_amount,
    netCents: paid.net_amount,
    taxCents: paid.tax_amount,
    totalCents: paid.total_amount,
    status: paid.status,
    orderedAt: new Date(paid.created_at),
  })
  await h.db
    .update(schema.accountStanding)
    .set({ extraUnitsAllowed: 20, timeZone: DEFAULT_TIME_ZONE })
    .where(eq(schema.accountStanding.userId, owner.userId))
  const standing = await loadStanding(h.db, owner.userId, now)
  const month = await meteredMonth(h.db, standing, entitlementsOf(standing), now)
  if (!month) throw new Error('The fixture must have a monthly allowance')
  const included = month.included + month.carried
  const [user] = await h.db.select().from(schema.users).where(eq(schema.users.id, owner.userId))
  if (!user?.email) throw new Error('The fixture needs a delivery address')
  let cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2))
  return {
    h,
    owner,
    now,
    standing,
    included,
    email: user.email,
    send: { db: h.db, mailer: h.mail, origin },
    async record(units: number) {
      const until = new Date(cursor.getTime() + (units / unitsFor(made.memoryTier, 1)) * HOUR_MS)
      await h.db
        .insert(schema.powerIntervals)
        .values({ serverId: made.id, memoryTier: made.memoryTier, startedAt: cursor, stoppedAt: until })
      cursor = until
    },
  }
}

function message(f: Awaited<ReturnType<typeof fixture>>, mark: 0 | 80 | 100, used: number) {
  return {
    to: f.email,
    ...extraWarning({
      mark,
      included: f.included,
      allowed: 20,
      ceiling: 20,
      used,
      unitCents: UNIT_CENTS,
      plan: planName('plus'),
      origin,
    }),
  }
}

describe.skipIf(!hasDatabase)('warnings from recorded extra play', () => {
  test(
    'sends each reached boundary once, clips the final amount and starts anew for another month',
    async () => {
      const f = await fixture()
      await f.record(f.included)
      expect(await warnAboutExtra(f.send, f.owner.userId, f.now)).toBeNull()
      await f.record(1)
      expect(
        await warnAboutExtra(
          f.send,
          f.owner.userId,
          f.now,
          await loadStanding(f.h.db, f.owner.userId, f.now),
        ),
      ).toBe(0)
      expect(f.h.mail.sent.at(-1)).toEqual(message(f, 0, 1))
      const count = f.h.mail.sent.length
      expect(await warnAboutExtra(f.send, f.owner.userId, f.now)).toBeNull()
      expect(f.h.mail.sent).toHaveLength(count)
      await f.record(15)
      expect(await warnAboutExtra(f.send, f.owner.userId, f.now)).toBe(80)
      expect(f.h.mail.sent.at(-1)).toEqual(message(f, 80, 16))
      await f.record(9)
      expect(await warnAboutExtra(f.send, f.owner.userId, f.now)).toBe(100)
      expect(f.h.mail.sent.at(-1)).toEqual(message(f, 100, 20))
      const month = monthOf(f.now, DEFAULT_TIME_ZONE).slice(0, 7)
      expect((await loadStanding(f.h.db, f.owner.userId, f.now)).extraWarned).toBe(`${month}:100`)
      expect(await warnAboutExtra(f.send, f.owner.userId, f.now)).toBeNull()
      await f.h.db
        .update(schema.accountStanding)
        .set({ extraWarned: 'previous-month:100' })
        .where(eq(schema.accountStanding.userId, f.owner.userId))
      expect(await warnAboutExtra(f.send, f.owner.userId, f.now)).toBe(100)
      expect(renewedCeiling(f.standing)).toBe(30)
    },
    30 * SECOND_MS,
  )

  test(
    'a failed delivery is not marked sent, and the next delivery rounds fractional play',
    async () => {
      const f = await fixture()
      await f.record(f.included + 1.26)
      const failure = new Error('Fixture mail delivery failed')
      await expect(
        warnAboutExtra(
          {
            ...f.send,
            mailer: {
              async send() {
                throw failure
              },
            },
          },
          f.owner.userId,
          f.now,
        ),
      ).rejects.toBe(failure)
      expect((await loadStanding(f.h.db, f.owner.userId, f.now)).extraWarned).toBeNull()
      expect(await warnAboutExtra(f.send, f.owner.userId, f.now)).toBe(0)
      expect(f.h.mail.sent.at(-1)).toEqual(message(f, 0, 1.3))
    },
    30 * SECOND_MS,
  )

  test(
    'an account without permission or an allowance sends nothing even after usage',
    async () => {
      const f = await fixture()
      const free = await f.h.user()
      expect(await warnAboutExtra(f.send, free.userId, f.now)).toBeNull()
      await f.record(f.included + 1)
      await f.h.db
        .update(schema.accountStanding)
        .set({ extraUnitsAllowed: 0 })
        .where(eq(schema.accountStanding.userId, f.owner.userId))
      expect(await warnAboutExtra(f.send, f.owner.userId, f.now)).toBeNull()
      expect(f.h.mail.to(f.email)).toHaveLength(0)
    },
    30 * SECOND_MS,
  )
})
