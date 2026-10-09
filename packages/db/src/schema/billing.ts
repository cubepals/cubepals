/**
 * What people pay for: subscriptions to a plan and the orders that charged them, as the billing
 * provider reported them.
 */
import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './auth.ts'
import { ts, updatedAt } from './columns.ts'

export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    provider: text('provider').notNull(),
    externalCustomerId: text('external_customer_id').notNull(),
    externalSubscriptionId: text('external_subscription_id').notNull(),
    planKey: text('plan_key').notNull(),
    status: text('status').notNull(),
    currentPeriodEnd: ts('current_period_end'),
    /** It ends at `currentPeriodEnd` instead of renewing. */
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /**
     * When its renewal failed to charge, while the provider still retries it (status `past_due`);
     * null otherwise. The plan lasts a grace period from then.
     */
    pastDueAt: ts('past_due_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('billing_subscriptions_external').on(t.provider, t.externalSubscriptionId),
    index('billing_subscriptions_user').on(t.userId),
  ],
)

/**
 * What the billing provider was paid, one row per order, as its order webhooks report it: the
 * amounts and fees as charged. A later event about the same order (paid, then refunded) updates
 * its row.
 */
export const billingOrders = pgTable(
  'billing_orders',
  {
    provider: text('provider').notNull(),
    externalOrderId: text('external_order_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /** The plan the order was for; null for a product no plan names. */
    planKey: text('plan_key'),
    /** `purchase`, `subscription_create`, `subscription_cycle`, … as the provider says it. */
    billingReason: text('billing_reason').notNull(),
    currency: text('currency').notNull(),
    subtotalCents: integer('subtotal_cents').notNull(),
    discountCents: integer('discount_cents').notNull(),
    /** After discounts, before tax: what the price earned. */
    netCents: integer('net_cents').notNull(),
    taxCents: integer('tax_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    refundedCents: integer('refunded_cents').notNull().default(0),
    orderedAt: ts('ordered_at').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.externalOrderId] }),
    index('billing_orders_user').on(t.userId),
    index('billing_orders_ordered').on(t.orderedAt),
  ],
)
