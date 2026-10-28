// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The fields of Polar's answers and deliveries that PolarBilling reads, each checked on the way in
 * by the SDK's name for it (`Fields`), so a field Polar renames or drops fails the build rather
 * than reading as missing. Shapes only: what is asked of Polar, and what is made of its answers,
 * is PolarBilling's.
 */
import type { models } from '@polar-sh/sdk/2026-10'
import { z } from 'zod'
import type { Fields } from './polar-models.ts'

// validateEvent checks the signature and the event type, not the payload (checked 2026-09-19),
// so the fields read here are checked on the way in, each by the SDK's name for it (`Fields`).
export const CustomerState = z.object({
  id: z.string(),
  external_id: z.string().nullish(),
  active_subscriptions: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['active', 'trialing']),
      product_id: z.string(),
      current_period_end: z.string(),
      cancel_at_period_end: z.boolean(),
      created_at: z.string().nullish(),
      canceled_at: z.string().nullish(),
    } satisfies Fields<models.CustomerStateSubscription>),
  ),
} satisfies Fields<models.CustomerStateIndividual>)

// A subscription event carries the subscription, and its customer the external id.
export const SubscriptionEvent = z.object({
  customer: z.object({ external_id: z.string().nullish() } satisfies Fields<models.SubscriptionCustomer>),
} satisfies Fields<models.Subscription>)

// Products found by their metadata: the one a balance is settled with, the one friends chip in
// with, and each plan's year.
export const Products = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    } satisfies Fields<models.Product>),
  ),
} satisfies Fields<models.ListResourceProduct>)

// A page of products, each read by whoever reads it (`earlyOf`), and `max_page` says when to stop.
export const ProductPage = z.object({
  items: z.array(z.unknown()),
  pagination: z.object({ max_page: z.number().int() } satisfies Fields<models.Pagination>),
} satisfies Fields<models.ListResourceProduct>)

// A product read whole, with its prices: a gift (`giftOf`), or one at an early price (`earlyOf`).
export const PricedProduct = z.object({
  id: z.string(),
  created_at: z.string().nullish(),
  is_recurring: z.boolean(),
  recurring_interval: z.string().nullish(),
  is_archived: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  prices: z.array(
    z.object({
      amount_type: z.string(),
      is_archived: z.boolean().nullish(),
      price_amount: z.number().int().nullish(),
      price_currency: z.string().nullish(),
    } satisfies Fields<models.ProductPrice>),
  ),
} satisfies Fields<models.Product>)

// A page of products read whole, each by whoever reads it (`giftOf`).
export const Listed = z.object({ items: z.array(z.unknown()) } satisfies Fields<models.ListResourceProduct>)

// The prices of a plan's product, to tell the metered line of an order from the plan's own.
export const Product = z.object({
  prices: z.array(
    z.object({ id: z.string(), amount_type: z.string().nullish() } satisfies Fields<models.ProductPrice>),
  ),
} satisfies Fields<models.Product>)

// Checkouts still open, to offer one again rather than make a second.
export const OpenCheckouts = z.object({
  items: z.array(
    z.object({
      url: z.string(),
      amount: z.number().nullish(),
      expires_at: z.string(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
    } satisfies Fields<models.Checkout>),
  ),
} satisfies Fields<models.ListResourceCheckout>)

// A page of discounts: each is read by `discountOf`, and `max_page` says when to stop.
export const DiscountPage = z.object({
  items: z.array(z.unknown()),
  pagination: z.object({ max_page: z.number().int() } satisfies Fields<models.Pagination>),
} satisfies Fields<models.ListResourceDiscount>)

// Payments tried for an order: one that failed says its charge was tried and declined.
export const Payments = z.object({
  items: z.array(z.object({ status: z.string() } satisfies Fields<models.Payment>)),
} satisfies Fields<models.ListResourcePayment>)

// A customer state lists only subscriptions that pay now, `active` or `trialing` (Polar's
// `SubscriptionStatus.active_statuses`, read 2026-09-26); one whose renewal failed is `past_due`
// on the subscription itself while Polar retries the charge.
export const Subscription = z.object({
  status: z.string(),
  current_period_end: z.string().nullish(),
  past_due_at: z.string().nullish(),
} satisfies Fields<models.Subscription>)

// An order's refunds, each with the reason it was given for.
export const Refunds = z.object({
  items: z.array(z.object({ reason: z.string() } satisfies Fields<models.Refund>)),
} satisfies Fields<models.ListResourceRefund>)

// The fields of Polar's `Order` (SDK 2026-10 `models`, read 2026-10-10) that revenue and extra play
// need: every amount is in cents, the customer carries the external id Blockly gave it, and each
// line names the price it charged, which says whether it is the metered one.
export const Order = z.object({
  status: z.string(),
  subscription_id: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  items: z
    .array(
      z.object({
        amount: z.number().int(),
        product_price_id: z.string().nullish(),
      } satisfies Fields<models.OrderItemSchema>),
    )
    .default([]),
  id: z.string(),
  created_at: z.string(),
  modified_at: z.string().nullish(),
  subtotal_amount: z.number().int(),
  discount_amount: z.number().int(),
  net_amount: z.number().int(),
  tax_amount: z.number().int(),
  total_amount: z.number().int(),
  refunded_amount: z.number().int(),
  currency: z.string(),
  billing_reason: z.string(),
  product_id: z.string().nullish(),
  customer: z.object({ external_id: z.string().nullish() } satisfies Fields<models.OrderCustomer>),
} satisfies Fields<models.Order>)
