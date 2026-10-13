// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The sheep's grass, and how a sheep eats it. Each patch a sheep keeps to (engine/cast.ts) has a
 * tuft of tall grass in front of every corner it stops at, and one in its middle: a few thin
 * blades in the chunk's own leaf green. Stopped at a corner, a sheep looks about a while, lowers
 * its head to the tuft, chews, and lifts it again with a small shake. The tuft it ate from is
 * shorter for a while after, and grows back.
 *
 * No two sheep eat at once: one about to lower its head waits until the other has done. Nothing
 * here is made on a frame; the tufts are laid out once, and each head is worked out into the same
 * few numbers.
 *
 * Not where a sheep walks, nor its body: those are the cast's and the model's (engine/models.ts).
 */
import { clamp, ease } from './curves'
import type { Box } from './models'
import type { Spot } from './walk'
import { hash3, Kind } from './world'

/** Seconds: lowering the head, chewing, lifting it, and the shake that ends it. */
const LOWERS = 0.7
const CHEWS = 2.6
const LIFTS = 0.7
const SHAKES = 0.9
const EATS = LOWERS + CHEWS + LIFTS * 0.6 + SHAKES
/** Seconds of looking about after stopping before the head goes down: at least this, up to twice it. */
const LOOKS = 1.4
/** How far the head turns each way in the shake, in radians, and how many times it goes to and fro. */
const SHAKE = 0.24
const SHAKE_TIMES = 2.5
/** How much shorter an eaten tuft is, and the seconds it takes to grow back. */
const BITE = 0.4
const REGROWS = 25
/** The blades of one tuft: where across it each stands, in blocks, and how tall. */
const BLADES: readonly (readonly [dx: number, dz: number, tall: number])[] = [
  [-0.14, -0.03, 0.22],
  [-0.05, 0.1, 0.3],
  [0.02, -0.07, 0.36],
  [0.1, 0.06, 0.26],
  [0.15, -0.12, 0.17],
]
/** How far in front of a stopped sheep's middle its tuft stands: where its head comes down. */
const REACH = 0.66
/** How thin a blade is, and its tone: a little darker than the grass, so it shows on it. */
const BLADE = 0.07
const TONE = 185

export class Pasture {
  /** Every blade: its low corner across and along the chunk, its height, and the tuft it is in. */
  private readonly blades: Float32Array
  /** How much of each tuft has been eaten, 0 to 1. It grows back. */
  private readonly eaten: Float32Array
  /** Where each sheep's tufts begin: a patch's corners in order, then its middle. */
  private readonly first: Int32Array
  /** For each sheep: seconds into its round at the corner it stopped at, below 0 while it walks. */
  private readonly round: Float32Array
  /** When in that round its head goes down, and the tuft it eats from. */
  private readonly goesDown: Float32Array
  private readonly tuft: Int32Array
  private clock = 0
  /** Until when some sheep has its head down, or is still lifting it. */
  private busyUntil = -1
  /** The shake of the head last worked out, in radians, and whether that sheep is eating. */
  shake = 0
  eating = false

  constructor(patches: readonly (readonly Spot[])[]) {
    const middles: number[] = []
    this.first = new Int32Array(patches.length)
    patches.forEach((patch, p) => {
      this.first[p] = middles.length / 2
      patch.forEach((corner, c) => {
        // A sheep comes to a corner from the corner before, facing the way it walked.
        const from = patch[(c + patch.length - 1) % patch.length] as Spot
        const long = Math.hypot(corner[0] - from[0], corner[1] - from[1]) || 1
        middles.push(
          corner[0] + ((corner[0] - from[0]) / long) * REACH,
          corner[1] + ((corner[1] - from[1]) / long) * REACH,
        )
      })
      middles.push(
        patch.reduce((sum, spot) => sum + spot[0], 0) / patch.length,
        patch.reduce((sum, spot) => sum + spot[1], 0) / patch.length,
      )
    })
    const tufts = middles.length / 2
    this.eaten = new Float32Array(tufts)
    this.blades = new Float32Array(tufts * BLADES.length * 4)
    for (let n = 0; n < tufts; n++) {
      // Each tuft is turned its own way and grown its own height, so no two read as one stamp.
      const turned = hash3(n, 3, 11) > 0.5
      const scale = 0.85 + hash3(n, 7, 2) * 0.3
      BLADES.forEach(([dx, dz, tall], b) => {
        const at = (n * BLADES.length + b) * 4
        this.blades[at] = (middles[n * 2] as number) + (turned ? dz : dx) - BLADE / 2
        this.blades[at + 1] = (middles[n * 2 + 1] as number) + (turned ? dx : dz) - BLADE / 2
        this.blades[at + 2] = tall * scale
        this.blades[at + 3] = n
      })
    }
    this.round = new Float32Array(patches.length).fill(-1)
    this.goesDown = new Float32Array(patches.length)
    this.tuft = new Int32Array(patches.length)
  }

