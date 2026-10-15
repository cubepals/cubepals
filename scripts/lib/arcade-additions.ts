// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What `arcade-world.ts` adds to the Arcade's world after the maps are placed, as console
 * commands: a copy of the falling floor's floors, out of sight, that each round puts back from. Not
 * the maps (`minecraft/arcade/maps.ts`), the hub's look (`arcade-hall.ts`, `arcade-house.ts`) or
 * anything the datapack builds as a server starts.
 */
import { FLOOR_DISC, FLOOR_STORE } from '../../apps/control/src/minecraft/arcade/floor.ts'

const [x0, y0, z0] = FLOOR_DISC.from
const [x1, y1, z1] = FLOOR_DISC.to
const [dx, , dz] = FLOOR_STORE

export const ADDITIONS: readonly string[] = [
  `forceload add ${x0} ${z0} ${x1} ${z1}`,
  `forceload add ${x0 + dx} ${z0 + dz} ${x1 + dx} ${z1 + dz}`,
  `clone ${x0} ${y0} ${z0} ${x1} ${y1} ${z1} ${x0 + dx} ${y0} ${z0 + dz}`,
]
