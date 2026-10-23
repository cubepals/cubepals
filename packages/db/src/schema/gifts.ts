// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gifts: time on a paid plan that someone buys for someone else. A gift is delivered as a code
 * emailed to its buyer, who passes it on (`delivery: code`), or, with GIFTS_BY_EMAIL, emailed
 * straight to the person it is for (`delivery: email`), and then its buyer needs no account. Only
 * hashes of codes and links are kept; each goes once, by email.
 */
import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './auth.ts'
import { createdAt, ts } from './columns.ts'

export const planGifts = pgTable(
  'plan_gifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The order that paid for it, as `billing_orders` keeps it: one gift per order. A gift made
     * before its checkout (`state: checkout`) has no order yet; the checkout carries its id.
     */
    provider: text('provider').notNull(),
    externalOrderId: text('external_order_id'),
    /** The account that bought it; null for a guest, who has only `buyerEmail`. */
    buyerId: text('buyer_id').references(() => users.id),
    /** Where its buyer is written to: the address they gave, or the one they paid with. */
    buyerEmail: text('buyer_email'),
    /**
     * Who it is for, by email: the address until the gift starts or is refunded, and its hash
     * (`recipientKey`, of the address as `recipientKeyOf` reads it) for as long as the gift is
     * kept, which is what the gifts one person is sent a day are counted by.
     */
    recipientEmail: text('recipient_email'),
    recipientKey: text('recipient_key'),
    /** The name it is from, and a short note, both plain text, as the buyer wrote them. */
    fromName: text('from_name'),
    note: text('note'),
    /** `code`: a code emailed to the buyer to pass on. `email`: a link emailed to `recipientEmail`. */
    delivery: text('delivery').notNull().default('code'),
    /**
     * `checkout` until it is paid, then `paid`, then `claimed` once an account has it (redeemed,
     * or started from its link), or `refunded`.
     */
    state: text('state').notNull().default('paid'),
    /** The account already at `recipientEmail`, which it starts on at its next visit. */
    attachedTo: text('attached_to').references(() => users.id),
    /** SHA-256 of the link its recipient claims it with, and of the link its buyer manages it with. */
    claimHash: text('claim_hash'),
    manageHash: text('manage_hash'),
    /** When its recipient was reminded of it, once, and when they said it isn't for them. */
    remindedAt: ts('reminded_at'),
    declinedAt: ts('declined_at'),
    /** What it gives: `plan`, time on `planKey` for `months`. Other kinds (credit) come later. */
    kind: text('kind').notNull().default('plan'),
    planKey: text('plan_key'),
    months: integer('months'),
    /** SHA-256 of the code as it is typed, normalised; null until the code is made. */
    codeHash: text('code_hash'),
    /** The code's last four characters, so the buyer can tell their codes apart. */
    codeHint: text('code_hint'),
    /** When the code was last emailed to the buyer; a code not yet emailed is made again. */
    emailedAt: ts('emailed_at'),
    redeemedBy: text('redeemed_by').references(() => users.id),
    redeemedAt: ts('redeemed_at'),
    /** The time it gives the account that redeemed it: from `startsAt` (now, or when what it already had ends) to `endsAt`. */
    startsAt: ts('starts_at'),
    endsAt: ts('ends_at'),
    /** Refunded: an unredeemed code stops working, and redeemed time ends then. */
    voidedAt: ts('voided_at'),
    /** When its end was recorded, with the plan change it made. */
    endRecordedAt: ts('end_recorded_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('plan_gifts_order').on(t.provider, t.externalOrderId),
    uniqueIndex('plan_gifts_code').on(t.codeHash),
    uniqueIndex('plan_gifts_claim').on(t.claimHash),
    uniqueIndex('plan_gifts_manage').on(t.manageHash),
    index('plan_gifts_buyer').on(t.buyerId, t.createdAt),
    index('plan_gifts_buyer_email').on(t.buyerEmail, t.createdAt),
    index('plan_gifts_recipient').on(t.recipientKey, t.createdAt),
    index('plan_gifts_attached_to').on(t.attachedTo),
    index('plan_gifts_redeemed_by').on(t.redeemedBy),
    check('plan_gifts_buyer_known', sql`${t.buyerId} is not null or ${t.buyerEmail} is not null`),
    check('plan_gifts_guest_by_email', sql`${t.buyerId} is not null or ${t.delivery} = 'email'`),
    check('plan_gifts_paid_has_order', sql`${t.state} = 'checkout' or ${t.externalOrderId} is not null`),
    check('plan_gifts_delivery', sql`${t.delivery} in ('code', 'email')`),
    check('plan_gifts_emailed_has_recipient', sql`${t.delivery} = 'code' or ${t.recipientKey} is not null`),
    check('plan_gifts_state', sql`${t.state} in ('checkout', 'paid', 'claimed', 'refunded')`),
  ],
)
