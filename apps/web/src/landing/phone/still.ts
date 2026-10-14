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
import { AROUND, INK, MIDDLE, NIGHT, PAPER, sunAt, TORCH } from '../Chunk'
import { cameraOf, type Pose, project } from '../engine/camera'
import { Cast } from '../engine/cast'
import { BOTTOM, buildChunk, HOME, LIT, TOP } from '../engine/chunk'
import { type Palette, Renderer } from '../engine/gl'
import { type Box, REACH } from '../engine/models'
import { Mesh, relight, type World } from '../engine/world'

/** Which picture: the server asleep, or awake with everyone in. */
export type Still = 'night' | 'day'

/**
 * Where the camera stands for each: the film's first screen, a little nearer, and its daybreak
 * (film/Film.tsx), both brought down onto the house as the film's band brought them.
 */
const POSES: Record<Still, Pose> = {
  night: { x: 8, y: 6, z: 8, az: 44, el: 20, span: 26, fov: 24, side: 0.5, drop: 0.55, crowd: 0 },
  day: { x: 8.5, y: 5, z: 6.5, az: 50, el: 17, span: 22, fov: 28, side: 0.5, drop: 0.56, crowd: 0 },
}

/** The chimney's top, where a sleeping server's snore comes out (Chunk.tsx). */
const CHIMNEY = [3.5, 10.6, 3.5] as const

/** As many loose parts as a picture can hold: the friends, the sheep and the tower are a few hundred. */
const LOOSE = 4096

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
  /** Which picture the mesh's shadows are cast for, once one has been printed. */
  lit: Still | null
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
  const mesh = new Mesh(world, sunAt(0))
  renderer.setWorld(mesh, world.lights)
  return { world, mesh, renderer, canvas, lit: null }
}

/**
 * Prints one picture `width` by `height` drawn pixels, one to a screen pixel as the film's are.
 * Null where the device has no WebGL 2 here: the picture's ground and stars are then the picture.
 */
export function print(still: Still, width: number, height: number): Printed | null {
  if (made === undefined) made = make()
  if (!made) return null
  const { world, mesh, renderer, canvas } = made
  const night = still === 'night'
  if (made.lit !== still) {
    relight(world, mesh, sunAt(night ? 0 : 1), -1)
    renderer.relight(mesh.data)
    made.lit = still
  }
  renderer.setMoving(cast(night ? 0 : 3))
  renderer.resize(width, height)
  const lens = cameraOf(POSES[still], width / height, MIDDLE, AROUND)
  // By day the face toward the sun takes all of it; by night only what the film gives the dark.
  const light = night ? 0 : 1
  const sky: Palette = { low: INK, high: night ? NIGHT : PAPER, line: INK }
  const groups = new Float32Array(16)
  groups[LIT] = 1
  groups[HOME] = 0
  renderer.draw({
    camera: lens.matrix,
    shift: lens.shift,
    faceLight: [
      0.5 + 0.55 * light,
      0.3 + 0.6 * light,
      0.14 + 0.36 * light,
      0.1 + 0.16 * light,
      0.12 + 0.3 * light,
      0.22 + 0.5 * light,
    ],
    shadow: 0.5,
    levels: 4,
    detail: 1,
    groups,
    bands: [sky, sky, sky, sky],
    edges: [1e6, 1e6, 1e6, 1e6],
    regions: [0, 0, 0, 0, 0],
    warm: TORCH,
    torch: null,
    time: 0,
    viewY: [BOTTOM - 20, TOP + 20],
    pick: null,
    runs: mesh.between(BOTTOM, TOP),
    farRuns: [],
    eye: lens.eye,
    fog: [lens.distance * 0.92, lens.distance * 0.9],
    crowd: 0,
  })
  // Taken in the same task as the drawing, while the canvas still holds it.
  return { bitmap: canvas.transferToImageBitmap(), chimney: night ? project(lens, CHIMNEY) : null }
}

/**
 * Who is on the grass, packed as the renderer takes loose parts (Chunk.tsx packs them the same
 * way): the sheep, and `friends` of them at their places with the tower built, as the film has
 * them when nobody moves.
 */
function cast(friends: number) {
  const positions = new Float32Array(LOOSE * 3)
  const data = new Uint8Array(LOOSE * 8)
  const turns = new Float32Array(LOOSE * 2)
  let count = 0
  const byte = (reach: number) => Math.min(255, Math.round((reach / REACH) * 255))
  const put: Box = (x, y, z, sx, sy, sz, tone, kind, group, inside, round = 0, tipped = 0, solid = 1) => {
    if (count === LOOSE) return
    positions.set([x, y, z], count * 3)
    data.set(
      [
        tone,
        kind,
        group,
        byte(sx),
        byte(sy),
        byte(sz),
        inside,
        Math.max(0, Math.min(255, Math.round(solid * 255))),
      ],
      count * 8,
    )
    turns.set([round, tipped], count * 2)
    count += 1
  }
  new Cast().friendsStep(friends, 0, put, () => {}, HOME, true, true)
  return { positions, data, turns, count }
}
