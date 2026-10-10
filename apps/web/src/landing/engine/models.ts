// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The page's models: people, the dead, a worker, a sheep. Each is a handful of boxes set out the
 * way the game builds its own figures (a head, a body, two arms and two legs, to the game's own
 * proportions: two blocks tall), and each is jointed the way the game's are: an arm swings from
 * its shoulder and a leg from its hip, a head turns on its neck, and the whole figure turns to
 * face any way round. What is carried is carried in a hand, and follows it.
 *
 * A part is one box, turned about its own middle by two angles (engine/gl.ts): tipped forward or
 * back, and then turned round. Everything here is worked out in the figure's own terms (x to its
 * side, y up, z the way it faces) and set into the world last.
 */

import { ease } from './curves'
import { hash3, Kind } from './world'

/**
 * Draws one loose box: its low corner before any turning, how far it reaches each way, what it is
 * made of, how it is turned about its middle (round, then tipped), if it is, and how much of it
 * is there (1 unless it is coming or going: it thins to scattered dots, and to nothing).
 */
export type Box = (
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  tone: number,
  kind: number,
  group: number,
  inside: number,
  round?: number,
  tipped?: number,
  solid?: number,
) => void

export interface Stance {
  /** Where the feet are: the middle of the figure, on the ground. */
  x: number
  y: number
  z: number
  /** Which way it faces, in radians: 0 is along z, a quarter turn is along x. */
  heading: number
  /** Where in a step it is, in radians, and how long the step: 0 standing, 1 walking. */
  phase: number
  stride: number
  /** The room it is in, by that room's light switch; 0 out of doors. */
  inside: number
  /** How much of it is there yet, 0 to 1: it grows from its feet as it arrives. All of it, unless said. */
  grow?: number
  /** Seconds of its own, for someone standing: now and then they look somewhere else. */
  life?: number
}

/** What somebody looks like: each tone is how much light the part gives back, 0 ink to 255 paper. */
export interface Skin {
  skin: number
  eyes: number
  /** Hair, and how it is worn; none at all for the dead and under a helmet. */
  hair?: number
  style?: 'short' | 'long' | 'cap'
  /** A cap's own tone, where one is worn. */
  cap?: number
  shirt: number
  /** Sleeves to the wrist, or to above the elbow. */
  sleeves: boolean
  trousers: number
  shoes: number
  /** A light switch for the lamp on a helmet, for whoever wears one. */
  helmet?: number
}

/** Something held in a hand. */
type Tool = 'torch' | 'axe' | 'pick' | 'hammer' | 'rod'

/** What somebody is doing with themselves just now. Angles are radians. */
export interface Pose {
  /**
   * How far each arm is swung from hanging: 0 at the side, a quarter turn back (negative) straight
   * out in front, half a turn overhead. `tool` is the arm that holds things. Left to swing with
   * the walk, unless said.
   */
  tool?: number
  other?: number
  /** What the tool arm's hand holds, and the light switch for it if it glows. */
  hold?: Tool
  glow?: number
  /**
   * Something carried in both hands: its tone and what it is made of. It goes where the hands go,
   * and `heft` is how much of it is there yet, 0 to 1: it is taken up and set down, not switched.
   */
  load?: readonly [number, number]
  heft?: number
  /** The head turned this far to one side, and tipped this far down. */
  gaze?: number
  nod?: number
}

/** The friends who join, each their own person. */
export const MOSS: Skin = {
  skin: 250,
  eyes: 30,
  hair: 30,
  style: 'short',
  shirt: 150,
  sleeves: true,
  trousers: 60,
  shoes: 30,
}
export const KAI: Skin = {
  skin: 225,
  eyes: 30,
  hair: 30,
  style: 'cap',
  cap: 70,
  shirt: 250,
  sleeves: false,
  trousers: 105,
  shoes: 40,
}
export const NOOR: Skin = {
  skin: 250,
  eyes: 30,
  hair: 105,
  style: 'long',
  shirt: 40,
  sleeves: true,
  trousers: 220,
  shoes: 40,
}
/** One of the dead: grey all over, in what is left of a shirt. */
export const DEAD: Skin = { skin: 150, eyes: 20, shirt: 96, sleeves: false, trousers: 70, shoes: 70 }
/** The one who does the work underground: pale overalls and a lamp on the helmet. */
export const WORKER: Skin = { skin: 250, eyes: 30, shirt: 225, sleeves: true, trousers: 190, shoes: 60 }

