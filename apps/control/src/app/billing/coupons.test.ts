/**
 * Coupons as admins make, list and delete them: through the billing port (the local adapter's
 * codes, kept in memory), audited, refused to anyone else, and the provider's refusals and
 * outages said in words.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { LocalBilling } from '../../infra/local-billing/local-billing.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { BillingUnavailable } from '../ports/optional.ts'

const COUPON = {
  code: 'FRIENDS20',
  off: { kind: 'percent' as const, percent: 20 },
  duration: { kind: 'months' as const, months: 3 },
  maxRedemptions: 50,
  endsAt: '2099-12-31T23:59:59.000Z',
}

describe.skipIf(!hasDatabase)('coupons', () => {
  let h: Harness
  let billing: LocalBilling
  let admin: { kind: 'admin'; userId: string }

  beforeAll(async () => {
    h = await startHarness({
      capabilities: (db) => {
        billing = new LocalBilling({
          db,
          secret: 'local-only-auth-secret',
          webOrigin: 'http://localhost:3000',
        })
        return { archives: null, billing }
      },
    })
    admin = { kind: 'admin', userId: (await h.user('Alex')).userId }
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  const audited = (action: string) =>
    h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.subjectType, 'coupon')))

  test('an admin makes one, sees it listed with its uses, and deletes it, each audited', async () => {
    const made = await h.app.billing.coupons.create(admin, COUPON)
    expect(made).toMatchObject({ ...COUPON, redemptions: 0 })
    expect(await billing.discounts()).toHaveLength(1)
    expect(await h.app.billing.coupons.list(admin)).toEqual([made])

    const [created] = await audited('billing.coupon_created')
    expect(created).toMatchObject({
      actor: `admin:${admin.userId}`,
      subjectId: made.id,
      data: {
        code: 'FRIENDS20',
        off: COUPON.off,
        duration: COUPON.duration,
        maxRedemptions: 50,
        endsAt: COUPON.endsAt,
        redemptions: 0,
      },
    })

    await h.app.billing.coupons.delete(admin, made.id)
    expect(await h.app.billing.coupons.list(admin)).toEqual([])
    const [deleted] = await audited('billing.coupon_deleted')
    expect(deleted).toMatchObject({ subjectId: made.id, data: { code: 'FRIENDS20' } })
    // Gone already: nothing to delete, and nothing more audited.
    await expect(h.app.billing.coupons.delete(admin, made.id)).rejects.toBeInstanceOf(NotFound)
    expect(await audited('billing.coupon_deleted')).toHaveLength(1)
  })

  test('anyone but an admin is told there is nothing here', async () => {
    const user: Actor = { kind: 'user', userId: admin.userId }
    await expect(h.app.billing.coupons.list(user)).rejects.toBeInstanceOf(NotFound)
    await expect(h.app.billing.coupons.create(user, { ...COUPON, code: 'SNEAKY' })).rejects.toBeInstanceOf(
      NotFound,
    )
    expect(await billing.discounts()).toEqual([])
  })

  test('a past end date, a code taken, and payments down are said in words', async () => {
    await expect(
      h.app.billing.coupons.create(admin, { ...COUPON, code: 'LATE', endsAt: '2020-01-01T00:00:00.000Z' }),
    ).rejects.toThrow('That end date has passed.')

    await h.app.billing.coupons.create(admin, { ...COUPON, code: 'TWICE' })
    const taken = h.app.billing.coupons.create(admin, { ...COUPON, code: 'twice' })
    await expect(taken).rejects.toBeInstanceOf(AppError)
    await expect(taken).rejects.toThrow(
      'Payments wouldn’t take that code: A discount with this code already exists.',
    )

    const discounts = billing.discounts
    billing.discounts = async () => {
      throw new BillingUnavailable('listing discount codes: 503')
    }
    try {
      await expect(h.app.billing.coupons.list(admin)).rejects.toMatchObject({ code: 'billing_unavailable' })
    } finally {
      billing.discounts = discounts
    }
  })
})
