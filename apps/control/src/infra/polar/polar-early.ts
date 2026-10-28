// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Early-price products in Polar's terms (SDK 2026-10 `models`): a monthly product with metadata
 * `terms: early`, the `plan` it sells, its `included_units` and, where its extra play is capped,
 * `most_extra_units`, at one fixed price in dollars, read back as an early product; anything else
 * is not one. They are made in Polar, like the plans', and never changed: other terms are another
 * product, and the ones before it keep speaking for what was sold on them. Requests are
 * PolarBilling's.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import type { EarlyProduct } from '../../app/ports/optional.ts'
import { PricedProduct, ProductPage } from './polar-schemas.ts'

/** The metadata that marks a product as one at an early price, and the products list is filtered on. */
export const EARLY_METADATA = { terms: 'early' } as const

/** A whole number of units at least 0, as metadata holds one: a number, or its digits. */
function units(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && String(value).trim() !== '' ? n : null
}

/**
 * An early product for one of `plans`, or null: one that isn't monthly, names no plan this
 * deployment sells, gives no whole number of hours, has a cap that isn't one, or has no fixed price
 * in dollars sells nothing here. An archived one is read too, for the subscriptions sold on it.
 */
export function earlyOf(data: unknown, plans: ReadonlySet<string>): EarlyProduct | null {
  const parsed = PricedProduct.safeParse(data)
  if (!parsed.success) return null
  const product = parsed.data
  if (!product.is_recurring || product.recurring_interval !== 'month' || !product.created_at) return null
  if (product.metadata.terms !== EARLY_METADATA.terms) return null
  const planKey = product.metadata.plan
  if (typeof planKey !== 'string' || !plans.has(planKey)) return null
  const includedUnits = units(product.metadata.included_units)
  if (includedUnits === null) return null
  const cap = product.metadata.most_extra_units
  const mostExtraUnits = cap === undefined || cap === null ? null : units(cap)
  if (cap !== undefined && cap !== null && mostExtraUnits === null) return null
  const price = product.prices.find(
    (p) => p.amount_type === 'fixed' && !p.is_archived && (p.price_currency ?? 'usd') === 'usd',
  )
  if (price?.price_amount == null) return null
  return {
    id: product.id,
    planKey,
    priceCents: price.price_amount,
    includedUnits,
    mostExtraUnits,
    archived: product.is_archived,
    createdAt: new Date(product.created_at),
  }
}

/** Of `products`, the one that sells `planKey` now: the newest not archived; null when none does. */
export function newestEarly(products: Iterable<EarlyProduct>, planKey: string): EarlyProduct | null {
  let newest: EarlyProduct | null = null
  for (const product of products)
    if (
      product.planKey === planKey &&
      !product.archived &&
      (newest === null || product.createdAt > newest.createdAt)
    )
      newest = product
  return newest
}

/**
 * How long the early products read from Polar are kept before they are read again, so one made
 * there is sold without a restart; one asked for that they don't hold has them read after a minute.
 */
const EARLY_KEPT_MS = 5 * MINUTE_MS

/**
 * Every product with the metadata `terms: early` for a plan sold here (`earlyOf`), archived ones
 * too, read a page at a time by `list` and kept `EARLY_KEPT_MS`.
 */
export class EarlyProducts {
  readonly #list: (page: number) => Promise<unknown>
  readonly #plans: ReadonlySet<string>
  #kept: { products: ReadonlyMap<string, EarlyProduct>; at: number } | null = null

  constructor(list: (page: number) => Promise<unknown>, plans: ReadonlySet<string>) {
    this.#list = list
    this.#plans = plans
  }

  /** The one that sells `planKey` now (`newestEarly`). */
  async newest(planKey: string): Promise<EarlyProduct | null> {
    return newestEarly((await this.#all()).values(), planKey)
  }

  /** The plan a product at an early price sells; null for a product that is none of them. */
  async planOf(productId: string): Promise<string | null> {
    return (await this.#all(productId)).get(productId)?.planKey ?? null
  }

  /** By id, read again past `EARLY_KEPT_MS`, or past a minute when `missing` is one they don't hold. */
  async #all(missing?: string): Promise<ReadonlyMap<string, EarlyProduct>> {
    const kept = this.#kept
    const age = kept === null ? Number.POSITIVE_INFINITY : Date.now() - kept.at
    const stale =
      age >= EARLY_KEPT_MS || (missing !== undefined && !kept?.products.has(missing) && age >= MINUTE_MS)
    if (kept !== null && !stale) return kept.products
    const found = new Map<string, EarlyProduct>()
    for (let page = 1; ; page++) {
      const listed = ProductPage.parse(await this.#list(page))
      for (const item of listed.items) {
        const early = earlyOf(item, this.#plans)
        if (early !== null) found.set(early.id, early)
      }
      if (page >= listed.pagination.max_page) break
    }
    this.#kept = { products: found, at: Date.now() }
    return found
  }
}
