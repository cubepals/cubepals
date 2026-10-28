// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which paid plans the billing provider has no product for, as the control plane booted with them,
 * for the few places that name the plan to buy and have no capabilities of their own: the in-game
 * warning when the trial ends, the email about it, and the one when a friend came to a server
 * resting for its owner's play. Set once when the control plane is composed.
 * Not for what a plan allows (`entitlements.ts`).
 */
import { planOnSale } from './entitlements.ts'

let unsold: readonly string[] = []

/** The paid plans nothing sells here, as the capabilities say. */
export function installUnsoldPlans(plans: readonly string[]): void {
  unsold = plans
}

/** The cheapest paid plan for sale here; null where none is. */
export const planOnSaleHere = (): string | null => planOnSale(unsold)