const TURN = Math.PI * 2
const QUARTER = Math.PI / 2

/**
 * How far an arm is raised through one blow, 0 to 1, by where in the blow it is (radians, a full
 * turn a blow): drawn back slowly, brought down fast, and then a rest before the next.
 */
export function blowOf(phase: number): number {
  const t = (((phase / TURN) % 1) + 1) % 1
  if (t < 0.5) return ease(t / 0.5)
  if (t < 0.64) return 1 - ease((t - 0.5) / 0.14)
  return 0
}

/** The arm for a blow that is this far raised: low in front at rest, up and back when drawn. */
export const strikeArm = (raised: number) => -0.5 - raised * 2.0

/** What each tool is: its handle, how it sits in the hand, and the head on the end of it. */
const TOOLS: Record<
  Tool,
  {
    long: number
    thick: number
    /** How far it is tipped from the arm: a quarter turn stands it upright in an arm held out. */
    tilt: number
    tone: number
    kind: number
    /** The head at the far end: how wide, how tall, how deep, how far forward of the handle. */
    head?: readonly [number, number, number, number]
  }
> = {
  torch: { long: 0.5, thick: 0.1, tilt: QUARTER, tone: 255, kind: Kind.torch },
  axe: { long: 0.62, thick: 0.07, tilt: QUARTER, tone: 90, kind: Kind.log, head: [0.07, 0.2, 0.26, 0.12] },
  pick: { long: 0.66, thick: 0.07, tilt: QUARTER, tone: 90, kind: Kind.log, head: [0.07, 0.1, 0.52, 0] },
  hammer: { long: 0.54, thick: 0.08, tilt: QUARTER, tone: 90, kind: Kind.log, head: [0.16, 0.2, 0.3, 0] },
  rod: { long: 1.9, thick: 0.06, tilt: QUARTER + 0.72, tone: 60, kind: Kind.log },
}

/**
 * A figure, two blocks tall. Returns where the far end of what it holds is, in the world, if it
 * holds anything: a fishing line hangs from there.
 */
