// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A pure boundary contract used only by a disposable test-quality enforcement canary. */
export function advance(value: number): number {
  if (value < 0) throw new RangeError('negative')
  if (value >= 10) return 10
  return value + 1
}
