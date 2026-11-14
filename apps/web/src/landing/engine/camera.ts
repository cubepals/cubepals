// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The camera that travels the chunk. It is described the way a person would direct it: what to
 * look at, from which way round and how high, how much of the world to fit in the frame, how wide
 * the lens is, and where on the screen to hold the thing it looks at. Everything the renderer and
 * the page need (the matrix, and where a place in the world lands on screen) is worked out from that.
 */
export type Vec3 = readonly [number, number, number]

export interface Pose {
  /** What it looks at: blocks, with height counted from the grass. */
  x: number
  y: number
  z: number
  /** Which way round it stands, in degrees: 0 looks at the +z wall head on, 90 at the +x wall. */
  az: number
  /** How high it stands, in degrees above level. */
  el: number
  /** How many blocks, top to bottom, fit in the frame at the distance of what it looks at. */
  span: number
  /** The lens, in degrees top to bottom. Narrow is flat, like a drawing; wide has depth. */
  fov: number
  /** Where across the screen it holds what it looks at, 0 at the left edge and 1 at the right. */
  side: number
  /** Where down the screen it holds it, 0 at the top and 1 at the bottom. */
  drop: number
  /** How much of the other worlds around this one is there to be seen, 0 to 1. */
  crowd: number
  /** How far onto the dig's dark grounds it is, 0 to 1: the print's look follows it. */
  under: number
  /** How far into a room it is, 0 out on the grass to 1 in one. */
  inside: number
  /** How bright the print is taken, 1 as it is: the tone curve's exposure is scaled by it. */
  bright: number
}

const rad = (degrees: number) => (degrees * Math.PI) / 180

/** A pose made ready to draw with: where the eye is, which way is which, and the matrix. */
export interface Camera {
  eye: Vec3
  forward: Vec3
  right: Vec3
  up: Vec3
  /** World to clip space, column-major. */
  matrix: Float32Array
  /** How far the picture is slid across the screen, in half-screens. */
  shift: readonly [number, number]
  /** How far the eye is from what it looks at. */
  distance: number
  aspect: number
  /** The tangent of half the lens, which turns a place on screen into a direction. */
  reach: number
}

export function cameraOf(pose: Pose, aspect: number, middle: Vec3, radius: number): Camera {
  const az = rad(pose.az)
  const el = rad(pose.el)
  const reach = Math.tan(rad(pose.fov) / 2)
  const distance = pose.span / (2 * reach)
  const back: Vec3 = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]
  const eye: Vec3 = [pose.x + back[0] * distance, pose.y + back[1] * distance, pose.z + back[2] * distance]
  const forward: Vec3 = [-back[0], -back[1], -back[2]]
  const flat = Math.hypot(forward[0], forward[2]) || 1
  const right: Vec3 = [-forward[2] / flat, 0, forward[0] / flat]
  const up: Vec3 = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ]
  // Near and far are set round everything there is to draw, so the depth it has is spent well.
  const away = Math.hypot(eye[0] - middle[0], eye[1] - middle[1], eye[2] - middle[2])
  const near = Math.max(0.25, away - radius)
  const far = away + radius
  const f = 1 / reach
  const a = (far + near) / (near - far)
  const b = (2 * far * near) / (near - far)
  const dot = (v: Vec3) => v[0] * eye[0] + v[1] * eye[1] + v[2] * eye[2]
  // The view (right, up and back as rows, then the eye moved to the middle) times the lens.
  const tx = -dot(right)
  const ty = -dot(up)
  const tz = dot(forward)
  const sx = f / aspect
  const matrix = new Float32Array([
    sx * right[0],
    f * up[0],
    -a * forward[0],
    forward[0],
    sx * right[1],
    f * up[1],
    -a * forward[1],
    forward[1],
    sx * right[2],
    f * up[2],
    -a * forward[2],
    forward[2],
    sx * tx,
    f * ty,
    a * tz + b,
    -tz,
  ])
  return {
    eye,
    forward,
    right,
    up,
    matrix,
    shift: [(pose.side - 0.5) * 2, (0.5 - pose.drop) * 2],
    distance,
    aspect,
    reach,
  }
}

/**
 * Where a place in the world lands on screen, as a fraction of the screen from its top left, or
 * null when it is behind the camera.
 */
export function project(camera: Camera, at: Vec3): [number, number] | null {
  const m = camera.matrix
  const w =
    (m[3] as number) * at[0] + (m[7] as number) * at[1] + (m[11] as number) * at[2] + (m[15] as number)
  if (w <= 0.001) return null
  const x =
    ((m[0] as number) * at[0] + (m[4] as number) * at[1] + (m[8] as number) * at[2] + (m[12] as number)) / w
  const y =
    ((m[1] as number) * at[0] + (m[5] as number) * at[1] + (m[9] as number) * at[2] + (m[13] as number)) / w
  return [(x + camera.shift[0]) * 0.5 + 0.5, 0.5 - (y + camera.shift[1]) * 0.5]
}