export function figure(box: Box, at: Stance, look: Skin, pose: Pose = {}): [number, number, number] | null {
  const grow = Math.min(1, Math.max(0, at.grow ?? 1))
  if (grow < 0.02) return null
  const sinH = Math.sin(at.heading)
  const cosH = Math.cos(at.heading)
  /** A place in the figure's own terms, as a place in the world. */
  const world = (lx: number, ly: number, lz: number): [number, number, number] => [
    at.x + (lx * cosH + lz * sinH) * grow,
    at.y + ly * grow,
    at.z + (-lx * sinH + lz * cosH) * grow,
  ]
  /**
   * One box of the figure: the joint it hangs from, where its middle is from that joint before
   * any turning, its size, how far it is tipped about the joint, and how far turned round on it.
   */
  const part = (
    px: number,
    py: number,
    pz: number,
    ox: number,
    oy: number,
    oz: number,
    wide: number,
    tall: number,
    deep: number,
    tipped: number,
    round: number,
    tone: number,
    kind: number = Kind.planks,
    group = 0,
  ): void => {
    const ct = Math.cos(tipped)
    const st = Math.sin(tipped)
    let x = ox
    const y = oy * ct - oz * st
    let z = oy * st + oz * ct
    if (round !== 0) {
      const cr = Math.cos(round)
      const sr = Math.sin(round)
      const turned = x * cr + z * sr
      z = -x * sr + z * cr
      x = turned
    }
    const [wx, wy, wz] = world(px + x, py + y, pz + z)
    const sx = wide * grow
    const sy = tall * grow
    const sz = deep * grow
    box(
      wx - sx / 2,
      wy - sy / 2,
      wz - sz / 2,
      sx,
      sy,
      sz,
      tone,
      kind,
      group,
      at.inside,
      at.heading + round,
      tipped,
    )
  }

  const swing = Math.sin(at.phase) * at.stride

  // Legs, from the hip: one forward as the other goes back. A shoe on each.
  for (const side of [-1, 1]) {
    const tipped = -swing * 0.62 * side
    part(side * 0.13, 0.72, 0, 0, -0.3, 0, 0.24, 0.6, 0.26, tipped, 0, look.trousers)
    part(side * 0.13, 0.72, 0, 0, -0.66, 0.02, 0.25, 0.12, 0.3, tipped, 0, look.shoes)
  }
  part(0, 0.72, 0, 0, 0.36, 0, 0.5, 0.72, 0.28, 0, 0, look.shirt)

  // Arms, from the shoulder: against the legs when walking, or wherever they have been put.
  const sleeve = look.sleeves ? 0.58 : 0.26
  let handY = 0
  let handZ = 0
  for (const side of [-1, 1]) {
    const set = side > 0 ? pose.tool : pose.other
    const tipped = set ?? swing * 0.55 * side
    part(side * 0.36, 1.38, 0, 0, 0.06 - sleeve / 2, 0, 0.21, sleeve, 0.23, tipped, 0, look.shirt)
    part(
      side * 0.36,
      1.38,
      0,
      0,
      0.06 - sleeve - (0.72 - sleeve) / 2,
      0,
      0.2,
      0.72 - sleeve,
      0.22,
      tipped,
      0,
      look.skin,
    )
    if (side > 0) {
      // Where the tool arm's hand is, in the figure's own terms: most of the way down the arm.
      handY = 1.38 - 0.62 * Math.cos(tipped)
      handZ = -0.62 * Math.sin(tipped)
    }
  }

  // The head, on the neck: it turns to look, and tips. A face, and hair or a hat over it.
  // Someone standing is not a statue, and not a pendulum either: every few seconds they look
  // somewhere else, turn their head there, and hold it.
  let gaze = pose.gaze ?? 0
  if (pose.gaze === undefined && at.life !== undefined) {
    const beat = at.life / 3.7
    const turn = Math.floor(beat)
    const look = (n: number) => (hash3(n, 7, 1) - 0.5) * 0.6
    // Less of it the more they are walking: a head doesn't snap forward as the first step is taken.
    const still = 1 - Math.min(1, at.stride * 3)
    gaze = (look(turn - 1) + (look(turn) - look(turn - 1)) * ease(Math.min(1, (beat - turn) / 0.11))) * still
  }
  const nod = pose.nod ?? 0
  const head = (
    ox: number,
    oy: number,
    oz: number,
    wide: number,
    tall: number,
    deep: number,
    tone: number,
    kind: number = Kind.planks,
    group = 0,
  ) => part(0, 1.44, 0, ox, oy, oz, wide, tall, deep, nod, gaze, tone, kind, group)
  head(0, 0.25, 0, 0.5, 0.5, 0.5, look.skin)
  for (const side of [-0.12, 0.12]) head(side, 0.21, 0.256, 0.1, 0.1, 0.03, look.eyes)
  if (look.helmet) {
    head(0, 0.47, 0, 0.58, 0.14, 0.58, 36)
    head(0, 0.36, 0.3, 0.18, 0.16, 0.1, 255, Kind.torch, look.helmet)
  } else if (look.hair !== undefined) {
    if (look.style === 'cap') {
      // A cap with a peak, and a little hair showing under it at the back.
      head(0, 0.47, 0, 0.56, 0.12, 0.56, look.cap ?? look.hair)
      head(0, 0.43, 0.37, 0.5, 0.05, 0.2, look.cap ?? look.hair)
      head(0, 0.27, -0.255, 0.54, 0.26, 0.05, look.hair)
    } else {
      head(0, 0.485, 0, 0.54, 0.07, 0.54, look.hair)
      head(0, 0.41, 0.25, 0.54, 0.1, 0.05, look.hair)
      if (look.style === 'long') {
        // Down past the shoulders at the back, and over the ears.
        head(0, 0.16, -0.26, 0.56, 0.68, 0.07, look.hair)
        for (const side of [-0.265, 0.265]) head(side, 0.24, -0.06, 0.05, 0.42, 0.4, look.hair)
      } else head(0, 0.3, -0.25, 0.54, 0.34, 0.05, look.hair)
    }
  }

  // Something carried in both hands goes where the hands are.
  if (pose.load) {
    const size = 0.6 * Math.min(1, Math.max(0, pose.heft ?? 1))
    if (size > 0.02)
      part(0, handY + size / 2, handZ, 0, 0, 0, size, size, size, 0, 0, pose.load[0], pose.load[1])
  }
  // Something held is held in the tool arm's hand, and turns with that arm.
  if (!pose.hold) return null
  const tool = TOOLS[pose.hold]
  const arm = pose.tool ?? swing * 0.55
  const tipped = arm + tool.tilt
  const grip = 0.12
  part(
    0.36,
    handY,
    handZ + 0.02,
    0,
    tool.long / 2 - grip,
    0,
    tool.thick,
    tool.long,
    tool.thick,
    tipped,
    0,
    tool.tone,
    tool.kind,
    pose.glow ?? 0,
  )
  if (tool.head) {
    const [wide, tall, deep, forward] = tool.head
    part(
      0.36,
      handY,
      handZ + 0.02,
      0,
      tool.long - grip - tall / 2,
      forward,
      wide,
      tall,
      deep,
      tipped,
      0,
      235,
      Kind.iron,
    )
  }
  // Its far end, for whatever hangs from it.
  const reach = tool.long - grip
  return world(0.36, handY + reach * Math.cos(tipped), handZ + 0.02 + reach * Math.sin(tipped))
}

