// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * That nothing Cubepals puts up on its own servers stands where players play: no sign, its frame
 * or lights, no label, marker or badge, and no sign block a datapack sets, in the room players have
 * (`play-space.json.gz`, which `play-space.ts` works out from the worlds): the courses, their jumps
 * and the air over them, the paths and floors, the arenas, the pit, and every spawn and arrival.
 * What lies flat on a wall, within a tenth of a block of it, is on the wall, not in the room before
 * it, as a picture is.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Label } from '../apps/control/src/minecraft/arcade/datapack.ts'
import { HUB_MARKERS } from '../apps/control/src/minecraft/arcade/hub.ts'
import { markerRoom, type Room, roomOf, wallOf } from '../apps/control/src/minecraft/arcade/label-space.ts'
import { ARCADE_WORLD } from '../apps/control/src/minecraft/arcade/maps.ts'
import { PARKOUR_FINISHES } from '../apps/control/src/minecraft/arcade/parkour.ts'
import { signExtent } from '../apps/control/src/minecraft/arcade/signs.ts'
import { ARCADE_FILES, ARCADE_LABELS, ARCADE_SIGNS } from '../apps/control/src/minecraft/arcade.ts'
import {
  BRAND_SIGN,
  EXIT_MARKER,
  FINISH,
  WAITING_FILES,
} from '../apps/control/src/minecraft/duels-waiting.ts'
import { marqueeExtent } from '../apps/control/src/minecraft/marquee.ts'
import type { RoomBox } from './lib/play-reach.ts'

type Point = readonly [number, number, number]

const SPACE = JSON.parse(
  gunzipSync(readFileSync(join(import.meta.dir, 'play-space.json.gz'))).toString(),
) as {
  arcade: { world: string } & Record<string, RoomBox[]>
  duels: RoomBox[]
}

/** Something Cubepals put up: what it is, and the box it takes. */
interface Thing {
  what: string
  from: Point
  to: Point
}

/** A shown thing's box, or none if it lies flat on a wall. */
function shown(what: string, room: Room): Thing[] {
  if (wallOf(room) !== null) return []
  const [x, y, z] = room.at
  const half = room.width / 2
  const flat = room.flat
  const [spanX, spanZ] =
    flat === undefined
      ? [half, half]
      : flat.facing === 'north' || flat.facing === 'south'
        ? [half, flat.depth / 2]
        : [flat.depth / 2, half]
  return [{ what, from: [x - spanX, y, z - spanZ], to: [x + spanX, y + room.height, z + spanZ] }]
}

const labelText = (label: Label) =>
  label.text
    .map((run) => run.text)
    .join('')
    .slice(0, 40)

/** The sign blocks a datapack sets as it builds; a sign on a wall is on it. */
function signBlocks(files: readonly { path: string; content: string }[]): Thing[] {
  return files
    .flatMap((file) => file.content.split('\n'))
    .filter((command) => /^setblock \S+ \S+ \S+ minecraft:\w*sign/.test(command))
    .filter((command) => !/wall_sign|wall_hanging_sign/.test(command))
    .map((command) => {
      const [x = 0, y = 0, z = 0] = command.split(' ').slice(1, 4).map(Number)
      return { what: command.slice(0, 60), from: [x, y, z] as Point, to: [x + 1, y + 1, z + 1] as Point }
    })
}

const ARCADE_THINGS: Thing[] = [
  ...ARCADE_SIGNS.map((sign) => {
    const [from, to] = signExtent(sign)
    return { what: `the sign at ${sign.at.join(' ')}`, from, to }
  }),
  ...ARCADE_LABELS.flatMap((label) => shown(`the label "${labelText(label)}"`, roomOf(label))),
  ...HUB_MARKERS.flatMap((marker) => shown(`the marker at ${marker.at.join(' ')}`, markerRoom(marker))),
  ...signBlocks(ARCADE_FILES),
]

const DUELS_THINGS: Thing[] = [
  { what: 'the sign', from: marqueeExtent(BRAND_SIGN)[0], to: marqueeExtent(BRAND_SIGN)[1] },
  ...shown('the way out’s marker', markerRoom(EXIT_MARKER)),
  ...signBlocks(WAITING_FILES),
]

/** Each thing that overlaps the room, with the first place it does. */
function inTheWay(things: readonly Thing[], boxes: readonly RoomBox[]): string[] {
  return things.flatMap(({ what, from, to }) => {
    const box = boxes.find(
      ([x0, z0, x1, z1, y0, y1]) =>
        from[0] < x1 && to[0] > x0 && from[2] < z1 && to[2] > z0 && from[1] < y1 && to[1] > y0,
    )
    return box === undefined ? [] : [`${what}, where players are at ${box.join(' ')}`]
  })
}

describe('nothing Cubepals puts up stands where players play', () => {
  test('the room was worked out from the Arcade world the template gives', () => {
    expect(SPACE.arcade.world).toBe(ARCADE_WORLD.sha512)
  })

  test('the Arcade: the hub, the parkour, the falling floor and the pit', () => {
    const boxes = Object.values(SPACE.arcade).filter((value): value is RoomBox[] => Array.isArray(value))
    expect(ARCADE_THINGS.length).toBeGreaterThan(10)
    expect(inTheWay(ARCADE_THINGS, boxes.flat())).toEqual([])
  })

  test('Duels: the platform, its parkour and its pit', () => {
    expect(inTheWay(DUELS_THINGS, SPACE.duels)).toEqual([])
  })

  test('the room covers every course from its start to its finish', () => {
    const reached = (boxes: readonly RoomBox[], [x, y, z]: Point) =>
      boxes.some(([x0, z0, x1, z1, y0, y1]) => x >= x0 && x < x1 && z >= z0 && z < z1 && y >= y0 && y < y1)
    for (const { from, to } of PARKOUR_FINISHES)
      expect(
        reached(SPACE.arcade.parkour ?? [], [
          (from[0] + to[0]) / 2 + 0.5,
          from[1],
          (from[2] + to[2]) / 2 + 0.5,
        ]),
      ).toBe(true)
    const [fx = 0, fy = 0, fz = 0] = FINISH.split(' ').map(Number)
    expect(reached(SPACE.duels, [fx + 0.5, fy + 1, fz + 0.5])).toBe(true)
  })

  test('a thing in the way is found: a block on the parkour’s first start', () => {
    const start = SPACE.arcade.parkour?.[0]
    if (start === undefined) throw new Error('The parkour has no room')
    const [x0, z0, , , y0] = start
    const block: Thing = { what: 'a block', from: [x0, y0, z0], to: [x0 + 1, y0 + 1, z0 + 1] }
    expect(inTheWay([block], SPACE.arcade.parkour ?? [])).toHaveLength(1)
  })
})
