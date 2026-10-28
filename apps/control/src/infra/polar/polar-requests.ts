// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a request to Polar fails, for PolarBilling: Polar out of reach as BillingUnavailable, and a
 * refusal in Polar's own words; and the few requests and choices too small for a file of their own.
 */
import { PolarClientError, PolarError, PolarRateLimitError } from '@polar-sh/sdk'
import type { createPolar, models } from '@polar-sh/sdk/2026-10'
import { type BillingState, BillingUnavailable } from '../../app/ports/optional.ts'

/**
 * What Polar said was wrong with a request: its first problem's message, or its own summary. A
 * 422 lists its problems (`HTTPValidationError`); a 400, which the SDK doesn't map, says one.
 */
export function refusal(error: PolarClientError): string {
  const body = error.error as models.HTTPValidationError | Partial<models.BadRequest> | null
  const detail = body?.detail
  if (typeof detail === 'string') return detail
  return detail?.find((problem) => problem.msg)?.msg ?? error.message
}

/**
 * Polar's outage, rate limit or an unreachable network is billing being unavailable. So is Polar
 * refusing Blockly's own token (revoked, or short a scope): it waits for a person to fix it, and
 * nothing asked meanwhile is at fault for it.
 */
export async function call<T>(what: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    const unavailable =
      error instanceof PolarRateLimitError ||
      (error instanceof PolarClientError && (error.statusCode === 401 || error.statusCode === 403)) ||
      (error instanceof PolarError && !(error instanceof PolarClientError))
    if (unavailable) throw new BillingUnavailable(`${what}: ${(error as Error).message}`)
    throw error
  }
}

/** A subscription as a customer's state lists it, as far as which pays for what goes. */
interface Listed {
  id: string
  product_id: string
  cancel_at_period_end: boolean
  created_at?: string | null
}

/**
 * Of an account's subscriptions that pay at once (Core, then Plus bought over it), the one for the
 * largest plan, and of two for it the one that renews (one set to end, then bought again), then the
 * one made first (`paid`); and every other for a plan, as `BillingState.others`. `plans` maps each
 * plan's product to its plan, the smallest first.
 */
export function paying<T extends Listed>(
  subscriptions: readonly T[],
  plans: ReadonlyMap<string, string>,
): { paid: T | undefined; others: NonNullable<BillingState['others']> } {
  const products = [...plans.keys()]
  const rank = (subscription: T) => products.indexOf(subscription.product_id)
  const made = (subscription: T) => (subscription.created_at ? Date.parse(subscription.created_at) : 0)
  const paid = subscriptions
    .filter((each) => rank(each) >= 0)
    .sort(
      (a, b) =>
        rank(b) - rank(a) ||
        Number(a.cancel_at_period_end) - Number(b.cancel_at_period_end) ||
        made(a) - made(b),
    )[0]
  const others = subscriptions.flatMap((each) => {
    const planKey = plans.get(each.product_id)
    if (planKey === undefined || each === paid) return []
    return [
      {
        externalSubscriptionId: each.id,
        planKey,
        cancelAtPeriodEnd: each.cancel_at_period_end,
        ...(each.created_at ? { createdAt: new Date(each.created_at) } : {}),
      },
    ]
  })
  return { paid, others }
}

/**
 * A subscription changed to another plan's product when the period paid for ends
 * (`proration_behavior: next_period`): it keeps its own until then, and Polar holds the change as
 * the subscription's pending update, whose `applies_at` says when. No plan's product, no change.
 */
export async function moveSubscription(
  polar: ReturnType<typeof createPolar>,
  product: string | undefined,
  id: string,
): Promise<{ appliesAt: Date }> {
  if (product === undefined) throw new Error('No Polar product sells that plan')
  const held = await call('moving a subscription to another plan', () =>
    polar.subscriptions.update(id, { product_id: product, proration_behavior: 'next_period' }),
  )
  const at = held.pending_update?.applies_at ?? held.current_period_end
  if (!at) throw new Error('Polar took the move but says no day it applies')
  return { appliesAt: new Date(at) }
}

/**
 * A subscription made another plan's product at once (`proration_behavior: invoice`): Polar
 * invoices the difference for the rest of the period and keeps the one subscription, with the new
 * product's prices alone. Polar refuses a product change to one set to end with its period, so
 * that is undone first.
 */
export async function upgradeSubscription(
  polar: ReturnType<typeof createPolar>,
  product: string | undefined,
  id: string,
): Promise<void> {
  if (product === undefined) throw new Error('No Polar product sells that plan')
  const held = await call('reading a subscription', () => polar.subscriptions.get(id))
  if (held.cancel_at_period_end)
    await call('making a subscription renew again', () =>
      polar.subscriptions.update(id, { cancel_at_period_end: false }),
    )
  await call('changing a subscription to another plan', () =>
    polar.subscriptions.update(id, { product_id: product, proration_behavior: 'invoice' }),
  )
}
