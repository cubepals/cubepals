/**
 * The other worlds. Every Blockly server is a world like the one the page digs through, and when
 * the camera stands far enough back they are all there: small floating pieces of ground, each
 * with its own house, most of them dark because most of them are asleep.
 *
 * A handful of worlds are built block by block and then set down many times over, so there can be
 * a great many of them for the price of a few.
 */
import { hash3, Kind, World } from './world'

/** The light switches the far worlds' windows are on: two groups that wake and sleep in turn. */
export const COHORTS = [10, 11] as const

const SIZE = 16
const DEPTH = 7
const KINDS = 6

/** One small world: a piece of ground that narrows underneath, with a tree or two and a house. */
function island(seed: number): World {
  const world = new World(SIZE, -DEPTH, 9)
  for (let y = 0; y > -DEPTH; y--) {
    // Each layer down is cut in a little further, raggedly, the way a floating rock would be.
    const inset = [0, 0, 1, 2, 3, 5, 6][-y] ?? 6
    for (let z = inset; z < SIZE - inset; z++)
      for (let x = inset; x < SIZE - inset; x++) {
        const rim = x === inset || z === inset || x === SIZE - inset - 1 || z === SIZE - inset - 1
        if (rim && hash3(x + seed * 31, y, z) > 0.62) continue
        world.set(x, y, z, y === 0 ? Kind.grass : y > -3 ? Kind.dirt : Kind.stone)
      }
  }
  const at = (n: number, lo: number, hi: number) => lo + Math.floor(hash3(seed, n, 7) * (hi - lo + 1))
  // The house, with a window and a lamp that are lit while its server is awake.
  const hx = at(1, 3, 8)
  const hz = at(2, 3, 8)
  world.fill({ x0: hx, x1: hx + 3, z0: hz, z1: hz + 3, y0: 1, y1: 2 }, Kind.planks)
  world.fill({ x0: hx, x1: hx + 3, z0: hz - 1, z1: hz + 4, y0: 3, y1: 3 }, Kind.roof)
  world.fill({ x0: hx, x1: hx + 3, z0: hz, z1: hz + 3, y0: 4, y1: 4 }, Kind.roof)
  world.set(hx + 3, 2, hz + 1, Kind.glass, COHORTS[0])
  world.set(hx + 1, 2, hz + 3, Kind.glass, COHORTS[0])
  world.set(hx + 3, 1, hz + 2, Kind.dark)
  world.set(hx + 5, 1, hz + 2, Kind.log)
  world.set(hx + 5, 2, hz + 2, Kind.lamp, COHORTS[0])
  // Torches about the place, so a world that is awake can be told from far off.
  for (const [tx, tz] of [
    [1, 1],
    [14, 2],
    [2, 13],
    [13, 13],
    [hx - 1, hz + 5],
  ] as const)
    if (world.get(tx, 0, tz) !== Kind.air && world.get(tx, 1, tz) === Kind.air)
      world.set(tx, 1, tz, Kind.torch, COHORTS[0])
  for (let n = 0; n < 1 + (seed % 3); n++) {
    const tx = at(10 + n, 1, 14)
    const tz = at(20 + n, 1, 14)
    if (tx >= hx - 2 && tx <= hx + 6 && tz >= hz - 2 && tz <= hz + 5) continue
    if (world.get(tx, 0, tz) === Kind.air) continue
    for (let y = 1; y <= 3; y++) world.set(tx, y, tz, Kind.log)
    for (let dy = 3; dy <= 5; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (dy < 5 || (dx === 0 && dz === 0)) world.set(tx + dx, dy, tz + dz, Kind.leaves)
  }
  if (seed % 2 === 0) {
    const px = at(30, 9, 11)
    const pz = at(31, 9, 11)
    for (let z = pz; z < pz + 3; z++)
      for (let x = px; x < px + 3; x++) if (world.get(x, 0, z) !== Kind.air) world.set(x, 0, z, Kind.water)
  }
  return world
}

/** The faces a far world shows, in the order the renderer keeps their corners: all but the underside. */
export const FAR_FACES = [0, 1, 2, 4, 5] as const

/** One far world: where its faces are in the packed list, and where its middle is. */
export interface Island {
  /** For each of FAR_FACES in turn: the first of this world's faces that look that way, and how many. */
  runs: [number, number][]
  x: number
  y: number
  z: number
  /** True if someone may be awake there: its windows show from further off than its ground does. */
  lit: boolean
}

export interface Fleet {
  positions: Float32Array
  data: Uint8Array
  /** How many faces are packed. */
  count: number
  /** Each world's own runs of the list, so the ones out of sight need not be drawn. */
  islands: Island[]
}

/**
 * The far worlds, packed for the renderer. `reach` is how many worlds out from the middle they
 * go; the one in the middle is left out, since that is the chunk itself.
 */
export function buildFleet(reach: number, sun: readonly [number, number, number]): Fleet {
  // Each kind of world as five lists of blocks, one for each face a block can show: a block is in
  // a list for every face of it that is open. Nobody ever looks at these from underneath.
  const kinds = Array.from({ length: KINDS }, (_, seed) => {
    const world = island(seed + 1)
    const blocks: number[][] = []
    for (let y = world.bottom; y < world.top; y++)
      for (let z = 0; z < SIZE; z++)
        for (let x = 0; x < SIZE; x++) {
          const bytes = world.bytes(x, y, z, sun)
          if (bytes) blocks.push([x, y, z, ...bytes])
        }
    return FAR_FACES.map((face) => blocks.filter((block) => ((block[6] as number) & (1 << face)) !== 0))
  })
  const placed: { faces: number[][][]; ox: number; oy: number; oz: number; cohort: number }[] = []
  const islands: Island[] = []
  const pitch = 30
  let count = 0
  for (let j = -reach; j <= reach; j++)
    for (let i = -reach; i <= reach; i++) {
      if (i === 0 && j === 0) continue
      if (i * i + j * j > reach * reach + 1) continue
      const r = hash3(i, 99, j)
      if (r > 0.86) continue
      const faces = kinds[Math.floor(r * 97) % KINDS] as number[][][]
      const ox = i * pitch + Math.round((hash3(i, 1, j) - 0.5) * 9)
      const oz = j * pitch + Math.round((hash3(i, 2, j) - 0.5) * 9)
      const oy = Math.round((hash3(i, 3, j) - 0.6) * 16)
      // About a third of the worlds have someone in them at one time or another.
      const awake = hash3(i, 4, j)
      const cohort = awake < 0.17 ? COHORTS[0] : awake < 0.34 ? COHORTS[1] : 0
      // A torch stands only where someone might be awake, and is a dark stick until they are.
      for (const list of faces)
        for (const block of list) if (cohort !== 0 || block[4] !== Kind.torch) count += 1
      placed.push({ faces, ox, oy, oz, cohort })
      islands.push({ runs: [], x: ox + SIZE / 2, y: oy, z: oz + SIZE / 2, lit: cohort !== 0 })
    }
  // Packed a face at a time: every world's tops, then each wall in turn. A face that is open is
  // drawn with its own six corners, and one with a block against it is not there at all.
  const positions = new Float32Array(count * 3)
  const data = new Uint8Array(count * 8)
  let at = 0
  for (let slot = 0; slot < FAR_FACES.length; slot++)
    placed.forEach(({ faces, ox, oy, oz, cohort }, index) => {
      const first = at
      for (const block of faces[slot] as number[][]) {
        const torch = block[4] === Kind.torch
        if (torch && cohort === 0) continue
        positions[at * 3] = (block[0] as number) + ox
        positions[at * 3 + 1] = (block[1] as number) + oy
        positions[at * 3 + 2] = (block[2] as number) + oz
        data[at * 8] = torch ? 40 : (block[3] as number)
        data[at * 8 + 1] = block[4] as number
        data[at * 8 + 2] = block[5] === 0 ? 0 : cohort
        for (let n = 3; n < 8; n++) data[at * 8 + n] = block[n + 3] as number
        at += 1
      }
      ;(islands[index] as Island).runs.push([first, at - first])
    })
  return { positions, data, count, islands }
}
