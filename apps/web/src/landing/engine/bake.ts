// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The light that doesn't move, worked out once when the chunk is built and kept as a grid with one
 * cell a block: for every cell of air, how much of the sky it sees (so corners, overhangs and the
 * rooms are shut in from it), how much of the placed lamps' light reaches it, traced through the
 * blocks to each lamp from a few points on it so the shadows are soft, and how much of that light
 * comes back off the walls and floor round it, carried on a little way through the air (a bounce).
 * The scene pass reads it just in front of each surface, blended between cells (scene-pass.ts),
 * so a frame costs a texture read and not a trace. Not the key light, which moves with the day and
 * has its shadow map (shadow.ts), nor the lights that move (a carried torch, a server's lamp).
 */
import { Kind, type Light, toneOf, type World } from './world'

/** The grid, four bytes a cell, `x` fastest, then height, then `z`, as a 3D texture takes it. */
export interface Baked {
  data: Uint8Array
  size: number
  height: number
  bottom: number
}

/** A lamp's light is kept halved, so up to twice a lone lamp's fits in a byte (scene-pass.ts reads it so). */
const LAMP_SCALE = 2

/** Ways up into the sky from a cell: four rings, from near the horizon to straight up. */
const SKY: readonly (readonly [number, number, number])[] = (
  [
    [8, 7],
    [30, 6],
    [55, 5],
    [80, 2],
  ] as const
).flatMap(([degrees, count]) => {
  const up = (degrees * Math.PI) / 180
  return Array.from({ length: count }, (_, k) => {
    const around = ((k + degrees / 90) / count) * Math.PI * 2
    return [Math.cos(up) * Math.cos(around), Math.sin(up), Math.cos(up) * Math.sin(around)] as const
  })
})

/** Points on a lamp, a little apart, so a shadow's edge is soft. */
const ON_LAMP: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [0.3, 0.2, 0],
  [-0.3, 0.1, 0.2],
  [0, -0.2, -0.3],
  [0.1, 0.25, 0.3],
]

const SIDES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const

/** How much light gets through a block of each kind: the small and the clear let most of it by. */
function through(kind: number): number {
  if (kind === Kind.air || kind === Kind.torch || kind === Kind.rail || kind === Kind.lamp) return 1
  if (kind === Kind.glass) return 0.85
  if (kind === Kind.water) return 0.7
  if (kind === Kind.leaves) return 0.4
  return 0
}

/** The world's cells as the bake walks them: what each lets through, and where each is kept. */
class Cells {
  readonly world: World
  readonly count: number
  private readonly pass: Float32Array

  constructor(world: World) {
    this.world = world
    this.count = world.size * world.size * world.height
    this.pass = new Float32Array(this.count)
    this.each((x, y, z, i) => {
      this.pass[i] = through(world.get(x, y, z))
    })
  }

  at(x: number, y: number, z: number): number {
    const { size, height, bottom } = this.world
    return x + size * (y - bottom + height * z)
  }

  /** How much light a cell lets through: all of it out past the sides and the top, none below. */
  clear(x: number, y: number, z: number): number {
    const { size, bottom, top } = this.world
    if (x < 0 || z < 0 || x >= size || z >= size || y >= top) return 1
    return y < bottom ? 0 : (this.pass[this.at(x, y, z)] as number)
  }

  /** Every cell, or every one in a box, with its place in the grid. */
  each(visit: (x: number, y: number, z: number, i: number) => void, box?: readonly number[]): void {
    const { size, bottom, top } = this.world
    const [x0, y0, z0, x1, y1, z1] = box ?? [0, bottom, 0, size - 1, top - 1, size - 1]
    for (let z = Math.max(0, z0 as number); z <= Math.min(size - 1, z1 as number); z++)
      for (let y = Math.max(bottom, y0 as number); y <= Math.min(top - 1, y1 as number); y++)
        for (let x = Math.max(0, x0 as number); x <= Math.min(size - 1, x1 as number); x++)
          visit(x, y, z, this.at(x, y, z))
  }

  /** Whether any block is in the cells round this one. */
  nearBlock(x: number, y: number, z: number): boolean {
    for (let n = 0; n < 27; n++) {
      if (n === 13) continue
      if (this.clear(x + (n % 3) - 1, y + (Math.floor(n / 3) % 3) - 1, z + Math.floor(n / 9) - 1) < 1)
        return true
    }
    return false
  }

  /** How much light gets from a point along a line, step by step, until `length` (less `skip`). */
  along(from: readonly number[], way: readonly number[], length: number, skip: number): number {
    let light = 1
    for (let t = 0.4; t < length - skip; t += 0.4) {
      light *= this.clear(
        Math.floor((from[0] as number) + (way[0] as number) * t),
        Math.floor((from[1] as number) + (way[1] as number) * t),
        Math.floor((from[2] as number) + (way[2] as number) * t),
      )
      if (light <= 0.01) return 0
    }
    return light
  }
}

const cache = new WeakMap<World, Baked>()

/** The world's baked light, worked out the first time it is asked for. */
export function baked(world: World): Baked {
  let done = cache.get(world)
  if (!done) {
    done = bake(new Cells(world))
    cache.set(world, done)
  }
  return done
}

