// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Polar products staging sells. Payments there are Polar's sandbox, and its products are not
 * production's. Not for production's own (`production-values.ts`).
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
