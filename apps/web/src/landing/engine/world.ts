// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * A voxel world small enough to hold in a few typed arrays: one Minecraft chunk, 16 blocks square,
 * from above the surface down to bedrock. The landing page draws it as a core sample.
 *
 * World axes: x and z are the footprint, y is height. y = 0 is the grass; the sky is positive, the
 * dig is negative. The camera is free, so any face of a block may be seen.
 */

/** What a block is made of. The renderer turns each into a tone and a pattern. */
export const Kind = {
  air: 0,
  grass: 1,
  dirt: 2,
  stone: 3,
  deepslate: 4,
  bedrock: 5,
  log: 6,
  leaves: 7,
  planks: 8,
  cobble: 9,
  water: 10,
  path: 11,
  glass: 12,
  lamp: 13,
  ore: 14,
  bed: 15,
  chest: 16,
  rail: 17,
  iron: 18,
  wool: 19,
  roof: 20,
  dark: 21,
  torch: 22,
  sand: 23,
} as const
export type Kind = (typeof Kind)[keyof typeof Kind]

/** Tone is how much light a material gives back: 0 prints as solid ink, 1 as bare paper. */
const TONE: Record<number, number> = {
  [Kind.grass]: 0.9,
  [Kind.dirt]: 0.52,
  [Kind.stone]: 0.74,
  [Kind.deepslate]: 0.34,
  [Kind.bedrock]: 0.14,
  [Kind.log]: 0.36,
  [Kind.leaves]: 0.66,
  [Kind.planks]: 1,
  [Kind.cobble]: 0.6,
  [Kind.water]: 0.86,
  [Kind.path]: 0.97,
  [Kind.glass]: 0.3,
  [Kind.lamp]: 0.3,
  [Kind.ore]: 0.6,
  [Kind.bed]: 0.9,
  [Kind.chest]: 0.5,
  [Kind.rail]: 0.42,
  [Kind.iron]: 0.82,
  [Kind.wool]: 0.98,
  [Kind.roof]: 0.55,
  [Kind.dark]: 0.08,
  [Kind.torch]: 0.9,
  [Kind.sand]: 0.94,
}

/** How much light a block of this kind gives back, 0 to 1 (its tone). */
export const toneOf = (kind: number): number => TONE[kind] ?? 0.5

/**
 * A block's four corners on each face, in the order its quad takes them, which is also the order
 * of the face's corner shading: where on the face is (0, 0), (1, 0), (1, 1), then (0, 1).
 */
export const CORNERS: readonly (readonly (readonly [number, number, number])[])[] = [
  [
    [0, 1, 0],
    [1, 1, 0],
    [1, 1, 1],
    [0, 1, 1],
  ],
  [
    [1, 0, 1],
    [1, 0, 0],
    [1, 1, 0],
    [1, 1, 1],
  ],
  [
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ],
  [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
  ],
  [
    [0, 0, 0],
    [0, 0, 1],
    [0, 1, 1],
    [0, 1, 0],
  ],
  [
    [1, 0, 0],
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
  ],
]

/** Per-vertex ambient occlusion for blocks (0fps, 2013): 0 is a closed corner, 3 is open. */
const aoOf = (s1: number, s2: number, c: number) => (s1 && s2 ? 0 : 3 - (s1 + s2 + c))

/**
 * For each face and each of its corners, the three cells round that corner of the cell the face
 * looks into, as steps from the block: the two beside it along the face, then the one diagonal.
 */
const AROUND_CORNERS: number[][] = CORNERS.map((corners, face) => {
  const normal = [
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, 1],
    [0, -1, 0],
    [-1, 0, 0],
    [0, 0, -1],
  ][face] as number[]
  const [u, v] = normal[0] !== 0 ? [1, 2] : normal[1] !== 0 ? [0, 2] : [0, 1]
  return corners.flatMap((corner) => {
    const a = [0, 0, 0]
    const b = [0, 0, 0]
    a[u as number] = corner[u as number] ? 1 : -1
    b[v as number] = corner[v as number] ? 1 : -1
    const out = (d: number[]) => normal.map((n, axis) => n + (d[axis] as number))
    return [
      ...out(a),
      ...out(b),
      ...out([
        (a[0] as number) + (b[0] as number),
        (a[1] as number) + (b[1] as number),
        (a[2] as number) + (b[2] as number),
      ]),
    ]
  })
})

