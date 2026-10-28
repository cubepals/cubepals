// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Polar products staging sells, and the payment values its control plane is given. Payments
 * there are Polar's sandbox, and its products are not production's. Not for production's own
 * (`production-values.ts`).
 */

/** Polar's sandbox product that sells Core: $9.99 a month and the Extra play price, tax inclusive. */
const SANDBOX_CORE_PRODUCT = '64a34283-3a76-4110-8db7-034c2ff23207'

/**
 * POLAR_PRODUCTS for staging: what .env gives (the Plus product), with the sandbox's Core product
 * added where it names none, so staging sells every paid plan like production.
 */
export function stagingProducts(): string {
  const given = process.env.POLAR_PRODUCTS ?? ''
  return /(^|,)core:/.test(given) ? given : [`core:${SANDBOX_CORE_PRODUCT}`, given].filter(Boolean).join(',')
}

/**
 * Staging's payments, Polar's sandbox: the token and products from this shell, and the webhook's
 * secret. Room for early checkouts too, where this shell has its values; left out, staging keeps
 * the ones it was given, or has none and the route is off.
 */
export function stagingBilling(webhookSecret: string): Record<string, string> {
  const room = ['EARLY_ROOM_TOKEN', 'EARLY_ROOM_MAX_POINTS'].flatMap((name) => {
    const value = process.env[name]
    return value ? [[name, value] as const] : []
  })
  return {
    POLAR_ACCESS_TOKEN: process.env.POLAR_ACCESS_TOKEN ?? '',
    POLAR_WEBHOOK_SECRET: webhookSecret,
    POLAR_SERVER: 'sandbox',
    POLAR_PRODUCTS: stagingProducts(),
    ...Object.fromEntries(room),
  }
}
