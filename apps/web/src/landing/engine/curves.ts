// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The few curves everything under the grass moves along: held between two ends, eased, part-way
 * from one value to another, and an angle the shortest way round. What a particular piece does
 * with them (a lid's jump, a door's bounce) is the kit's, in server.ts.
 */

export const clamp = (value: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, value))
export const ease = (t: number) => t * t * (3 - 2 * t)
/** In-out cubic: what lines and moves are eased by. */
export const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