/**
 * Where the sun (or the moon) is, for the bits that say which faces it reaches; null where those
 * aren't wanted, because a shadow map says it instead (gl.ts), and are left at none.
 */
type Sun = readonly [number, number, number] | null

/** A point light: torches and lit windows. `group` names the switch that turns it on. */
export interface Light {
  x: number
  y: number
  z: number
  radius: number
  group: number
}

export interface Box {
  x0: number
  y0: number
  z0: number
  x1: number
  y1: number
  z1: number
}

/**
 * The grid. Blocks are stored by kind; a second array says which switch (if any) lights a block,
 * and a third marks blocks inside a carved room, which daylight doesn't reach.
 */
export class World {
  readonly size: number
  readonly top: number
  readonly bottom: number
  readonly height: number
  private readonly kinds: Uint8Array
  private readonly groups: Uint8Array
  private readonly inside: Uint8Array
  readonly lights: Light[] = []

  constructor(size: number, bottom: number, top: number) {
    this.size = size
    this.bottom = bottom
    this.top = top
    this.height = top - bottom
    const cells = size * size * this.height
    this.kinds = new Uint8Array(cells)
    this.groups = new Uint8Array(cells)
    this.inside = new Uint8Array(cells)
  }

  private index(x: number, y: number, z: number): number {
    return (y - this.bottom) * this.size * this.size + z * this.size + x
  }

  has(x: number, y: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.size && z < this.size && y >= this.bottom && y < this.top
  }

  get(x: number, y: number, z: number): Kind {
    return this.has(x, y, z) ? (this.kinds[this.index(x, y, z)] as Kind) : Kind.air
  }

  set(x: number, y: number, z: number, kind: Kind, group = 0): void {
    if (!this.has(x, y, z)) return
    const i = this.index(x, y, z)
    this.kinds[i] = kind
    this.groups[i] = group
  }

  fill(box: Box, kind: Kind, group = 0): void {
    for (let y = box.y0; y <= box.y1; y++)
      for (let z = box.z0; z <= box.z1; z++)
        for (let x = box.x0; x <= box.x1; x++) this.set(x, y, z, kind, group)
  }

  /**
   * Empties a box and marks it as a room, so what's left around it is lit only by that room's own
   * switch, and not by the day outside.
   */
  carve(box: Box, group: number): void {
    for (let y = box.y0; y <= box.y1; y++)
      for (let z = box.z0; z <= box.z1; z++)
        for (let x = box.x0; x <= box.x1; x++) {
          if (!this.has(x, y, z)) continue
          const i = this.index(x, y, z)
          this.kinds[i] = Kind.air
          this.inside[i] = group
        }
  }

  light(x: number, y: number, z: number, radius: number, group: number): void {
    this.lights.push({ x, y, z, radius, group })
  }

  /** The switch of the room at this place, or 0 where there is no room. */
  private roomAt(x: number, y: number, z: number): number {
    return this.has(x, y, z) ? (this.inside[this.index(x, y, z)] ?? 0) : 0
  }

  /** True when a ray from this point toward the sun leaves the world without meeting a block. */
  private seesSun(px: number, py: number, pz: number, sun: readonly [number, number, number]): boolean {
    let x = px
    let y = py
    let z = pz
    for (let step = 0; step < 96; step++) {
      x += sun[0] * 0.5
      y += sun[1] * 0.5
      z += sun[2] * 0.5
      if (y >= this.top || x < 0 || z < 0 || x >= this.size || z >= this.size) return true
      if (this.get(Math.floor(x), Math.floor(y), Math.floor(z)) !== Kind.air) return false
    }
    return true
  }

