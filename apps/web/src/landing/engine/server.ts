/**
 * The server, and what stands round one: the kit every room under the grass is furnished from.
 *
 * It is one machine built out of the game's own parts, the same wherever it appears: a rack of
 * trays with small lamps on each tray's face. Round it, from the same kit, chests for what is
 * kept, furnaces for what does the work, redstone on the floor with something on its way along
 * it, and the small block of world a server runs. None of it is a diagram of the real thing; it
 * is the idea of it, in blocks.
 *
 * Everything here moves the way the thing would, never as a chart does: a tray is pushed home
 * past flush and settles, lamps come on one after another, a chest is dropped and its lid jumps.
 * Nothing fades.
 *
 * A piece is drawn at a `Place`: where the middle of its front edge is on the floor, which way
 * its face looks, and how big it is. Its parts are given in its own terms (x to its side, y up,
 * z out of its face) and set into the world here.
 */
import { LIT } from './chunk'
import { clamp, ease } from './curves'
import type { Box } from './models'
import { hash3, Kind } from './world'

/** Past where it is going and back to it: how something pushed home, or popping up, arrives. */
export const overshoot = (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2
/** A little the wrong way first, and then off: how something gathers itself to go. */
export const windup = (t: number) => 2.70158 * t ** 3 - 1.70158 * t ** 2
/** How much of a thing that comes and goes is there, by how far through its time it is. */
export const puff = (age: number) => ease(clamp(age / 0.12)) * (1 - ease(clamp((age - 0.75) / 0.25)))

/** Where a piece of the kit stands: the middle of its front edge on the floor, and how it is turned. */
export interface Place {
  x: number
  y: number
  z: number
  /** Which way its face looks, in radians: 0 is along z, a quarter turn is along x. */
  heading: number
  /** The room it is in, by that room's light switch; 0 out of doors. */
  inside: number
  /** How big it is: 1 unless said. */
  scale?: number
}

/**
 * Draws one part of a piece: where its middle is in the piece's own terms, its size, what it is
 * made of, and how it is tipped or turned on itself.
 */
export type Part = (
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  tone: number,
  kind: number,
  glow?: number,
  tipped?: number,
  round?: number,
) => void

/** The way to draw parts at a place. */
export function partsAt(box: Box, at: Place): Part {
  const scale = at.scale ?? 1
  const sin = Math.sin(at.heading)
  const cos = Math.cos(at.heading)
  return (cx, cy, cz, sx, sy, sz, tone, kind, glow = 0, tipped = 0, round = 0) => {
    const wide = sx * scale
    const tall = sy * scale
    const deep = sz * scale
    if (wide < 0.01 || tall < 0.01 || deep < 0.01) return
    box(
      at.x + (cx * cos + cz * sin) * scale - wide / 2,
      at.y + cy * scale - tall / 2,
      at.z + (-cx * sin + cz * cos) * scale - deep / 2,
      wide,
      tall,
      deep,
      tone,
      kind,
      glow,
      at.inside,
      at.heading + round,
      tipped,
    )
  }
}

/** One part of something that comes and goes: whether it is wanted, and since when. */
export interface Slot {
  on: boolean
  at: number
}

/** Long enough ago that whatever it was has finished. */
export const SETTLED = -100

/** A stack of parts, `count` of them there and settled. */
export const slotsOf = (count: number, of: number): Slot[] =>
  Array.from({ length: of }, (_, n) => ({ on: n < count, at: SETTLED }))

/**
 * Brings a stack of parts toward the number wanted, one at a time from the top, each a moment
 * after the one before it and never while it is still finishing the other way.
 */
export function sequence(slots: Slot[], count: number, clock: number, apart: number): void {
  const on = slots.filter((slot) => slot.on).length
  if (on < count) {
    const next = slots[on]
    const under = slots[on - 1]
    if (next && clock - next.at > 1 && (!under || clock - under.at > apart)) {
      next.on = true
      next.at = clock
    }
  } else if (on > count) {
    const top = slots[on - 1]
    const over = slots[on]
    if (top && clock - top.at > 1.6 && (!over || clock - over.at > apart)) {
      top.on = false
      top.at = clock
    }
  }
}

/**
 * How far above where it rests something dropped from `height` is, `age` seconds after it was let
 * go: it falls, and bounces twice. And how hard it has just landed, 0 to 1, for a lid to jump.
 */
export function drop(age: number, height: number): { up: number; jolt: number } {
  const fall = 0.36
  if (age < fall) return { up: height * (1 - (age / fall) ** 2), jolt: 0 }
  const first = (age - fall) / 0.26
  if (first < 1) return { up: height * 0.14 * 4 * first * (1 - first), jolt: Math.sin(first * Math.PI) }
  const second = (age - fall - 0.26) / 0.15
  if (second < 1)
    return { up: height * 0.035 * 4 * second * (1 - second), jolt: Math.sin(second * Math.PI) * 0.3 }
  return { up: 0, jolt: 0 }
}

/**
 * What a server is doing, which is only ever said by its lamps. Off: every lamp dark. Booting:
 * they come on tray by tray from the bottom, the four of a tray one after another, and are held
 * lit. On: each blinks in its own time. Fault: all flash together three times and stay dark, with
 * one puff of smoke from the top and a jolt.
 */
export type Power = 'off' | 'booting' | 'on' | 'fault'

/** How tall one unit of a rack is. */
export const UNIT = 0.8
/** How wide a rack is, and how deep: its front edge is where it is placed. */
export const RACK_WIDE = 2
export const RACK_DEEP = 1.9

/**
 * A server: a rack of trays. It keeps how many trays it has and whether it is on, and changes
 * either the way a machine does: a tray at a time, a lamp at a time.
 *
 * Made with `bays`, it stands as a frame: its bays are there whether or not a tray is in them,
 * an empty one a dark opening, and trays are pushed into them and pulled out. Made without, a bay
 * comes up with its tray and goes down after it.
 */
export class Rack {
  readonly slots: Slot[]
  private readonly bays: Slot[] | null
  private state: Power
  /** When it was last switched, and what from: its lamps go by this. */
  private switched = SETTLED
  /** A number of its own, so its lamps keep a different time from the next rack's. */
  private readonly seed: number

  constructor(trays: number, most = 5, power: Power = 'on', seed = 0, bays?: number) {
    this.slots = slotsOf(trays, most)
    this.bays = bays === undefined ? null : slotsOf(bays, most)
    this.state = power
    this.seed = seed
  }

  /** How many trays it has, counting one on its way in and not one on its way out. */
  get trays(): number {
    return this.slots.filter((slot) => slot.on).length
  }

  /** How many bays stand, where it is a frame. */
  get standing(): number {
    return (this.bays ?? this.slots).filter((slot) => slot.on).length
  }

  get power(): Power {
    return this.state
  }

  /** Asks for a number of trays: they come and go one at a time, and only into bays that stand. */
  size(trays: number, clock: number): void {
    const room = this.bays
      ? this.bays.filter((bay) => bay.on && clock - bay.at > 0.3).length
      : this.slots.length
    sequence(this.slots, Math.min(trays, room), clock, 0.42)
  }

  /** Asks a frame for a number of bays: they rise one on another, and sink once their trays are out. */
  frame(bays: number, clock: number): void {
    if (!this.bays) return
    const held = this.slots.filter((slot) => slot.on || clock - slot.at < 0.8).length
    sequence(this.bays, Math.max(bays, held), clock, 0.22)
  }

  /** Switches it. Booted, it goes on to blink without booting again. */
  set(power: Power, clock: number): void {
    if (power === this.state) return
    const from = this.state
    this.state = power
    if (from === 'booting' && power === 'on') return
    // Stopped by a fault it is dark already: there is nothing left to put out.
    this.switched = from === 'fault' && power === 'off' ? SETTLED : clock
  }

  /** As it stands with everything finished: for one held moment, or a scene joined part-way. */
  settle(trays: number, power: Power, bays = trays): void {
    this.slots.forEach((slot, n) => {
      slot.on = n < trays
      slot.at = SETTLED
    })
    this.bays?.forEach((bay, n) => {
      bay.on = n < Math.max(bays, trays)
      bay.at = SETTLED
    })
    this.state = power
    this.switched = SETTLED
  }

  /**
   * Draws it, and says how high its top is in the world. `hot` has every lamp lit: the last
   * choice was about this machine.
   */
  draw(box: Box, at: Place, clock: number, hot = false): number {
    const scale = at.scale ?? 1
    const since = clock - this.switched
    // Stopped by a fault, it jolts.
    const jolt =
      this.state === 'fault' && since < 0.3 ? 0.05 * Math.sin(since * 50) * (1 - since / 0.3) * scale : 0
    const part = partsAt(
      box,
      jolt ? { ...at, x: at.x + jolt * Math.cos(at.heading), z: at.z - jolt * Math.sin(at.heading) } : at,
    )
    const count = this.trays
    let top = 0
    for (let n = 0; n < this.slots.length; n++) {
      const slot = this.slots[n] as Slot
      const age = clock - slot.at
      const bay = this.bays?.[n]
      let rise: number
      if (bay) {
        // A frame's bay: up with a little too much spring, and down again when it is not wanted.
        const stood = clock - bay.at
        if (!bay.on && stood > 0.25) break
        rise = bay.on ? overshoot(clamp(stood / 0.28)) : 1 - clamp(stood / 0.25) ** 2
      } else {
        if (!slot.on && age > 0.8) break
        // The bay: up with a little too much spring, and down again when its tray has gone.
        rise = slot.on ? overshoot(clamp(age / 0.28)) : 1 - clamp((age - 0.55) / 0.25) ** 2
      }
      const y = top
      const height = UNIT * rise
      top += height
      part(0, y + height / 2, -RACK_DEEP / 2, RACK_WIDE, height, RACK_DEEP, 60, Kind.dark)
      if (bay && height > 0.2) {
        // An empty bay is a dark opening with a rim to it, not a missing one.
        for (const side of [-0.95, 0.95]) part(side, y + height / 2, 0.02, 0.1, height, 0.08, 215, Kind.iron)
        part(0, y + 0.04, 0.02, 1.8, 0.08, 0.08, 215, Kind.iron)
      }
      if (!slot.on && age > 0.8) continue
      // The tray: it pops out in front of the bay, is pushed home past flush and comes back to
      // it. Taken out, it is drawn a touch further in first, pulled, and gone.
      const out = slot.on ? 1 - overshoot(clamp((age - 0.3) / 0.34)) : windup(clamp((age - 0.2) / 0.3))
      const size = slot.on ? overshoot(clamp((age - 0.16) / 0.16)) : 1 - windup(clamp((age - 0.5) / 0.14))
      if (slot.on ? age <= 0.16 : size <= 0.02) continue
      const forward = out * 1.3
      const middle = y + 0.09 + (UNIT - 0.18) / 2
      part(0, middle, -0.775 + forward, 1.84 * size, (UNIT - 0.18) * size, 1.95 * size, 215, Kind.iron)
      if (size < 0.98) continue
      const face = 0.22 + forward
      part(0.38, y + 0.29, face, 0.8, 0.24, 0.04, 40, Kind.dark)
      for (let lamp = 0; lamp < 4; lamp++) {
        part(
          -0.815 + lamp * 0.25,
          y + 0.535,
          face,
          0.15,
          0.15,
          0.05,
          ...this.lamp(n, lamp, count, age, since, clock, hot, slot.on),
        )
      }
      // As it goes home it throws a few sparks, which fall and are spent.
      const spent = age - 0.6
      if (slot.on && spent > 0 && spent < 0.4)
        for (let spark = 0; spark < 4; spark++) {
          const bit = 0.13 * (1 - (spent / 0.4) ** 2)
          part(
            (spark - 1.5) * 1.3 * spent,
            middle + (1.5 + (spark % 2) * 1.1) * spent - 6 * spent * spent,
            0.25 + (0.9 + spark * 0.35) * spent,
            bit,
            bit,
            bit,
            80,
            Kind.lamp,
            LIT,
          )
        }
    }
    // At a fault it smokes, once: three puffs from the top, and they are spent.
    if (this.state === 'fault' && since < 1.4) {
      for (let n = 0; n < 3; n++) {
        const rise = clamp(since / 1.4 - n * 0.12)
        const bit = (0.25 + rise * 0.4) * puff(rise)
        part(0.5 + n * 0.15, top + 0.2 + rise * 1.2, -0.65, bit, bit, bit, 250, Kind.wool)
      }
    }
    return at.y + top * scale
  }

  /** One lamp, as a tone, what it is made of, and whether it glows. */
  private lamp(
    tray: number,
    lamp: number,
    count: number,
    age: number,
    since: number,
    clock: number,
    hot: boolean,
    seated: boolean,
  ): [number, number, number] {
    const lit: [number, number, number] = [80, Kind.lamp, LIT]
    const dark: [number, number, number] = [40, Kind.dark, 0]
    // A tray on its way out puts its lamps out first, the other way from how they came on.
    if (!seated) return this.state !== 'off' && this.state !== 'fault' && age < (3 - lamp) * 0.06 ? lit : dark
    if (this.state === 'off') {
      // Switched off, it goes dark from the top tray down, a lamp at a time.
      return since < (count - 1 - tray) * 0.22 + (3 - lamp) * 0.06 ? lit : dark
    }
    if (this.state === 'fault') {
      // At a fault they all flash together, three times, which nothing healthy does, and stay dark.
      return since < 0.6 && Math.floor(since / 0.1) % 2 === 0 ? lit : dark
    }
    // One just pushed home lights them one after another.
    if (age < 0.7 + lamp * 0.1) return dark
    // Switched on, it boots from the bottom tray up, a lamp at a time; held lit while it boots,
    // and then each lamp keeps its own time.
    const booted = since - tray * 0.3 - lamp * 0.09
    if (booted < 0) return dark
    if (this.state === 'booting' || hot || booted < 1.2 || age < 1.6) return lit
    const beat = Math.floor(clock / 1.7 + hash3(tray + this.seed * 7, lamp, 3) * 7)
    return hash3(tray + this.seed * 7, lamp, beat) > 0.5 ? lit : dark
  }
}

/**
 * The small world's ride on a rack: it sits, or floats over it on a spring, turns, and is bumped
 * by what happens under it. A scene kicks it by adding to `bob` (up) or `whirl` (round).
 */
export class Rider {
  /** How it is turned and how fast; how high its underside is and how fast that is moving. */
  spin = 0.6
  whirl = 0
  ride = 0
  bob = 0
  private placed = false

  /** As it stands with everything finished. */
  settle(rest: number): void {
    this.ride = rest
    this.bob = 0
    this.placed = true
  }

  /** Plays it on: toward resting at `rest` and never under `floor`, coming to turn at `turns`. */
  step(dt: number, rest: number, floor: number, turns: number): void {
    if (!this.placed) this.settle(rest)
    for (let left = dt; left > 0; left -= 1 / 60) {
      const tick = Math.min(left, 1 / 60)
      this.bob += ((rest - this.ride) * 70 - this.bob * 8) * tick
      this.ride = Math.max(floor, this.ride + this.bob * tick)
      this.whirl += (turns - this.whirl) * (1 - Math.exp(-tick * 3))
      this.spin += this.whirl * tick
    }
  }
}

/** The ways to play, which is also which small world a server runs. */
export type Small = 'survival' | 'creative' | 'hardcore' | 'smooth' | 'create'

/**
 * The world a server runs: a block of ground with what the way to play puts on it. `at` is the
 * middle of its underside; its heading is how far it has turned.
 */
export function smallWorld(box: Box, at: Place, which: Small, clock: number): void {
  if ((at.scale ?? 1) < 0.02) return
  const part = partsAt(box, at)
  const dark = which === 'hardcore'
  part(0, 0.36, 0, 0.8, 0.72, 0.8, dark ? 40 : 70, dark ? Kind.deepslate : Kind.dirt)
  if (!dark) part(0, 0.76, 0, 0.82, 0.1, 0.82, 235, Kind.grass)
  const tree = (dx: number, dz: number) => {
    part(dx, 0.88, dz, 0.1, 0.24, 0.1, 90, Kind.log)
    part(dx, 1.12, dz, 0.3, 0.3, 0.3, 170, Kind.leaves)
  }
  if (which === 'survival') tree(0.12, -0.1)
  else if (which === 'smooth') {
    // The same, with room for more.
    tree(-0.2, -0.16)
    tree(0.2, 0.14)
  } else if (which === 'creative') {
    // Something built, with its block of gold.
    part(0, 0.86, 0, 0.5, 0.12, 0.5, 250, Kind.wool)
    part(0, 0.98, 0, 0.32, 0.12, 0.32, 150, Kind.cobble)
    part(0, 1.12, 0, 0.16, 0.16, 0.16, 80, Kind.lamp, LIT)
  } else if (which === 'hardcore') {
    // One life.
    part(0, 0.83, 0, 0.2, 0.2, 0.2, 80, Kind.lamp, LIT)
  } else {
    // A cog, turning.
    for (const quarter of [0, Math.PI / 2])
      part(0, 1.18, 0, 0.1, 0.62, 0.12, 250, Kind.planks, 0, clock * 0.9 + quarter)
    part(0, 1.18, 0, 0.16, 0.2, 0.2, 90, Kind.log, 0, clock * 0.9)
  }
}

/**
 * How far a chest's lid is thrown back, `since` seconds after it was thrown open (a little past
 * upright, and back) or let fall shut.
 */
export const lid = (open: boolean, since: number) =>
  open ? overshoot(clamp(since / 0.3)) : 1 - clamp(since / 0.15) ** 2

/** How far a lid is thrown back: as it was until the moment it is swung, and then on its way. */
export const swung = (flap: Slot, clock: number) =>
  clock < flap.at ? (flap.on ? 0 : 1) : lid(flap.on, clock - flap.at)

/**
 * A chest. `open` is how far its lid is thrown back, 0 shut to 1; `latch` lights the latch on its
 * face, which says one thing wherever it is lit: a world is in this chest.
 */
export function chest(box: Box, at: Place, open = 0, latch = false): void {
  if ((at.scale ?? 1) < 0.02) return
  const part = partsAt(box, at)
  part(0, 0.33, -0.45, 0.9, 0.66, 0.9, 128, Kind.chest)
  part(0, 0.4, 0.02, 0.14, 0.16, 0.05, latch ? 80 : 235, latch ? Kind.lamp : Kind.iron, latch ? LIT : 0)
  // The lid, hinged along its back edge.
  const angle = -0.85 * clamp(open, 0, 1.2)
  const lift = 0.12 * Math.cos(angle) - 0.45 * Math.sin(angle)
  const reach = 0.12 * Math.sin(angle) + 0.45 * Math.cos(angle)
  part(0, 0.66 + lift, -0.9 + reach, 0.9, 0.24, 0.9, 150, Kind.chest, 0, angle)
}

/**
 * A jar: a small crate with a lamp set in its face, dark until `lit`. A pack is a chest of them.
 * `at` is the middle of its underside.
 */
export function jar(box: Box, at: Place, lit: boolean): void {
  if ((at.scale ?? 1) < 0.02) return
  const part = partsAt(box, at)
  part(0, 0.25, 0, 0.5, 0.5, 0.5, 250, Kind.planks)
  part(0, 0.46, 0, 0.52, 0.08, 0.52, 90, Kind.log)
  part(0, 0.22, 0.255, 0.25, 0.25, 0.03, lit ? 80 : 40, lit ? Kind.lamp : Kind.dark, lit ? LIT : 0)
}

/** A furnace, with a fire in its mouth: `fire` is how high it burns, 0 out to 1 and a little over. */
export function furnace(box: Box, at: Place, fire: number, clock: number, seed = 0): void {
  if ((at.scale ?? 1) < 0.02) return
  const part = partsAt(box, at)
  part(0, 0.5, -0.5, 1, 1, 1, 150, Kind.cobble)
  if ((at.scale ?? 1) < 0.98) return
  part(0, 0.38, 0.02, 0.56, 0.4, 0.04, 30, Kind.dark)
  const flame =
    (0.14 + 0.1 * Math.abs(Math.sin(clock * 2.3 + seed * 1.7))) * Math.min(1, fire) +
    Math.max(0, fire - 1) * 0.26
  part(0, 0.2 + Math.min(0.36, flame) / 2, 0.04, 0.4, Math.min(0.36, flame), 0.04, 80, Kind.lamp, LIT)
}

/** Redstone on a floor, from one place to another along one of the room's axes: a dark line. */
export function wire(
  box: Box,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
  inside: number,
): void {
  const long = Math.hypot(x1 - x0, z1 - z0)
  // A line longer than two blocks is two lines.
  const pieces = Math.max(1, Math.ceil(long / 2))
  for (let n = 0; n < pieces; n++) {
    const ax = x0 + ((x1 - x0) * n) / pieces
    const az = z0 + ((z1 - z0) * n) / pieces
    const bx = x0 + ((x1 - x0) * (n + 1)) / pieces
    const bz = z0 + ((z1 - z0) * (n + 1)) / pieces
    box(
      Math.min(ax, bx) - 0.07,
      y,
      Math.min(az, bz) - 0.07,
      Math.abs(bx - ax) + 0.14,
      0.05,
      Math.abs(bz - az) + 0.14,
      40,
      Kind.dark,
      0,
      inside,
    )
  }
}

/** Something on its way along a wire: `through` is how far along the path it is, 0 to 1. */
export function pulse(
  box: Box,
  path: readonly (readonly [number, number])[],
  through: number,
  y: number,
  inside: number,
): void {
  const lengths = path.slice(1).map((to, n) => {
    const from = path[n] as readonly [number, number]
    return Math.hypot(to[0] - from[0], to[1] - from[1])
  })
  let left = through * lengths.reduce((sum, each) => sum + each, 0)
  for (let n = 0; n < lengths.length; n++) {
    const length = lengths[n] as number
    if (left <= length || n === lengths.length - 1) {
      const a = path[n] as readonly [number, number]
      const b = path[n + 1] as readonly [number, number]
      const t = clamp(left / length)
      const size = 0.18 * puff(through)
      if (size > 0.02)
        box(
          a[0] + (b[0] - a[0]) * t - size / 2,
          y + 0.03,
          a[1] + (b[1] - a[1]) * t - size / 2,
          size,
          0.1,
          size,
          80,
          Kind.lamp,
          LIT,
          inside,
        )
      return
    }
    left -= length
  }
}

/**
 * A lever on a small footing: `thrown` is how far over it is, 0 one way to 1 the other, toward
 * the piece's own side. With `cube` it stands on a cobble cube, where a hand reaches it.
 */
export function lever(box: Box, at: Place, thrown: number, cube = false): void {
  if (cube) {
    partsAt(box, at)(0, 0.3, 0, 0.6, 0.6, 0.6, 150, Kind.cobble)
    lever(box, { ...at, y: at.y + 0.6 * (at.scale ?? 1) }, thrown)
    return
  }
  const part = partsAt(box, at)
  part(0, 0.08, 0, 0.36, 0.16, 0.3, 150, Kind.cobble)
  // The stick, hinged at the footing: over to one side, and thrown across to the other.
  const angle = -0.7 + 1.4 * clamp(thrown)
  part(0.26 * Math.sin(angle), 0.16 + 0.26 * Math.cos(angle), 0, 0.09, 0.52, 0.09, 90, Kind.log, 0, 0, 0)
  part(
    0.5 * Math.sin(angle),
    0.16 + 0.5 * Math.cos(angle),
    0,
    0.16,
    0.16,
    0.16,
    thrown > 0.5 ? 80 : 60,
    thrown > 0.5 ? Kind.lamp : Kind.dark,
    thrown > 0.5 ? LIT : 0,
  )
}

/** A notice on a post: a board with a few lines written on it. */
export function notice(box: Box, at: Place): void {
  if ((at.scale ?? 1) < 0.02) return
  const part = partsAt(box, at)
  part(0, 0.45, -0.08, 0.12, 0.9, 0.12, 90, Kind.log)
  part(0, 1.25, 0, 1.1, 0.8, 0.1, 250, Kind.planks)
  for (let line = 0; line < 3; line++)
    part(line === 2 ? -0.15 : 0, 1.45 - line * 0.2, 0.06, line === 2 ? 0.5 : 0.8, 0.07, 0.02, 30, Kind.dark)
}

/**
 * A door in its frame, with a lamp over it: `open` is how far its leaf has swung in, 0 shut to 1
 * a full quarter turn, `lit` whether the lamp is on, and `knock` how hard it has just been
 * knocked on: it gives a little, and springs back.
 */
export function door(box: Box, at: Place, open: number, lit: boolean, knock = 0): void {
  const part = partsAt(box, at)
  for (const side of [-0.62, 0.62]) part(side, 1, -0.1, 0.24, 2, 0.3, 150, Kind.cobble)
  part(0, 2.14, -0.1, 1.48, 0.28, 0.3, 150, Kind.cobble)
  part(0, 2.5, -0.1, 0.4, 0.4, 0.4, lit ? 80 : 60, lit ? Kind.lamp : Kind.dark, lit ? LIT : 0)
  // The leaf, hinged down one side: it swings in, away from whoever is at it. Pale planks with
  // two bars across, so a shut door never prints like an open doorway.
  const angle = clamp(open) * (Math.PI / 2) + knock * 0.12
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const leaf = (
    along: number,
    proud: number,
    y: number,
    wide: number,
    tall: number,
    deep: number,
    tone: number,
    kind: number,
  ) =>
    part(
      -0.5 + along * cos + proud * sin,
      y,
      -0.1 - along * sin + proud * cos,
      wide,
      tall,
      deep,
      tone,
      kind,
      0,
      0,
      angle,
    )
  leaf(0.5, 0, 1, 1, 2, 0.1, 235, Kind.planks)
  for (const y of [0.55, 1.45]) leaf(0.5, 0.06, y, 0.92, 0.14, 0.03, 60, Kind.dark)
  leaf(0.84, 0.07, 1, 0.1, 0.1, 0.05, 215, Kind.iron)
}

/** A door thrown open hits its stop after this long; one swung shut hits its frame after this long. */
export const HITS = 0.2
export const SHUTS = 0.3

/**
 * How far a door's leaf gives, `age` seconds after something landed on it or it hit its frame. In,
 * back against its frame, and once more, smaller.
 */
export const given = (age: number) =>
  age < 0 || age > 0.4 ? 0 : 3 * Math.exp(-age * 12) * Math.abs(Math.sin(age * 26))

/**
 * How far a door has swung, `age` seconds after it was thrown open. It gathers speed, hits its
 * stop, bounces off it twice and settles.
 */
export function thrown(age: number): number {
  if (age < HITS) return (age / HITS) ** 2
  const first = (age - HITS) / 0.2
  if (first < 1) return 1 - 0.56 * first * (1 - first)
  const second = (age - HITS - 0.2) / 0.12
  return second < 1 ? 1 - 0.14 * second * (1 - second) : 1
}

/**
 * A pressure plate in the floor, `at` its middle: proud and dark, or pressed flush and lit.
 * `down` is how far it is pressed, 0 to 1.
 */
export function plate(box: Box, at: Place, down: number): void {
  const part = partsAt(box, at)
  const lit = down > 0.5
  const tall = 0.07 - 0.05 * clamp(down)
  part(0, 0.01, 0, 1.1, 0.02, 1.1, 40, Kind.dark)
  part(0, tall / 2, 0, 0.9, tall, 0.9, lit ? 80 : 150, lit ? Kind.lamp : Kind.iron, lit ? LIT : 0)
}

/**
 * A board on a pole, facing out: dark, for paper. `at` is the foot of the pole, the board's
 * lower edge is `foot` up, and `shake` is how hard it has just been slapped (see `slap`).
 */
export function board(box: Box, at: Place, wide: number, tall: number, foot: number, shake = 0): void {
  const part = partsAt(box, at)
  part(0, foot / 2, -0.11, 0.12, foot, 0.12, 90, Kind.log)
  part(0, foot + tall / 2, 0, wide, tall, 0.1, 60, Kind.dark, 0, shake * 0.06)
}

/** How hard a board shakes, `age` seconds after something was slapped onto it. */
export const slap = (age: number) => (age < 0 || age > 0.3 ? 0 : Math.sin(age * 42) * (1 - age / 0.3))

/**
 * Paper on a board: a pale slip or notice, never lit. It means something was written down. `x`
 * and `y` are its middle on the board's face, from the foot of the pole. `on` is seconds since
 * it was slapped on: it pops past its size and settles. `off`, once it has been taken off, is
 * seconds since: it drops to the floor and pops away.
 */
export function slip(
  box: Box,
  at: Place,
  x: number,
  y: number,
  wide: number,
  tall: number,
  on: number,
  off = -1,
): void {
  const part = partsAt(box, at)
  if (off >= 0) {
    const lands = Math.sqrt(y / 5)
    const size = 1 - windup(clamp((off - lands) / 0.2))
    if (size > 0.02)
      part(
        x,
        Math.max(0.02, y - 5 * off * off),
        0.09 + Math.min(off, lands) * 0.5,
        wide * size,
        tall * size,
        0.03,
        250,
        Kind.wool,
      )
    return
  }
  if (on < 0) return
  const size = overshoot(clamp(on / 0.2))
  part(x, y, 0.065, wide * size, tall * size, 0.03, 250, Kind.wool)
}

/** A cart for rails: a low iron tub on four wheels. Whatever rides in it stands on `CART_BED`. */
export const CART_BED = 0.42
export function cart(box: Box, at: Place): void {
  const part = partsAt(box, at)
  part(0, 0.3, 0, 1.5, 0.24, 1.7, 110, Kind.iron)
  for (const side of [-0.7, 0.7]) part(side, 0.5, 0, 0.1, 0.3, 1.7, 110, Kind.iron)
  for (const x of [-0.6, 0.6]) for (const z of [-0.55, 0.55]) part(x, 0.12, z, 0.14, 0.24, 0.3, 30, Kind.dark)
}

/** Smoke, once: three puffs that rise from a place and are spent, `age` seconds after it began. */
export function smoke(
  box: Box,
  x: number,
  y: number,
  z: number,
  age: number,
  inside: number,
  scale = 1,
): void {
  if (age <= 0 || age >= 1.4) return
  for (let n = 0; n < 3; n++) {
    const rise = clamp(age / 1.4 - n * 0.12)
    const size = (0.25 + rise * 0.4) * puff(rise) * scale
    if (size > 0.02)
      box(
        x + n * 0.15 * scale - size / 2,
        y + rise * 1.2 * scale,
        z - size / 2,
        size,
        size,
        size,
        250,
        Kind.wool,
        0,
        inside,
      )
  }
}

/** A spark: a few lit bits thrown up from a place, which fall and are spent. `age` is seconds since. */
export function spark(box: Box, x: number, y: number, z: number, age: number, inside: number): void {
  if (age <= 0 || age >= 0.4) return
  const bit = 0.13 * (1 - (age / 0.4) ** 2)
  for (let n = 0; n < 4; n++)
    box(
      x + Math.cos(n * 1.7) * 1.2 * age - bit / 2,
      y + (1.5 + (n % 2) * 1.1) * age - 6 * age * age,
      z + Math.sin(n * 1.7) * 1.2 * age - bit / 2,
      bit,
      bit,
      bit,
      80,
      Kind.lamp,
      LIT,
      inside,
    )
}
