/**
 * The camera that travels the chunk. It is described the way a person would direct it: what to
 * look at, from which way round and how high, how much of the world to fit in the frame, how wide
 * the lens is, and where on the screen to hold the thing it looks at. Everything the renderer and
 * the page need (the matrix, where a place in the world lands on screen, which block is under the
 * cursor) is worked out from that.
 */
import { Kind, type World } from './world'

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
}

export const POSE_KEYS = ['x', 'y', 'z', 'az', 'el', 'span', 'fov', 'side', 'drop', 'crowd'] as const

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

/**
 * How far down the screen a place lands, as a fraction of the screen from its top, or NaN when it
 * is behind the camera. `project` without the arrays, for what is asked hundreds of times a frame.
 */
export function rowOf(camera: Camera, x: number, y: number, z: number): number {
  const m = camera.matrix
  const w = (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number)
  if (w <= 0.001) return Number.NaN
  const up = ((m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number)) / w
  return 0.5 - (up + camera.shift[1]) * 0.5
}

/** The direction a place on screen looks in (fractions of the screen from its top left). */
export function rayThrough(camera: Camera, sx: number, sy: number): Vec3 {
  const nx = (sx * 2 - 1 - camera.shift[0]) * camera.reach * camera.aspect
  const ny = (1 - sy * 2 - camera.shift[1]) * camera.reach
  const d: Vec3 = [
    camera.forward[0] + camera.right[0] * nx + camera.up[0] * ny,
    camera.forward[1] + camera.right[1] * nx + camera.up[1] * ny,
    camera.forward[2] + camera.right[2] * nx + camera.up[2] * ny,
  ]
  const length = Math.hypot(d[0], d[1], d[2])
  return [d[0] / length, d[1] / length, d[2] / length]
}

export interface Hit {
  cell: [number, number, number]
  /** Which way the face that was hit looks. */
  normal: [number, number, number]
}

/** The first block a ray from the eye meets, walking the grid a cell at a time. */
export function pick(world: World, eye: Vec3, direction: Vec3): Hit | null {
  const lo = [0, world.bottom, 0]
  const hi = [world.size, world.top, world.size]
  // Where the ray enters the world's box, if it does.
  let enter = 0
  let leave = Number.POSITIVE_INFINITY
  let entered = -1
  for (let axis = 0; axis < 3; axis++) {
    const d = direction[axis] as number
    const o = eye[axis] as number
    if (Math.abs(d) < 1e-9) {
      if (o < (lo[axis] as number) || o > (hi[axis] as number)) return null
      continue
    }
    const t0 = ((lo[axis] as number) - o) / d
    const t1 = ((hi[axis] as number) - o) / d
    const first = Math.min(t0, t1)
    if (first > enter) {
      enter = first
      entered = axis
    }
    leave = Math.min(leave, Math.max(t0, t1))
  }
  if (enter > leave) return null
  const start = enter + 1e-4
  const cell: [number, number, number] = [0, 0, 0]
  const step: [number, number, number] = [0, 0, 0]
  const next: [number, number, number] = [0, 0, 0]
  const delta: [number, number, number] = [0, 0, 0]
  for (let axis = 0; axis < 3; axis++) {
    const d = direction[axis] as number
    const p = (eye[axis] as number) + d * start
    cell[axis] = Math.min((hi[axis] as number) - 1, Math.max(lo[axis] as number, Math.floor(p)))
    step[axis] = d > 0 ? 1 : -1
    delta[axis] = Math.abs(d) < 1e-9 ? Number.POSITIVE_INFINITY : Math.abs(1 / d)
    const edge = d > 0 ? (cell[axis] as number) + 1 : (cell[axis] as number)
    next[axis] = Math.abs(d) < 1e-9 ? Number.POSITIVE_INFINITY : start + (edge - p) / d
  }
  let face = entered
  for (let walked = 0; walked < 400; walked++) {
    if (world.get(cell[0], cell[1], cell[2]) !== Kind.air) {
      const normal: [number, number, number] = [0, 0, 0]
      if (face >= 0) normal[face] = -(step[face] as number)
      return { cell, normal }
    }
    face = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2
    cell[face] = (cell[face] as number) + (step[face] as number)
    next[face] = (next[face] as number) + (delta[face] as number)
    if (!world.has(cell[0], cell[1], cell[2])) return null
  }
  return null
}