  /** The six directions a block has a face in: up, +x, +z, down, −x, −z. The renderer's order. */
  static readonly FACES: readonly (readonly [number, number, number])[] = [
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, 1],
    [0, -1, 0],
    [-1, 0, 0],
    [0, 0, -1],
  ]

  /**
   * Which of a block's faces the sun reaches, as six bits. A face that looks into a room, or has a
   * block against it, gets none.
   */
  sunOn(x: number, y: number, z: number, sun: readonly [number, number, number]): number {
    let lit = 0
    World.FACES.forEach(([dx, dy, dz], face) => {
      if (this.get(x + dx, y + dy, z + dz) !== Kind.air || this.roomAt(x + dx, y + dy, z + dz) !== 0) return
      if (this.seesSun(x + 0.5 + dx * 0.52, y + 0.5 + dy * 0.52, z + 0.5 + dz * 0.52, sun)) lit |= 1 << face
    })
    return lit
  }

  /**
   * How shut in each corner of each face is, by the blocks round the cell the face looks into:
   * two bits a corner, four corners a face, one byte a face in the renderer's order.
   */
  occlusion(x: number, y: number, z: number): number[] {
    const bytes = [0, 0, 0, 0, 0, 0]
    for (let face = 0; face < 6; face++) {
      const steps = AROUND_CORNERS[face] as number[]
      let byte = 0
      for (let k = 0, at = 0; k < 4; k++, at += 9) {
        const s1 = this.solid(
          x + (steps[at] as number),
          y + (steps[at + 1] as number),
          z + (steps[at + 2] as number),
        )
        const s2 = this.solid(
          x + (steps[at + 3] as number),
          y + (steps[at + 4] as number),
          z + (steps[at + 5] as number),
        )
        const c = this.solid(
          x + (steps[at + 6] as number),
          y + (steps[at + 7] as number),
          z + (steps[at + 8] as number),
        )
        byte |= aoOf(s1, s2, c) << (2 * k)
      }
      bytes[face] = byte
    }
    return bytes
  }

  /** 1 where there is a block, 0 where there is air or nothing. */
  private solid(x: number, y: number, z: number): number {
    return this.has(x, y, z) && this.kinds[this.index(x, y, z)] !== Kind.air ? 1 : 0
  }

  /**
   * Digs a block out and hands back what it was, so it can be put back. A hole dug in the wall of
   * a room becomes part of that room, and is lit with it.
   */
  take(x: number, y: number, z: number): Taken | null {
    if (!this.has(x, y, z)) return null
    const i = this.index(x, y, z)
    const kind = this.kinds[i] as Kind
    if (kind === Kind.air) return null
    const taken: Taken = { x, y, z, kind, group: this.groups[i] ?? 0, inside: this.inside[i] ?? 0 }
    this.kinds[i] = Kind.air
    if (taken.inside === 0)
      for (const [dx, dy, dz] of World.FACES) {
        const room = this.get(x + dx, y + dy, z + dz) === Kind.air ? this.roomAt(x + dx, y + dy, z + dz) : 0
        if (room !== 0) this.inside[i] = room
      }
    return taken
  }

  /** Puts back what was dug out, as it was. */
  put(taken: Taken): void {
    const i = this.index(taken.x, taken.y, taken.z)
    this.kinds[i] = taken.kind
    this.groups[i] = taken.group
    this.inside[i] = taken.inside
  }

  /**
   * The eight bytes the renderer wants for the block at a place: tone, kind, light group, which
   * faces are open, which of them the sun reaches, which of them look outdoors, the room the
   * others look into, and how big to draw it (255 is whole). Null when none of it can be seen.
   */
  bytes(x: number, y: number, z: number, sun: Sun): number[] | null {
    const kind = this.get(x, y, z)
    if (kind === Kind.air) return null
    let mask = 0
    let outdoors = 0
    let room = 0
    World.FACES.forEach(([dx, dy, dz], face) => {
      if (this.get(x + dx, y + dy, z + dz) !== Kind.air) return
      mask |= 1 << face
      const inside = this.roomAt(x + dx, y + dy, z + dz)
      if (inside === 0) outdoors |= 1 << face
      else room = inside
    })
    if (mask === 0) return null
    return [
      Math.round((TONE[kind] ?? 0.5) * 255),
      kind,
      this.groups[this.index(x, y, z)] ?? 0,
      mask,
      sun ? this.sunOn(x, y, z, sun) : 0,
      outdoors,
      room,
      255,
    ]
  }
}

/** A block that was dug out: where it was and everything needed to put it back. */
export interface Taken {
  x: number
  y: number
  z: number
  kind: Kind
  group: number
  inside: number
}

/**
 * Every block of a world with a face open to the air, packed for the renderer (3 floats of
 * position and 8 bytes each), with room to grow: digging a block out uncovers the ones behind it.
 */
