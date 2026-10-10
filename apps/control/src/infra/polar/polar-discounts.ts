// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Discount codes in Polar's terms (SDK 2026-10 `models`, read 2026-10-10): what a new code is sent
 * as, and a discount Polar holds read back as one, or as nothing when it isn't a code for the
 * plans this deployment sells. Requests themselves are PolarBilling's.
 */
import type { models } from '@polar-sh/sdk/2026-10'
import { z } from 'zod'
import type { Discount, NewDiscount } from '../../app/ports/optional.ts'

// The fields of Polar's `Discount` read here. A fixed one carries `amounts` by currency; `amount`
// and `currency` are its older, deprecated form, read only when `amounts` has no dollars.
const PolarDiscount = z.object({
  id: z.string(),
  code: z.string().nullish(),
  type: z.enum(['fixed', 'percentage']),
  duration: z.enum(['once', 'forever', 'repeating']),
  duration_in_months: z.number().int().nullish(),
  basis_points: z.number().int().nullish(),
  amounts: z.record(z.string(), z.number().int()).nullish(),
  amount: z.number().int().nullish(),
  currency: z.string().nullish(),
  max_redemptions: z.number().int().nullish(),
  redemptions_count: z.number().int(),
  ends_at: z.string().nullish(),
  created_at: z.string(),
  products: z.array(z.object({ id: z.string() })).default([]),
})

/**
 * A new code as Polar takes it, limited to `products`. Polar shows the name to the customer when
 * the code applies, so the name is the code they typed. A percentage is in basis points.
 */
export function discountBody(input: NewDiscount, products: readonly string[]): models.DiscountCreate {
  const common = {
    name: input.code,
    code: input.code,
    products: [...products],
    max_redemptions: input.maxRedemptions,
    ends_at: input.endsAt?.toISOString() ?? null,
    ...(input.duration.kind === 'months'
      ? { duration: 'repeating' as const, duration_in_months: input.duration.months }
      : { duration: input.duration.kind }),
  }
  return input.off.kind === 'percent'
    ? { ...common, type: 'percentage', basis_points: Math.round(input.off.percent * 100) }
    : { ...common, type: 'fixed', amounts: { usd: input.off.cents } }
}

/**
 * A discount Polar holds, as a code for these plans: one with a code, limited to one of
 * `products` or to none (which applies to every product). Anything else is not this
 * deployment's to show or delete, and is null.
 */
export function discountOf(data: unknown, products: ReadonlySet<string>): Discount | null {
  const discount = PolarDiscount.parse(data)
  if (!discount.code) return null
  const limited = discount.products.map((product) => product.id)
  if (limited.length > 0 && !limited.some((product) => products.has(product))) return null
  const cents = discount.amounts?.usd ?? (discount.currency === 'usd' ? discount.amount : null) ?? 0
  return {
    id: discount.id,
    code: discount.code,
    off:
      discount.type === 'percentage'
        ? { kind: 'percent', percent: (discount.basis_points ?? 0) / 100 }
        : { kind: 'amount', cents },
    duration:
      discount.duration === 'repeating'
        ? { kind: 'months', months: discount.duration_in_months ?? 1 }
        : { kind: discount.duration },
    maxRedemptions: discount.max_redemptions ?? null,
    redemptions: discount.redemptions_count,
    endsAt: discount.ends_at ? new Date(discount.ends_at) : null,
    createdAt: new Date(discount.created_at),
  }
}