/** A sheep: a woolly box on four legs, with a head it lowers to graze (0 up, 1 down). */
export function sheep(box: Box, at: Stance, grazing: number): void {
  const sinH = Math.sin(at.heading)
  const cosH = Math.cos(at.heading)
  const part = (
    px: number,
    py: number,
    pz: number,
    oy: number,
    oz: number,
    wide: number,
    tall: number,
    deep: number,
    tipped: number,
    tone: number,
    kind: number,
  ) => {
    const ct = Math.cos(tipped)
    const st = Math.sin(tipped)
    const ly = py + oy * ct - oz * st
    const lz = pz + oy * st + oz * ct
    const wx = at.x + px * cosH + lz * sinH
    const wz = at.z - px * sinH + lz * cosH
    box(
      wx - wide / 2,
      at.y + ly - tall / 2,
      wz - deep / 2,
      wide,
      tall,
      deep,
      tone,
      kind,
      0,
      at.inside,
      at.heading,
      tipped,
    )
  }
  const swing = Math.sin(at.phase) * at.stride
  for (const [x, z, way] of [
    [-0.17, 0.28, 1],
    [0.17, 0.28, -1],
    [-0.17, -0.28, -1],
    [0.17, -0.28, 1],
  ] as const)
    part(x, 0.36, z, -0.18, 0, 0.16, 0.36, 0.16, swing * way * 0.5, 60, Kind.planks)
  part(0, 0.62, 0, 0, 0, 0.62, 0.56, 0.94, 0, 252, Kind.wool)
  // The head, from the neck at the front of the body: it comes down to the grass.
  part(0, 0.7, 0.42, 0, 0.2, 0.36, 0.36, 0.34, grazing * 0.95, 130, Kind.planks)
}

/** A box-drawer that draws everything a little thinner: for a whole scene coming or going at once. */
export function veiled(box: Box, solid: number): Box {
  if (solid >= 0.999) return box
  return (x, y, z, sx, sy, sz, tone, kind, group, inside, round = 0, tipped = 0, own = 1) =>
    box(x, y, z, sx, sy, sz, tone, kind, group, inside, round, tipped, own * solid)
}

/** A cube set down about its own middle: for a block arriving, a chip, a puff of smoke. */
export function cube(
  box: Box,
  x: number,
  y: number,
  z: number,
  size: number,
  tone: number,
  kind: number,
  group = 0,
  inside = 0,
  solid = 1,
): void {
  box(x - size / 2, y - size / 2, z - size / 2, size, size, size, tone, kind, group, inside, 0, 0, solid)
}
