// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * How anybody on the chunk gets about. A figure this small is unsettling the moment it hurries,
 * slides or snaps, so there is one way to walk and everyone uses it: turn on the spot to face
 * where you are going, gather pace, hold it, and slow to a stop there. The legs turn with the
 * ground covered, so feet don't skate.
 */

import { clamp } from './curves'

/** A place on the ground: across, and along. */
export type Spot = readonly [number, number]

const TURN = Math.PI * 2

/** How fast someone in no hurry goes, in blocks a second. */
export const STROLL = 1.5
/** How long it takes to get up to pace, or to come to a stop, in seconds. */
export const EASE = 0.45
/** The ground one full turn of the legs covers, in blocks: two steps. */
export const FOOTFALL = 1.5
/** How fast someone turns round, in radians a second, and how quickly that is got up to. */
const SPIN = 6.5
const SPIN_GATHER = 45

/** Someone who walks: where they are, which way they face, how fast they are going just now. */
export interface Body {
  x: number
  z: number
  /** Which way they face, in radians (0 along z, a quarter turn along x), and the way they mean to. */
  heading: number
  want: number
  /** How fast they are turning just now. */
  spin: number
  pace: number
  /** Where in a step the legs are, in radians. It turns with the ground covered. */
  phase: number
  /** Where the arm that does things is, from hanging: it is moved to a pose, never put there. */
  arm: number
}

/** The heading that looks along a direction across the ground. */
export const headingOf = (face: Spot) => Math.atan2(face[0], face[1])
/** An angle as the shortest way round, from half a turn one way to half a turn the other. */
const wrap = (angle: number) => {
  const turned = angle % TURN
  return turned > Math.PI ? turned - TURN : turned < -Math.PI ? turned + TURN : turned
}

export const bodyAt = (spot: Spot, face: Spot): Body => ({
  x: spot[0],
  z: spot[1],
  heading: headingOf(face),
  want: headingOf(face),
  spin: 0,
  pace: 0,
  phase: 0,
  arm: 0,
})

/** Moves a body's arm toward where it is wanted, at an arm's pace. Returns where it now is. */
export function reach(body: Body, want: number, dt: number, rate = 5): number {
  body.arm += clamp(want - body.arm, -dt * rate, dt * rate)
  return body.arm
}

/**
 * Turns a body round toward the way it means to face: it gathers speed, and slows as it comes
 * round. True once it faces near enough that way to set off.
 */
export function turn(body: Body, dt: number): boolean {
  const off = wrap(body.want - body.heading)
  if (Math.abs(off) < 0.004 && Math.abs(body.spin) < 0.4) {
    body.heading = body.want
    body.spin = 0
    return true
  }
  if (dt > 0) {
    const wanted = clamp(off * 9, -SPIN, SPIN)
    body.spin += clamp(wanted - body.spin, -SPIN_GATHER * dt, SPIN_GATHER * dt)
    const step = body.spin * dt
    body.heading += Math.abs(step) > Math.abs(off) ? off : step
  }
  return Math.abs(wrap(body.want - body.heading)) < 0.05
}

/**
 * Walks a body toward a place: it turns to face it first, and then gathers pace, holds it, and
 * slows to a stop as it arrives. True once it is there.
 */
export function walk(body: Body, to: Spot, cruise: number, dt: number, footfall = FOOTFALL): boolean {
  const dx = to[0] - body.x
  const dz = to[1] - body.z
  const far = Math.hypot(dx, dz)
  if (far < 0.001) {
    body.x = to[0]
    body.z = to[1]
    body.pace = 0
    return true
  }
  if (dt <= 0) return false
  body.want = headingOf([dx, dz])
  // Nobody sets off until they are facing where they are going.
  if (!turn(body, dt) && body.pace === 0) return false
  const gather = cruise / EASE
  // As fast as it has gathered, never over its pace, and never faster than it can stop from in
  // the ground that is left: that last is what brings it to rest exactly where it is going.
  body.pace = Math.max(cruise * 0.05, Math.min(body.pace + gather * dt, cruise, Math.sqrt(2 * gather * far)))
  const move = Math.min(far, body.pace * dt)
  body.x += (dx / far) * move
  body.z += (dz / far) * move
  body.phase += (move / footfall) * TURN
  if (far - move < 0.001) {
    body.x = to[0]
    body.z = to[1]
    body.pace = 0
    return true
  }
  return false
}

/** How long a stride to draw: none standing, a full one at pace. */
export const strideOf = (body: Body, cruise: number) => clamp(body.pace / cruise) * 0.85

/**
 * A way from one place to another along the grid: straight if they are on a line, and otherwise
 * round one corner, going `first` along the first axis ('x') or the second ('z').
 */
export function routeTo(from: Spot, to: Spot, first: 'x' | 'z' = 'x'): Spot[] {
  if (Math.abs(from[0] - to[0]) < 0.001 || Math.abs(from[1] - to[1]) < 0.001) return [to]
  return [first === 'x' ? [to[0], from[1]] : [from[0], to[1]], to]
}
