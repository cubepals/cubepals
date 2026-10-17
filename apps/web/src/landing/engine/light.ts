// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * How the chunk is lit and printed at a moment: where the key light comes from (the moon by night,
 * the sun by day), how strong it and the sky's fill are, and the tone curve the print goes through,
 * by how far the day has come and whether the camera is out on the grass or in a room. The film
 * (Chunk.tsx) and the phone's pictures (phone/printer.ts) both read it, so they print alike. Not
 * the drawing itself (gl.ts).
 */
import type { Vec3 } from './camera'

export const unit = (v: Vec3): [number, number, number] => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

/** The moon stands high to the front left of the house as the camera mostly sees it. */
const MOON: Vec3 = unit([0.42, 0.82, 0.4])

/** The sun climbs from low over the right wall; shadows fall toward the viewer's left. */
export function sunAt(day: number): [number, number, number] {
  return unit([0.62, 0.26 + day * 0.9, -0.5])
}

/**
 * Where the key light comes from as the day turns, `day` 0 (night) to 1: the moon swings over
 * into the sun, so the shadows move with it rather than jumping.
 */
export function keyAt(day: number): [number, number, number] {
  const sun = sunAt(day)
  return unit([
    MOON[0] + (sun[0] - MOON[0]) * day,
    MOON[1] + (sun[1] - MOON[1]) * day,
    MOON[2] + (sun[2] - MOON[2]) * day,
  ])
}

/** One look: how strong the key and the fill are, and the tone curve. */
interface Look {
  keyLight: number
  fill: number
  exposure: number
  contrast: number
}

/**
 * The three looks the film is printed in. The tone curve is the art direction: each is tuned by
 * eye so that everything in the chunk (the house, the trees, the sheep, people, the lamps) reads
 * at a glance, by moonlight as by day.
 */
const NIGHT: Look = { keyLight: 0.8, fill: 0.55, exposure: 1.3, contrast: 1.5 }
const DAY: Look = { keyLight: 1, fill: 0.85, exposure: 0.9, contrast: 1.4 }
const ROOM: Look = { keyLight: 1, fill: 0.85, exposure: 3.1, contrast: 1.15 }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * The look at a moment: `light` is how far the day has come, 0 to 1; `under` how far the camera is
 * into a room, 0 to 1; `bright` scales the exposure, for a beat that asks for more or less.
 */
export function lookAt(light: number, under: number, bright = 1): Look {
  const out = (key: keyof Look) => lerp(NIGHT[key], DAY[key], light)
  const pick = (key: keyof Look) => lerp(out(key), ROOM[key], under)
  return {
    keyLight: pick('keyLight'),
    fill: pick('fill'),
    exposure: pick('exposure') * bright,
    contrast: pick('contrast'),
  }
}