  /** The tufts as they stand, `dt` seconds on from the last time, for their growing back. */
  draw(dt: number, box: Box): void {
    this.clock += dt
    for (let n = 0; n < this.eaten.length; n++)
      this.eaten[n] = Math.max(0, (this.eaten[n] as number) - dt / REGROWS)
    for (let at = 0; at < this.blades.length; at += 4) {
      const tall =
        (this.blades[at + 2] as number) * (1 - BITE * ease(this.eaten[this.blades[at + 3] as number] ?? 0))
      box(
        this.blades[at] as number,
        1,
        this.blades[at + 1] as number,
        BLADE,
        tall,
        BLADE,
        TONE,
        Kind.leaves,
        0,
        0,
      )
    }
  }

  /**
   * Sheep `index`'s head, `dt` seconds on: `stop` is the corner of its patch it has stopped at,
   * or -1 while it walks. Returns how far down the head is, 0 up to 1 at the grass, chewing and
   * all; leaves its shake in `shake`, and in `eating` whether it is part-way through a mouthful,
   * which it finishes before it sets off.
   */
  head(index: number, stop: number, dt: number): number {
    this.shake = 0
    const was = this.round[index] as number
    const mid =
      was >= 0 && was > (this.goesDown[index] as number) && was < (this.goesDown[index] as number) + EATS
    if (stop < 0 && !mid) {
      this.round[index] = -1
      this.eating = false
      return 0
    }
    if (was < 0) {
      // Just stopped: it looks about a while first, a different while each time.
      this.goesDown[index] = LOOKS * (1 + hash3(index, stop, Math.floor(this.clock)))
      this.tuft[index] = (this.first[index] as number) + stop
    }
    const round = Math.max(0, was) + dt
    this.round[index] = round
    // About to lower its head while another sheep's is down: it waits for that one to have done.
    if (was < (this.goesDown[index] as number) && round >= (this.goesDown[index] as number)) {
      if (this.clock < this.busyUntil) this.goesDown[index] = round + (this.busyUntil - this.clock) + 0.5
      else this.busyUntil = this.clock + EATS
    }
    let t = round - (this.goesDown[index] as number)
    this.eating = t > 0 && t < EATS
    if (!this.eating) return 0
    if (t < LOWERS) return ease(t / LOWERS)
    t -= LOWERS
    if (t < CHEWS) {
      // Chewing: the head bobs a little at the grass, and the tuft goes down as it is eaten.
      const tuft = this.tuft[index] as number
      this.eaten[tuft] = Math.max(this.eaten[tuft] as number, t / CHEWS)
      return 1 - 0.08 * Math.sin((t / CHEWS) * Math.PI * 7) ** 2
    }
    t -= CHEWS
    // Lifted, and as it comes up a small shake, to and fro and settling.
    const shaking = clamp((t - LIFTS * 0.6) / SHAKES)
    this.shake = SHAKE * Math.sin(shaking * Math.PI * 2 * SHAKE_TIMES) * Math.sin(shaking * Math.PI)
    return 1 - ease(clamp(t / LIFTS))
  }
}