function bake(cells: Cells): Baked {
  const sky = skyOf(cells)
  const lamp = lampOf(cells)
  const bounce = bounceOf(cells, lamp)
  const data = new Uint8Array(cells.count * 4)
  const byte = (v: number) => Math.round(Math.min(1, v) * 255)
  for (let i = 0; i < cells.count; i++) {
    data[i * 4] = byte(sky[i] as number)
    data[i * 4 + 1] = byte((lamp[i] as number) / LAMP_SCALE)
    data[i * 4 + 2] = byte((bounce[i] as number) / LAMP_SCALE)
    data[i * 4 + 3] = 255
  }
  const { size, height, bottom } = cells.world
  return { data, size, height, bottom }
}

/**
 * How much of the sky each cell of air sees, 0 to 1. Air over everything with nothing near sees
 * all of it and isn't traced; anything near a block, or under one, is.
 */
function skyOf(cells: Cells): Float32Array {
  const sky = new Float32Array(cells.count)
  const roof = roofsOf(cells)
  const { size, top } = cells.world
  cells.each((x, y, z, i) => {
    if (cells.clear(x, y, z) <= 0) return
    if (y > (roof[x + size * z] as number) && !cells.nearBlock(x, y, z)) {
      sky[i] = 1
      return
    }
    const from = [x + 0.5, y + 0.5, z + 0.5]
    let open = 0
    for (const way of SKY) open += cells.along(from, way, 2 * (top - y) + size, 0)
    sky[i] = open / SKY.length
  })
  return sky
}

/** The height of the highest block over each column, or one under the bottom where there is none. */
function roofsOf(cells: Cells): Int32Array {
  const { size, bottom } = cells.world
  const roof = new Int32Array(size * size).fill(bottom - 1)
  cells.each((x, y, z) => {
    const column = x + size * z
    if (cells.clear(x, y, z) < 1 && y > (roof[column] as number)) roof[column] = y
  })
  return roof
}

/** The placed lamps' light in each cell of air: the same falloff the scene pass uses, shadowed. */
function lampOf(cells: Cells): Float32Array {
  const lamp = new Float32Array(cells.count)
  for (const placed of cells.world.lights) shine(cells, raised(cells, placed), lamp)
  return lamp
}

/** A lamp set into a block (a room's floor lamps are) shines from the air just above it. */
function raised(cells: Cells, placed: Light): Light {
  const light = { ...placed }
  while (
    light.y < cells.world.top - 1 &&
    cells.clear(Math.floor(light.x), Math.floor(light.y), Math.floor(light.z)) <= 0
  )
    light.y += 1
  return light
}

/** One lamp's light added to every cell of air it reaches, by how much of the lamp each sees. */
function shine(cells: Cells, light: Light, lamp: Float32Array): void {
  const r = light.radius
  const box = [light.x - r, light.y - r, light.z - r, light.x + r, light.y + r, light.z + r].map(Math.floor)
  cells.each((x, y, z, i) => {
    if (cells.clear(x, y, z) <= 0) return
    const from = [x + 0.5, y + 0.5, z + 0.5]
    const f = Math.max(0, 1 - Math.hypot(x + 0.5 - light.x, y + 0.5 - light.y, z + 0.5 - light.z) / r)
    if (f <= 0) return
    let seen = 0
    for (const o of ON_LAMP) {
      const to = [
        light.x + o[0] - (from[0] as number),
        light.y + o[1] - (from[1] as number),
        light.z + o[2] - (from[2] as number),
      ]
      const length = Math.hypot(to[0] as number, to[1] as number, to[2] as number)
      seen += cells.along(
        from,
        to.map((v) => v / length),
        length,
        0.6,
      )
    }
    lamp[i] = (lamp[i] as number) + f * f * f * (seen / ON_LAMP.length)
  }, box)
}

/**
 * The lamps' light that comes back off what it falls on: each cell of air hands on the light that
 * reaches the blocks beside it, by how pale they are, and that is carried a few cells on through
 * the air, thinning as it spreads.
 */
function bounceOf(cells: Cells, lamp: Float32Array): Float32Array {
  let back = reflected(cells, lamp)
  for (let round = 0; round < 4; round++) back = spread(cells, back)
  return back.map((v) => v * 2.2)
}

/** The light each cell of air sends back off the blocks beside it. */
function reflected(cells: Cells, lamp: Float32Array): Float32Array {
  const back = new Float32Array(cells.count)
  const { world } = cells
  cells.each((x, y, z, i) => {
    const here = lamp[i] as number
    if (here <= 0 || world.get(x, y, z) !== Kind.air) return
    let pale = 0
    for (const [dx, dy, dz] of SIDES) {
      const kind = world.get(x + dx, y + dy, z + dz)
      if (kind !== Kind.air) pale += toneOf(kind)
    }
    back[i] = (here * pale) / SIDES.length
  })
  return back
}

/** One step of the bounce spreading through the air: each cell takes the mean of itself and the air beside it. */
function spread(cells: Cells, back: Float32Array): Float32Array {
  const next = new Float32Array(cells.count)
  const { world } = cells
  const air = (x: number, y: number, z: number) => world.has(x, y, z) && world.get(x, y, z) === Kind.air
  cells.each((x, y, z, i) => {
    if (!air(x, y, z)) return
    let sum = back[i] as number
    let n = 1
    for (const [dx, dy, dz] of SIDES) {
      if (!air(x + dx, y + dy, z + dz)) continue
      sum += back[cells.at(x + dx, y + dy, z + dz)] as number
      n += 1
    }
    next[i] = sum / n
  })
  return next
}
