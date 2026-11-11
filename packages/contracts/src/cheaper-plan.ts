// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Past how many extra hours a month a larger plan costs less than the plan held and those hours:
 * what a month of the larger one charges a new subscriber now, over what the held one's
 * subscription pays, in extra hours at `unitCents` each. Null where the larger one costs no more,
 * so nothing says it. The account page and the email as play runs out both say it from here.
 */
export function extraHoursCheaper(
  largerMonthCents: number,
  heldMonthCents: number,
  unitCents: number,
): number | null {
  if (largerMonthCents <= heldMonthCents || unitCents <= 0) return null
  return Math.floor((largerMonthCents - heldMonthCents) / unitCents)
}
