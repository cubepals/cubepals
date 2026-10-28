// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gift products in Polar's terms (SDK 2026-10 `models`, read 2026-10-12): a one-time product with
 * metadata `purpose: gift`, `plan` and `months`, at one fixed price, read back as a gift; anything
 * else is not one. The products are made in Polar, like the plans', so a new gift (a year of Plus)
 * is a product there and nothing here. A gift made before its checkout is named in the checkout's
 * metadata, which Polar copies to the order, and read back from there with who paid. Requests
 * themselves are PolarBilling's.
 */
import type { createPolar, models } from '@polar-sh/sdk/2026-10'
import { z } from 'zod'
import type { GiftProduct } from '../../app/ports/optional.ts'
import type { Fields } from './polar-models.ts'
import { CHECKOUT_LEFT_MS, call, withEmail } from './polar-requests.ts'
import { Listed, OpenCheckouts } from './polar-schemas.ts'

type Polar = ReturnType<typeof createPolar>

/** The metadata that marks a product as a gift, and the products list is filtered on. */
const GIFT_METADATA = { purpose: 'gift' } as const

/**
 * What a gift checkout names. Its customer: the account paying, or for a guest none of ours, and
 * Polar finds the customer with that email or makes one (seen in the sandbox, 2026-10-23). Its
 * metadata: the gift made before the checkout, by id, which Polar copies to the order; none for a
 * gift its paid order makes (`delivery: code`). A guest's gift is always made first.
 */
export function giftCheckoutOf(input: { userId: string | null; giftId: string | null }): {
  customer: { external_customer_id?: string }
  metadata: { purpose: 'gift'; gift: string } | undefined
} {
  if (input.userId === null && input.giftId === null)
    throw new Error('A guest’s gift is made before its checkout, which names it')
  return {
    customer: input.userId === null ? {} : { external_customer_id: input.userId },
    metadata: input.giftId === null ? undefined : { ...GIFT_METADATA, gift: input.giftId },
  }
}

// The fields of a gift's order read here: the metadata its checkout carried, and who paid.
const PolarGiftOrder = z.object({
  metadata: z.record(z.string(), z.unknown()).nullish(),
  customer: z.object({ email: z.string().nullish() } satisfies Fields<models.OrderCustomer>),
} satisfies Fields<models.Order>)

/**
 * The gift an order for `gift` paid for, when it was made before its checkout (`giftId`), and the
 * email it was paid with. Only a gift product's order is read, and only an id shaped like one of
 * ours: metadata on anything else is not ours. A guest's order carries the external id of
 * whichever account Polar matched the email to, if any, which says nothing about who bought it;
 * `Gifts.payer` reads that from the gift itself.
 */
export function giftOrderOf(
  data: unknown,
  gift: GiftProduct | null,
): { gift: GiftProduct | null; giftId: string | null; payerEmail: string | null } {
  if (gift === null) return { gift, giftId: null, payerEmail: null }
  const order = PolarGiftOrder.parse(data)
  const id = z.uuid().safeParse(order.metadata?.gift)
  return { gift, giftId: id.success ? id.data : null, payerEmail: order.customer.email ?? null }
}

const PolarGift = z.object({
  id: z.string(),
  is_recurring: z.boolean(),
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

/**
 * A gift product for one of `plans`, or null: one that recurs, names no plan this deployment
 * sells, gives no whole number of months, or has no fixed price in dollars sells no gift here.
 */
export function giftOf(data: unknown, plans: ReadonlySet<string>): GiftProduct | null {
  const parsed = PolarGift.safeParse(data)
  if (!parsed.success) return null
  const product = parsed.data
  if (product.is_recurring || product.is_archived) return null
  if (product.metadata.purpose !== GIFT_METADATA.purpose) return null
  const planKey = product.metadata.plan
  const months = Number(product.metadata.months)
  if (typeof planKey !== 'string' || !plans.has(planKey)) return null
  if (!Number.isInteger(months) || months < 1) return null
  const price = product.prices.find(
    (p) => p.amount_type === 'fixed' && !p.is_archived && (p.price_currency ?? 'usd') === 'usd',
  )
  if (price?.price_amount == null) return null
  return { id: product.id, planKey, months, priceCents: price.price_amount }
}

/** Every gift product for a plan this deployment sells, cheapest first, read from Polar now. */
export async function giftProducts(polar: Polar, plans: ReadonlySet<string>): Promise<GiftProduct[]> {
  const found = Listed.parse(
    await call('finding the gift products', () =>
      polar.products.list({ metadata: { ...GIFT_METADATA }, is_archived: false, limit: 100 }),
    ),
  )
  return found.items
    .map((item) => giftOf(item, plans))
    .filter((gift) => gift !== null)
    .sort((a, b) => a.priceCents - b.priceCents)
}

/**
 * A checkout for one gift, with no code: a coupon for the plans is not for gifts of them. What it
 * names is `giftCheckoutOf`'s. One still open for the same buyer and gift is the one to pay.
 */
export async function giftCheckoutUrl(
  polar: Polar,
  input: {
    userId: string | null
    email: string
    gift: GiftProduct
    giftId: string | null
    returnUrl: string
  },
): Promise<string> {
  const { customer, metadata } = giftCheckoutOf(input)
  const open = OpenCheckouts.parse(
    await call('finding an open gift checkout', () =>
      polar.checkouts.list({ product_id: input.gift.id, ...customer, status: 'open', limit: 20 }),
    ),
  ).items.find(
    (checkout) =>
      checkout.metadata?.gift === metadata?.gift &&
      new Date(checkout.expires_at).getTime() > Date.now() + CHECKOUT_LEFT_MS,
  )
  if (open !== undefined) return open.url
  const checkout = await withEmail(input.email, (email) =>
    call('starting a gift checkout', () =>
      polar.checkouts.create({
        products: [input.gift.id],
        allow_discount_codes: false,
        ...customer,
        metadata,
        ...email,
        success_url: input.returnUrl,
        return_url: input.returnUrl,
      }),
    ),
  )
  return checkout.url
}
