// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The cast's side of a hand-over from one section to the next. What a section puts on the chunk
 * (the friends on the grass, a way to play, whoever typed the address, the scene in a room) is
 * not swapped for the next section's in one frame: it thins into the print's dots, and the next
 * comes out of them, the way everybody on the page arrives and goes. Scrolled back, the same
 * happens the other way. With less motion asked for it is a plain short fade.
 *
 * Not for the camera, which flies on its own spring, nor for the palette, which changes row by
 * row where the ground behind it does (Chunk.tsx).
 */
import type { RoomKey } from './chunk'
import type { Ground } from './ground'
import type { Box } from './models'

/** Seconds for what is on to thin away, and as long again for the next to come in. */
const THINS = 0.3
/** With less motion asked for: a plain short fade, and nobody moves while it plays. */
const THINS_STILL = 0.12

/** One thing handed over: what is drawn, and how much of it is there. */
class Part<T> {
  shown: T
  private solid = 1
  /** Draws through the cast's own box with everything thinner by `solid`: made once, used every frame. */
  readonly box: Box

  constructor(first: T, to: Box) {
    this.shown = first
    this.box = (x, y, z, sx, sy, sz, tone, kind, group, inside, round = 0, tipped = 0, own = 1) =>
      to(x, y, z, sx, sy, sz, tone, kind, group, inside, round, tipped, own * this.solid)
  }

  /** `by` of the way on toward `wanted`, or all of it `now`. True while it is part-way. */
  step(wanted: T, by: number, now: boolean): boolean {
    if (now) {
      this.shown = wanted
      this.solid = 1
    } else if (wanted !== this.shown) {
      this.solid = Math.max(0, this.solid - by)
      if (this.solid === 0) this.shown = wanted
    } else this.solid = Math.min(1, this.solid + by)
    return this.solid < 1
  }
}

export class Handover {
  /** A box of the cast's, whole: drawn, and what it rests on is kept under it (engine/ground.ts). */
  readonly stand: Box
  private readonly grassPart: Part<string | null>
  private readonly roomPart: Part<RoomKey | null>
  private at = -1

  constructor(put: Box, ground: Ground) {
    this.stand = (x, y, z, sx, sy, sz, tone, kind, group, inside, round, tipped, solid) => {
      if ((solid ?? 1) > 0.5) ground.rest(x, y, z, sx, sy, sz)
      put(x, y, z, sx, sy, sz, tone, kind, group, inside, round, tipped, solid)
    }
    this.grassPart = new Part<string | null>(null, this.stand)
    this.roomPart = new Part<RoomKey | null>(null, this.stand)
  }

  /** What the grass shows: the `act` of the section going, until it has thinned away, then the next one's. */
  get act(): string | null {
    return this.grassPart.shown
  }

  /** Which room's scene is drawn, the same way: only one close enough to make out who is in it. */
  get room(): RoomKey | null {
    return this.roomPart.shown
  }

  /** What the grass's cast is drawn with. */
  get grass(): Box {
    return this.grassPart.box
  }

  /** What the room's scene is drawn with. */
  get below(): Box {
    return this.roomPart.box
  }

  /**
   * A step on to `time`, in seconds, toward the section's `act` and `room`, the room only while
   * it is `seen` close enough to make out. `far` swaps the grass at once: from far off nobody on
   * it can be made out, so there is nothing to see change. True while either is part-way, and
   * the drawing has to keep up with it, with less motion asked for too.
   */
  step(
    time: number,
    act: string | null,
    room: RoomKey | null,
    seen: boolean,
    quiet: boolean,
    far: boolean,
  ): boolean {
    const by = this.at < 0 ? 1 : Math.min(0.25, Math.max(0, time - this.at)) / (quiet ? THINS_STILL : THINS)
    this.at = time
    const grass = this.grassPart.step(act, by, far)
    return this.roomPart.step(seen ? room : null, by, false) || grass
  }
}
