// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The phone's pictures of the chunk, printed by the film's own renderer, once each: the house
 * asleep under the night sky, and the same house by day with the friends in. It runs in a worker
 * (still.worker.ts), off the page's own thread: a picture is printed into a canvas nobody sees and
 * handed back as a bitmap, so nothing is left drawing. Not for the film, which draws its chunk
 * itself (Chunk.tsx).
 */
import { AROUND, MIDDLE } from '../Chunk'
import { cameraOf, type Pose, project } from '../engine/camera'
import { Cast } from '../engine/cast'
import { BOTTOM, buildChunk, HOME, LIT, TOP } from '../engine/chunk'
import type { Frame, Palette } from '../engine/frame'
import { Renderer } from '../engine/gl'
import { INK, keyAt, lookAt, NIGHT, PAPER, TORCH } from '../engine/light'
import { Loose } from '../engine/loose'
import { Mesh, type World } from '../engine/world'

/** Which picture: the server asleep, or awake with everyone in. */
export type Still = 'night' | 'day'

/**
 * Where the camera stands for each: the film's first screen, a little nearer, and its daybreak
 * (film/Film.tsx), both brought down onto the house as the film's band brought them.
 */
const POSES: Record<Still, Pose> = {
  night: {
    x: 8,
    y: 6,
    z: 8,
    az: 44,
    el: 20,
    span: 26,
    fov: 24,
    side: 0.5,
    drop: 0.55,
    crowd: 0,
    under: 0,
    inside: 0,
    bright: 1,
  },
  day: {
    x: 8.5,
    y: 5,
    z: 6.5,
    az: 50,
    el: 17,
    span: 22,
    fov: 28,
    side: 0.5,
    drop: 0.56,
    crowd: 0,
    under: 0,
    inside: 0,
    bright: 1,
  },
}

/** The chimney's top, where a sleeping server's snore comes out (Still.tsx). */
const CHIMNEY = [3.5, 8.6, 3.5] as const

/** What a picture is: the bitmap, and where on it the chimney is, in fractions of its width and height. */
export interface Printed {
  bitmap: ImageBitmap
  chimney: readonly [number, number] | null
}

/** The chunk, its mesh and the renderer, made once and kept for as long as the page is open. */
interface Made {
  world: World
  mesh: Mesh
  renderer: Renderer
  canvas: OffscreenCanvas
}
let made: Made | null | undefined

function make(): Made | null {
  const canvas = new OffscreenCanvas(1, 1)
  let renderer: Renderer
  try {
    renderer = new Renderer(canvas)
  } catch {
    return null
  }
  const world = buildChunk()
  const mesh = new Mesh(world, null)
  renderer.setWorld(mesh, world)
  return { world, mesh, renderer, canvas }
}

/**
 * Prints one picture `width` by `height` drawn dots, each `dot` CSS pixels across (three device
 * pixels, the film's dot at its finer screens). Null where the device has no WebGL 2 here: the
 * picture's ground is then the picture.
 */
export function print(still: Still, width: number, height: number, dot: number): Printed | null {
  if (made === undefined) made = make()
  if (!made) return null
  const { mesh, renderer, canvas } = made
  const night = still === 'night'
  const light = night ? 0 : 1
  renderer.setMoving(cast(night ? 0 : 3))
  renderer.resize(width, height)
  const lens = cameraOf(POSES[still], width / height, MIDDLE, AROUND)
  const look = lookAt(light, 0)
  const sky: Palette = { low: INK, high: night ? NIGHT : PAPER, line: INK }
  const groups = new Float32Array(16)
  groups[LIT] = 1
  groups[HOME] = 0
  const frame: Frame = {
    camera: lens.matrix,
    shift: lens.shift,
    // Lit as the film lights its first screen and its daybreak, shadow map and all.
    key: keyAt(light),
    shadows: { middle: [8, 3, 8], radius: 16, runs: mesh.between(-8, TOP) },
    ...look,
    deep: 0,
    windows: 6,
    levels: 0,
    detail: 1,
    groups,
    bands: [sky, sky, sky, sky],
    edges: [1e6, 1e6, 1e6, 1e6],
    regions: [0, 0, 0, 0, 0],
    warm: TORCH,
    // No stars on a phone: the pictures are small, and a dot of sky reads as dirt.
    stars: false,
    star: PAPER,
    unit: dot,
    torch: null,
    time: 0,
    pick: null,
    runs: mesh.between(BOTTOM, TOP),
    farRuns: [],
    eye: lens.eye,
    fog: [lens.distance * 0.92, lens.distance * 0.9],
    crowd: 0,
  }
  // A picture printed once waits for the lit look rather than being printed in the quick one.
  renderer.draw(frame, true)
  // Taken in the same task as the drawing, while the canvas still holds it.
  return { bitmap: canvas.transferToImageBitmap(), chimney: night ? project(lens, CHIMNEY) : null }
}

/**
 * Who is on the grass, packed as the renderer takes loose parts (engine/loose.ts, as the film
 * packs them): the sheep, and `friends` of them at their places with the tower built, as the film has
 * them when nobody moves.
 */
function cast(friends: number): Loose {
  const loose = new Loose()
  new Cast().friendsStep(friends, 0, loose.put, () => {}, HOME, true, true)
  return loose
}
