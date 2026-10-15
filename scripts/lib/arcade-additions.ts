// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What `arcade-world.ts` adds to the Arcade's world after the maps are placed, as console
 * commands: a copy of the falling floor's floors, out of sight, that each round puts back from,
 * and light through the hub's hall, which the map, made for Bedrock's lighting, leaves dark in
 * Java's. Not the maps (`minecraft/arcade/maps.ts`) or anything the datapack builds as a server starts.
 */
import { FLOOR_DISC, FLOOR_STORE } from '../../apps/control/src/minecraft/arcade/floor.ts'

const [x0, y0, z0] = FLOOR_DISC.from
const [x1, y1, z1] = FLOOR_DISC.to
const [dx, , dz] = FLOOR_STORE

/** Invisible light blocks in the hall's air, on a grid: only where there is air, so nothing built moves. */
const HALL = { x: [102, 254], y: [55, 70, 80, 90, 100, 113], z: [1342, 1458], every: 7 }
const lights: string[] = []
for (let x = HALL.x[0] ?? 0; x <= (HALL.x[1] ?? 0); x += HALL.every)
  for (let z = HALL.z[0] ?? 0; z <= (HALL.z[1] ?? 0); z += HALL.every)
    for (const y of HALL.y) lights.push(`setblock ${x} ${y} ${z} minecraft:light[level=15] keep`)

export const ADDITIONS: readonly string[] = [
  `forceload add ${x0} ${z0} ${x1} ${z1}`,
  `forceload add ${x0 + dx} ${z0 + dz} ${x1 + dx} ${z1 + dz}`,
  `clone ${x0} ${y0} ${z0} ${x1} ${y1} ${z1} ${x0 + dx} ${y0} ${z0 + dz}`,
]

/** Run apart from `ADDITIONS`: a light where something stands already is no failure. */
export const LIGHTS: readonly string[] = lights
