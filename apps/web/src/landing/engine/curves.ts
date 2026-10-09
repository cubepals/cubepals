/**
 * The few curves everything under the grass moves along: held between two ends, eased, part-way
 * from one value to another, and an angle the shortest way round. What a particular piece does
 * with them (a lid's jump, a door's bounce) is the kit's, in server.ts.
 */

export const clamp = (value: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, value))
export const ease = (t: number) => t * t * (3 - 2 * t)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** An angle as the shortest way round. */
export const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))
