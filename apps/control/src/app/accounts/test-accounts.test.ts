/**
 * Accounts Cubepals uses to test itself: made by an admin only, confirmed and on the plan picked
 * with no password and no payment, audited, and left out of the business's numbers, the billing
 * provider and analytics.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { RecordedInsight } from '../../testing/insight.ts'
import { FUNNEL, noteOnce } from '../insight/record.ts'
import type { BillingProvider } from '../ports/optional.ts'
import { countFreeAccounts, loadStanding } from './persistence.ts'

/** A billing provider that remembers being asked for a checkout, which a test account never is. */
const asked: string[] = []
/** Whose play was sent to be billed. */
const reported: string[] = []
const billing: BillingProvider = {
  provider: 'test',
  checkoutUrl: async (request) => {
    asked.push(request.userId)
    return 'https://billing.test/checkout'
  },
  portalUrl: async () => 'https://billing.test/portal',
  receive: async () => null,
  stateOf: async () => null,
  pastDueSince: async () => null,
  order: async () => null,
  refund: async () => {},
  reportUsage: async (events) => {
    reported.push(...events.map((event) => event.userId))
  },
  settleUrl: async () => 'https://billing.test/settle',
  discounts: async () => [],
  createDiscount: async () => {
    throw new Error('no discounts here')
  },
  deleteDiscount: async () => null,
}

const posthog = new RecordedInsight()
let h: Harness

// One harness for the file, where there is a database: booting is the slow part.
beforeAll(async () => {
  if (hasDatabase) h = await startHarness({ capabilities: { archives: null, billing, insight: posthog } })
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await h.close()
})

const anAdmin = async () => ({ kind: 'admin' as const, userId: (await h.user('Staff')).userId })
const audited = (userId: string, action: string) =>
  h.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectId, userId), eq(schema.auditLog.action, action)))

describe.skipIf(!hasDatabase)('test accounts', () => {
  test('only an admin makes one or marks one', async () => {
    const person = await h.user()
    await expect(h.app.accounts.createTestAccount(person, 'qa@example.test', 'free')).rejects.toThrow(
      'not found',
    )
    await expect(h.app.accounts.setTestAccount(person, person.userId, true)).rejects.toThrow('not found')
    const users = await h.db.select().from(schema.users).where(eq(schema.users.email, 'qa@example.test'))
    expect(users).toHaveLength(0)
  })

  test('an admin makes one confirmed, with no password, on Plus without paying, and it is audited', async () => {
    const admin = await anAdmin()
    const { userId } = await h.app.accounts.createTestAccount(admin, ' QA+plus@Example.test ', 'plus')
    const [user] = await h.db.select().from(schema.users).where(eq(schema.users.id, userId))
    expect(user).toMatchObject({ email: 'qa+plus@example.test', emailVerified: true })
    const ways = await h.db.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, userId))
    expect(ways).toHaveLength(0)
    const standing = await loadStanding(h.db, userId)
    expect(standing).toMatchObject({ plan: 'plus', testAccount: true, status: 'active' })
    const subscriptions = await h.db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.userId, userId))
    expect(subscriptions).toHaveLength(0)
    expect(await audited(userId, 'account.test_created')).toMatchObject([
      { actor: `admin:${admin.userId}`, data: { email: 'qa+plus@example.test', plan: 'plus' } },
    ])
    const listed = await h.app.accountQueries.get(admin, userId)
    expect(listed.standing.testAccount).toBe(true)

    // One address, one account; and only plans there are.
    await expect(h.app.accounts.createTestAccount(admin, 'qa+plus@example.test', 'free')).rejects.toThrow(
      'has that email already',
    )
    await expect(h.app.accounts.createTestAccount(admin, 'qa+gold@example.test', 'gold')).rejects.toThrow(
      'no gold plan',
    )
    await expect(h.app.accounts.createTestAccount(admin, 'not an address', 'free')).rejects.toThrow('email')
  })

  test('an admin marks an existing account as a test account, and back', async () => {
    const admin = await anAdmin()
    const person = await h.user()
    await h.app.accounts.setTestAccount(admin, person.userId, true)
    expect((await loadStanding(h.db, person.userId)).testAccount).toBe(true)
    await h.app.accounts.setTestAccount(admin, person.userId, false)
    expect((await loadStanding(h.db, person.userId)).testAccount).toBe(false)
    expect(await audited(person.userId, 'account.test_marked')).toMatchObject([
      { actor: `admin:${admin.userId}` },
    ])
    expect(await audited(person.userId, 'account.test_unmarked')).toHaveLength(1)
  })
})

