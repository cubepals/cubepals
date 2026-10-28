// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What people pay for: subscriptions to a plan and the orders that charged them, as the billing
 * provider reported them, and the extra play Blockly reports to the provider to be billed.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from './auth.ts'
import { createdAt, ts, updatedAt } from './columns.ts'
import { planGifts } from './gifts.ts'

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
    /**
     * When it was set to end, or ended, as the provider says it (or when Blockly first heard);
     * null while it renews. Extra play is counted up to here and no further.
     */
    canceledAt: ts('canceled_at'),
    /**
     * A smaller plan it moves to at `movesAt`, the end of the period paid for (Plus to Core): the
     * plan in force stays until then. Null while it stays on its plan.
     */
    movesToPlan: text('moves_to_plan'),
    movesAt: ts('moves_at'),
    /** The provider's product it is on, as last reported; null before that was kept. */
    productId: text('product_id'),
    /**
     * What it was sold with where its product sets terms of its own (an early price): its price
     * a month in US cents, its hours a month in meter units, and the most extra hours it lets an
     * owner allow (null: the plan's). Set from the product when the subscription is first seen on
     * it and never changed after; all null on a plan's own product, which follows the plan table.
     */
    priceCents: integer('price_cents'),
    includedUnits: integer('included_units'),
    mostExtraUnits: integer('most_extra_units'),
    /** When the provider made it; which of an account's subscriptions is its newest. */
    createdAt: createdAt(),
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
    /** The account that paid; null only for a gift a guest bought (`giftId`). */
    userId: text('user_id').references(() => users.id),
    /** The gift it paid for, when the gift was made before its checkout (`plan_gifts.state`). */
    giftId: uuid('gift_id').references(() => planGifts.id),
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
    /** `paid`, or `pending` while a charge hasn't gone through, `refunded`, `void`… as the provider says. */
    status: text('status').notNull().default('paid'),
    /** What of it is extra play, before discounts and tax: the provider's metered line. */
    extraCents: integer('extra_cents').notNull().default(0),
    /** The subscription it charged for; null for one that charged for none. */
    externalSubscriptionId: text('external_subscription_id'),
    /** When the owner was told a charge carrying extra play failed, and when it left them owing. */
    failureToldAt: ts('failure_told_at'),
    owingToldAt: ts('owing_told_at'),
    /**
     * When the account came to owe it: set only after the provider was asked again and said it
     * is still unpaid (`confirmOwed`); null while it isn't owed, and once it is paid.
     */
    owedAt: ts('owed_at'),
    /** The balance order that paid it in its place (`settleUrl`); null while nothing has. */
    settledBy: text('settled_by'),
    /**
     * When Blockly asked the provider to refund it: a balance order that paid what was settled
     * already, an order a balance had settled that was then charged as well, or a charge of a
     * second subscription to time already paid for.
     */
    refundAskedAt: ts('refund_asked_at'),
    /**
     * When the provider last said it doesn't know this order, read again before it is owed. It is
     * read again a day later, not every pass; any word from the provider about it clears this.
     */
    unknownAt: ts('unknown_at'),
    orderedAt: ts('ordered_at').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.externalOrderId] }),
    index('billing_orders_user').on(t.userId),
    index('billing_orders_ordered').on(t.orderedAt),
    check('billing_orders_payer', sql`${t.userId} is not null or ${t.giftId} is not null`),
  ],
)

/**
 * Extra play an account has run up in a month (the owner's, from their midnight on the 1st, under
 * `month`, the date of that 1st), in thousandths of an hour as the meter counts them (a large
 * server two an hour): `accrued` is what Blockly counted while the owner allowed it, never more
 * than they allowed, and `reported` what it has written to the outbox below for the provider. Both
 * only grow. `pendingSince`: when `accrued` first went past `reported`.
 */
export const extraPlayMonths = pgTable(
  'extra_play_months',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    month: date('month', { mode: 'string' }).notNull(),
    accruedMilli: integer('accrued_milli').notNull().default(0),
    reportedMilli: integer('reported_milli').notNull().default(0),
    pendingSince: ts('pending_since'),
    /**
     * The block of hours the month keeps when an admin lowers the account's hours after it played
     * that month, in hours, and the plan it was kept under (`blockPlan`): the lowered hours apply
     * from the next month, so play already covered stays covered. It holds only while that plan is
     * in force; a plan that changes brings its own block at once. Null when nothing was kept.
     */
    blockUnits: integer('block_units'),
    blockPlan: text('block_plan'),
    /** When the month was counted for the last time: it is over, and nothing still runs in it. */
    finalAt: ts('final_at'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.month] })],
)

/**
 * The outbox of extra play for the billing provider: one row per event, written before it is
 * sent, under an id that is the provider's permanent key for it, so a retry never bills twice and
 * a row never sent is sent later. `sentAt` stays null until the provider took it.
 */
export const extraPlayReports = pgTable(
  'extra_play_reports',
  {
    externalId: text('external_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    month: date('month', { mode: 'string' }).notNull(),
    milli: integer('milli').notNull(),
    /** When the hours were counted: the event's time, never ahead of the clock. */
    at: ts('at').notNull(),
    sentAt: ts('sent_at'),
    /** Times the provider refused it; an outage isn't counted. */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Not sent again before this, after a refusal; null to send it on the next pass. */
    nextAttemptAt: ts('next_attempt_at'),
    /** Refused `MAX_REFUSALS` times: no longer sent, and an admin is told (`extra_play_unsent`). */
    failedAt: ts('failed_at'),
  },
  (t) => [
    index('extra_play_reports_unsent').on(t.sentAt),
    index('extra_play_reports_user').on(t.userId, t.month),
  ],
)

/**
 * A plan paid for a year at once, by a one-time order rather than a subscription: nothing renews
 * it, and the account has the plan from `startsAt` to `endsAt`. A year bought while another is
 * still running (or a monthly subscription is still paid for) starts when that one ends. A refund
 * brings `endsAt` back to the whole months left paid for; a full one, to `startsAt`.
 */
export const planYears = pgTable(
  'plan_years',
  {
    provider: text('provider').notNull(),
    /** The order that paid for it. */
    externalOrderId: text('external_order_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    planKey: text('plan_key').notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    /** The fewest days before `endsAt` the owner was told it is ending (14, then 3); null: not yet. */
    remindedDays: integer('reminded_days'),
    /** When its end, by the clock, was put in the audit log; null until it has ended and been. */
    endRecordedAt: ts('end_recorded_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.externalOrderId] }),
    index('plan_years_user').on(t.userId, t.endsAt),
  ],
)