export class Mesh {
  positions: Float32Array
  data: Uint8Array
  /** Each block's corner shading, six bytes in eight (`World.occlusion`). */
  ao: Uint8Array
  count = 0
  /**
   * The world as it was first packed is in layers, bottom to top: `layers[n]` is where the layer
   * `n` blocks above the bottom begins in the list, and `base` is where that first packing ends.
   * Whatever digging uncovers later is added after `base`, in no order.
   */
  readonly layers: Uint32Array
  readonly base: number
  private readonly slots = new Map<number, number>()
  private readonly world: World

  constructor(world: World, sun: Sun) {
    this.world = world
    this.positions = new Float32Array(3 * 4096)
    this.data = new Uint8Array(8 * 4096)
    this.ao = new Uint8Array(8 * 4096)
    this.layers = new Uint32Array(world.height + 1)
    for (let y = world.bottom; y < world.top; y++) {
      this.layers[y - world.bottom] = this.count
      for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) this.refresh(x, y, z, sun)
    }
    this.layers[world.height] = this.count
    this.base = this.count
  }

  /**
   * The blocks to draw to show the world between two heights: the layers between them, and
   * everything uncovered since, as runs of the list (first block, how many).
   */
  between(low: number, high: number): [number, number][] {
    const from = Math.min(this.world.height, Math.max(0, Math.floor(low) - this.world.bottom))
    const to = Math.min(this.world.height, Math.max(from, Math.ceil(high) - this.world.bottom + 1))
    const first = this.layers[from] ?? 0
    const runs: [number, number][] = [[first, (this.layers[to] ?? this.base) - first]]
    if (this.count > this.base) runs.push([this.base, this.count - this.base])
    return runs
  }

  /** Draws one block smaller or whole: `size` is 0 to 1. For a block growing back. */
  scale(x: number, y: number, z: number, size: number): void {
    const at = this.slots.get(this.slot(x, y, z))
    if (at !== undefined) this.data[at * 8 + 7] = Math.round(Math.min(1, Math.max(0, size)) * 255)
  }

  private slot(x: number, y: number, z: number): number {
    return ((y - this.world.bottom) * this.world.size + z) * this.world.size + x
  }

  /** Works one block out again, after it or something beside it changed. */
  refresh(x: number, y: number, z: number, sun: Sun): void {
    if (!this.world.has(x, y, z)) return
    const key = this.slot(x, y, z)
    const bytes = this.world.bytes(x, y, z, sun)
    let at = this.slots.get(key)
    if (at === undefined) {
      if (!bytes) return
      if ((this.count + 1) * 3 > this.positions.length) {
        const positions = new Float32Array(this.positions.length * 2)
        positions.set(this.positions)
        this.positions = positions
        const data = new Uint8Array(this.data.length * 2)
        data.set(this.data)
        this.data = data
        const ao = new Uint8Array(this.ao.length * 2)
        ao.set(this.ao)
        this.ao = ao
      }
      at = this.count++
      this.slots.set(key, at)
      this.positions.set([x, y, z], at * 3)
    }
    if (bytes) {
      this.data.set(bytes, at * 8)
      this.ao.set(this.world.occlusion(x, y, z), at * 8)
    }
    // A block with no face open keeps its place in the list and is simply not drawn.
    else this.data[at * 8 + 3] = 0
  }

  /** Works out a block and the ones round it: beside it for its faces, and corner to corner for their shading. */
  around(x: number, y: number, z: number, sun: Sun): void {
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) this.refresh(x + dx, y + dy, z + dz, sun)
  }
}

/**
 * Moves the sun over a packed world: the shadows of every block at or above `fromY` are worked
 * out again, in place. Blocks below never see the sky, so they are left alone.
 */
export function relight(
  world: World,
  packed: { positions: Float32Array; data: Uint8Array; count: number },
  sun: readonly [number, number, number],
  fromY: number,
): void {
  for (let i = 0; i < packed.count; i++) {
    const y = packed.positions[i * 3 + 1] as number
    if (y < fromY) continue
    if (packed.data[i * 8 + 3] === 0) continue
    const x = packed.positions[i * 3] as number
    const z = packed.positions[i * 3 + 2] as number
    packed.data[i * 8 + 4] = world.sunOn(x, y, z, sun)
  }
}

/** A repeatable pseudo-random number in [0, 1) from three integers. */
export function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
