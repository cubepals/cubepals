// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hub's hall in Cubepals' look, as console commands `arcade-world.ts` runs once the maps are
 * placed: the published hall's blocks swapped, one for another, for the site's sand, paper, ink
 * and warm yellow, so its shape and its cabinets stay as built; light through it, which the map,
 * made for Bedrock's lighting, leaves dark in Java's; and a doorway at the end of the west
 * corridor, onto the stairs up to the house (`arcade-house.ts`). Not the brand (`arcade-brand.ts`).
 *
 * Only whole blocks are swapped: `fill` can't keep a stair's or slab's facing, so those keep their
 * stone. Concrete, never powder, which would fall. The cabinets keep their colours; the balcony's
 * four domes and the wall under it, which carry no game, take the palette too.
 */
import { ARCADE_MAPS } from '../../apps/control/src/minecraft/arcade/maps.ts'

const hall = ARCADE_MAPS.find((map) => map.key === 'lobby')
if (hall === undefined) throw new Error('No hub map')
const [x0, y0, z0] = hall.from
const [x1, y1, z1] = hall.to

type Box = readonly [readonly [number, number, number], readonly [number, number, number]]

interface Swap {
  was: string
  now: string
  /** The heights it is held to, in the whole hall. */
  ys?: [number, number]
  /** The part of the hall it is held to, instead. */
  within?: Box
}

/** The balcony's four glass domes: the wall behind them, and the rings at their feet and tops. */
const DOME_BACKS: Box = [
  [110, 83, 1451],
  [250, 107, 1451],
]
const DOME_RINGS: readonly Box[] = [
  [
    [110, 80, 1434],
    [250, 82, 1450],
  ],
  [
    [110, 108, 1434],
    [250, 109, 1450],
  ],
]
/** The wall under the balcony, facing the hall's floor, and the display case's carpet behind it. */
const UNDER_BALCONY: Box = [
  [105, 51, 1418],
  [250, 77, 1452],
]

/** The colours on the domes that aren't Cubepals': their backs, their patterns and their rings. */
const DOMES = ['red', 'lime', 'green', 'cyan', 'purple', 'orange', 'light_gray', 'magenta', 'yellow']
const ART = ['light_blue', 'lime', 'red', 'cyan', 'purple', 'orange', 'green']
const RINGS = ['red', 'lime', 'green', 'cyan', 'purple', 'orange', 'magenta']

/**
 * Each swap, in order, and the heights it is held to, where a block means one thing there and
 * another elsewhere: black concrete is the ceiling only up top, and black terracotta the floor only
 * at the floor. Chosen by eye against the landing page: the walls sand, the inside faces paper, the
 * ceiling paper, the floor light wood, the trims yellow and ink.
 */
const SWAPS: ReadonlyArray<Swap> = [
  { was: 'black_terracotta', now: 'birch_planks', ys: [51, 51] },
  { was: 'gray_concrete', now: 'white_concrete' },
  { was: 'blue_concrete', now: 'smooth_sandstone' },
  { was: 'gray_wool', now: 'smooth_sandstone' },
  { was: 'black_concrete', now: 'smooth_quartz', ys: [113, y1] },
  { was: 'light_blue_concrete', now: 'yellow_concrete' },
  { was: 'dark_prismarine', now: 'black_concrete' },
  { was: 'purple_stained_glass', now: 'yellow_stained_glass' },
  { was: 'light_blue_stained_glass', now: 'yellow_stained_glass' },
  { was: 'red_stained_glass', now: 'yellow_stained_glass' },
  // The domes: each back wall sand, its pattern warm yellow on it, and its rings warm yellow.
  ...DOMES.map((colour) => ({ was: `${colour}_concrete`, now: 'smooth_sandstone', within: DOME_BACKS })),
  ...ART.map((colour) => ({ was: `${colour}_wool`, now: 'yellow_wool', within: DOME_BACKS })),
  ...DOME_RINGS.flatMap((ring) =>
    RINGS.map((colour) => ({
      was: `${colour}_concrete`,
      now: 'yellow_concrete',
      within: ring,
    })),
  ),
  // Under the balcony: the orange wall sand, its flecks sandstone, the case's carpet warm yellow.
  { was: 'orange_concrete', now: 'smooth_sandstone', within: UNDER_BALCONY },
  { was: 'orange_wool', now: 'sandstone', within: UNDER_BALCONY },
  { was: 'orange_terracotta', now: 'smooth_sandstone', within: UNDER_BALCONY },
  { was: 'orange_carpet', now: 'yellow_carpet', within: UNDER_BALCONY },
]

/** Invisible light blocks in the hall's air, on a grid: only where there is air, so nothing built moves. */
const LIGHT = { x: [102, 254], y: [55, 70, 80, 90, 100, 113], z: [1342, 1455], every: 7 }

const lights: string[] = []
for (let x = LIGHT.x[0] ?? 0; x <= (LIGHT.x[1] ?? 0); x += LIGHT.every)
  for (let z = LIGHT.z[0] ?? 0; z <= (LIGHT.z[1] ?? 0); z += LIGHT.every)
    for (const y of LIGHT.y) lights.push(`setblock ${x} ${y} ${z} minecraft:light[level=15] keep`)

/**
 * The west corridor's end, three blocks of wall, opened three wide and three high onto the stairs
 * up to the house.
 */
export const DOORWAY = { from: [137, 78, 1454], to: [139, 80, 1456] } as const

export const HALL_COMMANDS: readonly string[] = [
  ...SWAPS.map(({ was, now, ys, within }) => {
    const [from, to] = within ?? [
      [x0, ys?.[0] ?? y0, z0],
      [x1, ys?.[1] ?? y1, z1],
    ]
    return `fill ${from.join(' ')} ${to.join(' ')} minecraft:${now} replace minecraft:${was}`
  }),
  `fill ${DOORWAY.from.join(' ')} ${DOORWAY.to.join(' ')} minecraft:air`,
  // The corridor's floor stops three blocks short of its end wall: floored to the doorway, in sand.
  `fill ${DOORWAY.from[0]} ${DOORWAY.from[1] - 1} ${DOORWAY.from[2] - 3} ${DOORWAY.to[0]} ${DOORWAY.from[1] - 1} ${DOORWAY.from[2] - 1} minecraft:smooth_sandstone keep`,
]

/** Run apart from the rest: a light where something stands already is no failure. */
export const HALL_LIGHTS: readonly string[] = lights