describe.skipIf(!hasDatabase)('what test accounts are left out of', () => {
  test('a test account takes no free place, never reaches the billing provider, and sends nothing to analytics', async () => {
    const admin = await anAdmin()
    const before = await countFreeAccounts(h.db)
    const { userId } = await h.app.accounts.createTestAccount(admin, 'qa+free@example.test', 'free')
    expect(await countFreeAccounts(h.db)).toBe(before)

    const tester = { kind: 'user' as const, userId }
    await expect(h.app.billing.startCheckout(tester, 'plus')).rejects.toThrow('test account')
    await expect(h.app.billing.customerPortal(tester)).rejects.toThrow('test account')
    expect(asked).not.toContain(userId)
    // Play past the included hours, once counted, is never sent to be billed.
    const someone = await h.user()
    const month = `${new Date().toISOString().slice(0, 7)}-01`
    for (const who of [userId, someone.userId])
      await h.db
        .insert(schema.extraPlayReports)
        .values({ externalId: randomUUID(), userId: who, month, milli: 1000, at: new Date() })
    await h.app.billing.usage.send()
    expect(reported).toContain(someone.userId)
    expect(reported).not.toContain(userId)

    const person = await h.user()
    for (const who of [userId, person.userId])
      await noteOnce(h.db, { event: FUNNEL.signedUp, subject: who, userId: who })
    await h.app.insight.drain()
    expect(posthog.named(FUNNEL.signedUp, person.userId)).toHaveLength(1)
    expect(posthog.events.filter((e) => e.distinctId === userId)).toHaveLength(0)
    expect(
      await h.app.insight.feedback(tester, { text: 'Testing', page: '/servers', version: 'test' }),
    ).toEqual({
      sent: false,
    })
    expect(posthog.events.filter((e) => e.distinctId === userId)).toHaveLength(0)
  })

  test('a test account’s servers and orders are left out of the economics report', async () => {
    const admin = await anAdmin()
    // An account that once paid, then became one Cubepals tests with, beside one that pays.
    const tester = await h.user('Tester', 'plus')
    const person = await h.user('Payer', 'plus')
    const tested = await h.create(tester, { name: 'QA world' })
    const played = await h.create(person, { name: 'Real world' })
    for (const id of [tested.id, played.id]) await h.until(id, 'running')
    const now = new Date()
    for (const owner of [tester, person])
      await h.db.insert(schema.billingOrders).values({
        provider: 'polar',
        externalOrderId: randomUUID(),
        userId: owner.userId,
        planKey: 'plus',
        billingReason: 'subscription_cycle',
        currency: 'usd',
        subtotalCents: 1500,
        discountCents: 0,
        netCents: 1500,
        taxCents: 0,
        totalCents: 1500,
        orderedAt: now,
      })
    await h.app.accounts.setTestAccount(admin, tester.userId, true)
    const report = await h.app.economics.report({
      from: new Date(now.getTime() - 86_400_000),
      to: new Date(now.getTime() + 86_400_000),
    })
    const ids = report.servers.map((s) => s.serverId)
    expect(ids).toContain(played.id)
    expect(ids).not.toContain(tested.id)
    // Its order went nowhere either: not to a server, and not left over as revenue no server carries.
    expect(report.unattributedRevenueCents).toBe(0)
  })
})
