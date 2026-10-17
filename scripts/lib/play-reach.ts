// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where players can be while they play, worked out from a world's blocks: every place a player
 * can stand that they can walk, climb, drop or jump to from the places a game puts them, and over
 * each the room their body takes, standing and jumping, and the air over every gap they can jump
 * across. What `play-space.ts` writes for the tests to keep Cubepals' signs and words out of.
 *
 * It errs toward more room, never less: it walks through doors and over fences, jumps as far as
 * a sprinting player can in any direction, and drops from any height, so a place is left out only
 * where no player could be.
 */

type Block = readonly [number, number, number]

/**
 * How tall the room over a place a player stands is: a player is 1.8 blocks tall (`EntityType.PLAYER`'s
 * dimensions) and a jump lifts their feet 1.2522 blocks (jump power 0.42 a tick, less 0.08 gravity and
 * 2% drag a tick, summed to its top).
 */
export const HEADROOM = 1.8 + 1.2522

/** The furthest a sprinting jump carries a player, in blocks across, onto the same height or lower; one block up, one less. */
const JUMP = 5
/** The furthest a jump onto lower ground is counted, in blocks down; a fall from any height lands somewhere straight under. */
const JUMP_DROP = 12

/** Blocks a player passes through: air and light, plants, flat things on the ground or a wall, water. */
const PASSABLE =
  /(^|:)(air|cave_air|void_air|light|structure_void)$|grass$|fern$|flower|tulip|orchid|allium|bluet|daisy|poppy|dandelion|lilac|peony|rose_bush|cornflower|lily_of_the_valley|torchflower|vine|torch|sign|button|rail|lever|pressure_plate|carpet|banner|sapling|mushroom$|dead_bush|seagrass|kelp|sugar_cane|redstone_wire|tripwire|ladder|scaffolding|water|bubble_column|cobweb|_head$|_skull$|snow$|frame$|lantern$|chain$|candle$|flower_pot|potted_|end_rod|lightning_rod|moss_carpet|glow_lichen|hanging_roots|spore_blossom|pointed_dripstone|amethyst_cluster|_bud$|leaf_litter|bush$|short_dry_grass|tall_dry_grass|firefly_bush/

/** Blocks a player climbs, or swims up, standing in them. */
const CLIMBABLE = /ladder|vine|scaffolding|water|bubble_column/

/** Blocks with a half step in them, which a player walks up without jumping. */
const HALF_STEP = /stairs$|slab$/

/** Blocks half a block taller than a block: a player standing on one jumps half a block higher than the grid says. */
const TALL = /_wall$|fence|bars$|pane$/

/** A stretch of height over a column, from `y0` up to `y1`. */
type Span = [number, number]

/** Every column's spans of room, by `x z`. */
export type Room = Map<string, Span[]>

/** The room players have in a world, walked from where a game puts them. */
export function playRoom(
  blockAt: (x: number, y: number, z: number) => string | undefined,
  region: { from: Block; to: Block },
  seeds: readonly Block[],
): Room {
  return new Walk(blockAt, region).from(seeds)
}

/** One walk over a world: where a player stands, and where they go from each place. */
class Walk {
  readonly #blockAt: (x: number, y: number, z: number) => string | undefined
  /** Each column's heights a player can stand at, lowest first. */
  readonly #stands = new Map<string, number[]>()
  readonly #room: Room = new Map()
  readonly #seen = new Set<string>()
  readonly #queue: Block[] = []

  constructor(
    blockAt: (x: number, y: number, z: number) => string | undefined,
    region: { from: Block; to: Block },
  ) {
    this.#blockAt = blockAt
    const [lo, hi] = [region.from, region.to]
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let z = lo[2]; z <= hi[2]; z++) {
        const ys: number[] = []
        for (let y = lo[1] + 1; y < hi[1]; y++) if (this.#standable(x, y, z)) ys.push(y)
        if (ys.length > 0) this.#stands.set(`${x} ${z}`, ys)
      }
  }

  /** The room, walked from each seed: the nearest place to stand at or under it, as the game puts a player down. */
  from(seeds: readonly Block[]): Room {
    for (const [x, y, z] of seeds) {
      const under = (this.#stands.get(`${x} ${z}`) ?? []).filter((at) => at <= y + 1).at(-1)
      if (under === undefined) throw new Error(`Nowhere to stand at ${x} ${y} ${z}`)
      this.#visit([x, under, z])
    }
    for (let at = this.#queue.pop(); at !== undefined; at = this.#queue.pop()) this.#step(at)
    for (const [key, spans] of this.#room) this.#room.set(key, merged(spans))
    return this.#room
  }

  #passable(x: number, y: number, z: number): boolean {
    const block = this.#blockAt(x, y, z)
    return block === undefined || PASSABLE.test(block)
  }

  #climbable(x: number, y: number, z: number): boolean {
    return CLIMBABLE.test(this.#blockAt(x, y, z) ?? '')
  }

  #standable(x: number, y: number, z: number): boolean {
    return (
      this.#passable(x, y, z) &&
      this.#passable(x, y + 1, z) &&
      (!this.#passable(x, y - 1, z) || this.#climbable(x, y, z))
    )
  }

  /** Room for a player's body, feet and head, at a height of a column. */
  #clear(x: number, y: number, z: number): boolean {
    return this.#passable(x, y, z) && this.#passable(x, y + 1, z)
  }

  #visit(at: Block) {
    const key = at.join(' ')
    if (this.#seen.has(key)) return
    this.#seen.add(key)
    this.#queue.push(at)
  }

  #add(x: number, z: number, span: Span) {
    const key = `${x} ${z}`
    this.#room.set(key, [...(this.#room.get(key) ?? []), span])
  }

