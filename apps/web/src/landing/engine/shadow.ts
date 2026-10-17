// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The shadow map's arithmetic: its size, and the matrix that looks down the key light at the part
 * of the world it shades. Not which way the light comes from (light.ts), the drawing of the map,
 * which the renderer does (gl.ts), nor what reads it (scene-pass.ts).
 */
import type { Vec3 } from './camera'
import { unit } from './light'

/** How many texels a side the map has: enough for a block's shadow to have clean steps. */
export const MAP_SIZE = 2048

/**
 * World to the map's clip space, column-major: an orthographic view down the light at a sphere
 * of `radius` round `middle`, so whatever is inside it lands on the map whichever way the light
 * comes from.
 */
export function lightMatrix(key: Vec3, middle: Vec3, radius: number): Float32Array {
  // Looking from the light toward the middle: z is back toward the light, x and y across it.
  const z = unit(key)
  const up: Vec3 = Math.abs(z[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0]
  const x = unit([up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]])
  const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const s = 1 / radius
  // Depth runs from the near side of the sphere (−1) to the far side (+1).
  const sz = -1 / radius
  return new Float32Array([
    x[0] * s,
    y[0] * s,
    z[0] * sz,
    0,
    x[1] * s,
    y[1] * s,
    z[1] * sz,
    0,
    x[2] * s,
    y[2] * s,
    z[2] * sz,
    0,
    -dot(x, middle) * s,
    -dot(y, middle) * s,
    dot(z, middle) * -sz,
    1,
  ])
}
