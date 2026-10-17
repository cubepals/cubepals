// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * One frame's loose parts, packed as the renderer takes them (Renderer.setMoving): people, sheep,
 * a cart on the rails, the worker underground, the chips of a dug block. Each is a box: 3 floats
 * for its low corner, 8 bytes (tone, kind, light group, its reach along x, y and z with 255 for
 * `REACH` blocks, the room it is in, and how much of it is there), and two angles for how it is
 * turned about its middle. The arrays grow when a frame has more than they hold, and are written
 * over the next frame. Not who those parts are or where they go (cast.ts, models.ts).
 */
import type { Packed } from './frame'
import { type Box, REACH } from './models'

/** A reach in blocks as its byte. */
const byte = (reach: number) => Math.min(255, Math.round((reach / REACH) * 255))

export class Loose implements Packed {
  positions = new Float32Array(3 * 64)
  data = new Uint8Array(8 * 64)
  turns = new Float32Array(2 * 64)
  count = 0

  /** Starts a frame afresh: nothing is put yet. */
  clear(): void {
    this.count = 0
  }

  private grow(): void {
    const positions = new Float32Array(this.positions.length * 2)
    positions.set(this.positions)
    this.positions = positions
    const data = new Uint8Array(this.data.length * 2)
    data.set(this.data)
    this.data = data
    const turns = new Float32Array(this.turns.length * 2)
    turns.set(this.turns)
    this.turns = turns
  }

  /** Puts one box in this frame. */
  readonly put: Box = (x, y, z, sx, sy, sz, tone, kind, group, inside, round = 0, tipped = 0, solid = 1) => {
    if ((this.count + 1) * 3 > this.positions.length) this.grow()
    const n = this.count
    this.turns[n * 2] = round
    this.turns[n * 2 + 1] = tipped
    this.positions.set([x, y, z], n * 3)
    this.data.set(
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
      n * 8,
    )
    this.count = n + 1
  }
}