  /** A place a player stands: the room over it, and every place they go from it. */
  #step([x, y, z]: Block) {
    this.#add(x, z, [y, y + HEADROOM])
    // Up a ladder until the feet are level with its top, and on from there.
    if (this.#climbable(x, y, z) && this.#clear(x, y + 1, z)) this.#visit([x, y + 1, z])
    const reachUp = this.#climbable(x, y, z) || TALL.test(this.#blockAt(x, y - 1, z) ?? '') ? 2 : 1
    for (let dx = -JUMP; dx <= JUMP; dx++)
      for (let dz = -JUMP; dz <= JUMP; dz++)
        for (const ty of this.#stands.get(`${x + dx} ${z + dz}`) ?? [])
          this.#move([x, y, z], [x + dx, ty, z + dz], reachUp)
  }

  /** A move from one place to stand to another, if a player can make it: a step, a climb, a drop or a jump. */
  #move(from: Block, to: Block, reachUp: number) {
    const across = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[2] - from[2]))
    const rise = to[1] - from[1]
    if (across === 0 || rise > reachUp || (rise > 0 && across > JUMP - 1)) return
    if (across > 1 && rise < -JUMP_DROP) return
    if (!this.#canGo(from, to)) return
    this.#visit(to)
    if (across > 1) this.#jumpOver(from, to)
  }

  /**
   * Whether a player gets from one place to another: room over their head to go up, nothing in the
   * way at the height they go across at, and nothing in the way of falling onto where they land.
   * Across a corner, one of its two sides must be open.
   */
  #canGo(from: Block, to: Block): boolean {
    const [x, y, z] = from
    const [tx, ty, tz] = to
    const top = Math.max(y, ty)
    const walksUp = HALF_STEP.test(this.#blockAt(tx, ty - 1, tz) ?? '')
    if (ty > y && !walksUp && !this.#passable(x, y + 2, z)) return false
    for (let at = ty; at <= top + 1; at++) if (!this.#passable(tx, at, tz)) return false
    const corner = Math.abs(tx - x) === 1 && Math.abs(tz - z) === 1
    if (corner && !this.#clear(tx, top, z) && !this.#clear(x, top, tz)) return false
    return between(from, to).every(([cx, cz]) => this.#clear(cx, top, cz))
  }

  /** The air over a jump across a gap: each column on the way, from the lower feet to over the higher head. */
  #jumpOver(from: Block, to: Block) {
    const [y0, y1] = [Math.min(from[1], to[1]), Math.max(from[1], to[1])]
    const columns = between(from, to)
    const gap = ([x, z]: [number, number]) =>
      !(this.#stands.get(`${x} ${z}`) ?? []).some((y) => y >= y0 - 1 && y <= y1 + 1)
    if (!columns.some(gap)) return
    for (const [x, z] of columns) this.#add(x, z, [y0, y1 + HEADROOM])
  }
}

/** The columns a move passes over between its two ends, neither end included. */
function between(from: Block, to: Block): Array<[number, number]> {
  const steps = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[2] - from[2])) * 2
  const columns: Array<[number, number]> = []
  for (let i = 1; i < steps; i++) {
    const x = Math.round(from[0] + ((to[0] - from[0]) * i) / steps)
    const z = Math.round(from[2] + ((to[2] - from[2]) * i) / steps)
    if ((x !== from[0] || z !== from[2]) && (x !== to[0] || z !== to[2])) columns.push([x, z])
  }
  return columns
}

/** Spans as few as cover the same height: overlapping or touching ones joined. */
function merged(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const out: Span[] = []
  for (const span of sorted) {
    const last = out.at(-1)
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else out.push([span[0], span[1]])
  }
  return out
}

/** A box of room: x and z from and to (to excluded), y from and to. */
export type RoomBox = [x0: number, z0: number, x1: number, z1: number, y0: number, y1: number]

/**
 * The room as boxes, few enough to keep: columns of the same spans side by side along x joined
 * into runs, and runs of the same reach and spans along z joined into boxes.
 */
export function roomBoxes(room: Room): RoomBox[] {
  const sig = (spans: Span[]) => spans.map(([a, b]) => `${a}:${Number(b.toFixed(4))}`).join(',')
  const byZ = new Map<number, Array<[number, Span[]]>>()
  for (const [key, spans] of room) {
    const [x = 0, z = 0] = key.split(' ').map(Number)
    byZ.set(z, [...(byZ.get(z) ?? []), [x, spans]])
  }
  // Runs along x in each row: from, to (excluded) and their spans.
  const runs = new Map<string, { x0: number; x1: number; z0: number; z1: number; spans: Span[] }>()
  for (const z of [...byZ.keys()].sort((a, b) => a - b)) {
    const row = (byZ.get(z) ?? []).sort((a, b) => a[0] - b[0])
    let run: { x0: number; x1: number; spans: Span[] } | undefined
    const close = () => {
      if (run === undefined) return
      const key = `${run.x0} ${run.x1} ${sig(run.spans)}`
      const above = runs.get(key)
      if (above !== undefined && above.z1 === z) above.z1 = z + 1
      else {
        if (above !== undefined) runs.set(`${key} ${above.z0}`, above)
        runs.set(key, { ...run, z0: z, z1: z + 1 })
      }
    }
    for (const [x, spans] of row) {
      if (run !== undefined && run.x1 === x && sig(run.spans) === sig(spans)) run.x1 = x + 1
      else {
        close()
        run = { x0: x, x1: x + 1, spans }
      }
    }
    close()
  }
  return [...runs.values()].flatMap(({ x0, x1, z0, z1, spans }) =>
    spans.map(([y0, y1]): RoomBox => [x0, z0, x1, z1, y0, Number(y1.toFixed(4))]),
  )
}
