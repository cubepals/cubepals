// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A stretch of play, said the same way wherever a player meets it: what is left of the free
 * trial's hours on the server page. The control plane works out the numbers; this only words them.
 */

/** "3 h 12 min", "45 min", "2 h": a stretch of play, never less than a minute. */
export function hoursAndMinutes(minutes: number): string {
  const whole = Math.max(1, Math.round(minutes))
  const hours = Math.floor(whole / 60)
  const rest = whole % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}
