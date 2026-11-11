// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PublicPlan } from '@blockly/contracts'

/**
 * Another plan's month as the signed-in pages say it, the same the plan cards and the pricing page
 * say: its price and hours as a new subscriber is offered them now (`now`, from `billing.plans`),
 * and the plan table's (`table`, its entitlements) where that isn't read or doesn't say. Not the
 * person's own plan, whose figures are what their subscription was sold with (`asHeld`).
 */
export function offeredMonth(
  table: { monthlyPriceCents: number; includedUnits: number | null },
  now: PublicPlan | undefined,
): { priceCents: number; hours: number | null } {
  return {
    priceCents: now?.monthlyPriceCents ?? table.monthlyPriceCents,
    hours: table.includedUnits === null ? null : (now?.includedHours ?? table.includedUnits),
  }
}
