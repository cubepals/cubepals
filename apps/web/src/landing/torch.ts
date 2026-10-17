// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The one light at a moment that isn't part of the world (Chunk.tsx hands it to the renderer as
 * `torch`): a torch somebody carries, else the server's own light in the vault, else a room's
 * server, else the lamp by the door at night. Not the placed lamps, which are baked (bake.ts).
 */
import { CELLAR, HOME } from './engine/chunk'

/** Where a light is, how far it reaches (blocks), how bright, and what it lights (out of doors, or one room). */
export type Torch = [number, number, number, number, number, number]

/** The lamp on its post by the door (chunk.ts), as a light that throws warm on the door and the path. */
const DOOR: Torch = [9.5, 3.2, 6.5, 5.5, 2.5, HOME]

interface Lights {
  /** A carried torch, and how far it is lit, 0 to 1. */
  torch: readonly [number, number, number] | null
  glowing: number
  /** The vault's server light and how far the vault is lit. */
  glow: readonly [number, number, number, number] | null
  vault: number
  /** A room's server light, when the camera is in that room. */
  lamp: ArrayLike<number> | null
  /** How far it is night on the grass, 0 to 1, while the grass is in view; 0 when it isn't. */
  night: number
}

/** Writes the light of the moment into `out` and returns it, or null when there is none. */
export function torchOf(out: Torch, at: Lights): Torch | null {
  if (at.torch && at.glowing > 0) {
    out.splice(0, 6, at.torch[0], at.torch[1], at.torch[2], 6, at.glowing * 6, HOME)
    return out
  }
  if (at.glow && at.vault > 0.02) {
    out.splice(0, 6, at.glow[0], at.glow[1], at.glow[2], at.glow[3], at.vault * 0.8, CELLAR)
    return out
  }
  if (at.lamp) {
    for (let n = 0; n < 6; n++) out[n] = at.lamp[n] as number
    return out
  }
  if (at.night > 0.02) {
    out.splice(0, 6, ...DOOR)
    out[4] = DOOR[4] * at.night
    return out
  }
  return null
}
