import type { MemoryTier } from '../server/size.ts'

/**
 * What play costs, in units (§15.5). A unit is an hour of play, and a large server uses two: an
 * 8 GB machine costs about twice a 4 GB one, and one rule an owner can hold in their head beats
 * a table of weights nobody reads. 3 GB and 4 GB count the same, so the number an owner sees is
 * simply hours, unless they run a large server.
 *
 * Plans include a block of units rather than of hours per size, so an hour is worth the same to
 * an owner whatever size they run it on.
 */
export const METER_UNITS: Record<MemoryTier, number> = {
  // No longer sold; a server still on one is charged as the size that replaced it.
  '2g': 1,
  '3g': 1,
  '4g': 1,
  // 6 GB runs on the 8 GB machine, so it is large too.
  '6g': 2,
  '8g': 2,
}

/** What an hour on a size costs against the included block. */
export const unitsFor = (tier: MemoryTier, hours: number): number => hours * METER_UNITS[tier]

/** Whether an hour on this size uses more than one of the included hours. */
export const isLarge = (tier: MemoryTier): boolean => METER_UNITS[tier] > 1

/** What one unit past the included block costs, in cents: the same as the plan's own hours. */
export const UNIT_CENTS = 25

/** Play past the included block, as money, for everywhere an owner is shown what it would cost. */
export const centsFor = (units: number): number => Math.round(units * UNIT_CENTS)
