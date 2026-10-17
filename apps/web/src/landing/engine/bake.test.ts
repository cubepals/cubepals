// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

import { describe, expect, test } from 'bun:test'
import { baked } from './bake'
import { Kind, World } from './world'

/** A small world: a floor, a wall across it, a roof over one corner, and a lamp on one side. */
function room(): World {
  const world = new World(8, 0, 8)
  world.fill({ x0: 0, y0: 0, z0: 0, x1: 7, y1: 0, z1: 7 }, Kind.stone)
  world.fill({ x0: 4, y0: 1, z0: 0, x1: 4, y1: 5, z1: 7 }, Kind.stone)
  world.fill({ x0: 0, y0: 4, z0: 0, x1: 2, y1: 4, z1: 2 }, Kind.stone)
  world.light(2.5, 1.5, 4.5, 4, 1)
  return world
}

const read = (world: World, x: number, y: number, z: number, channel: number) => {
  const light = baked(world)
  return light.data[(x + light.size * (y - light.bottom + light.height * z)) * 4 + channel] as number
}

describe('baked light', () => {
  test('a lamp lights the air beside it and not the far side of a wall', () => {
    const world = room()
    expect(read(world, 3, 1, 4, 1)).toBeGreaterThan(0)
    expect(read(world, 5, 1, 4, 1)).toBe(0)
  })

  test('the air under a roof sees less of the sky than the air in the open', () => {
    const world = room()
    expect(read(world, 1, 3, 1, 0)).toBeLessThan(read(world, 1, 7, 6, 0))
  })

  test('light bounces off the floor into the air round the lamp', () => {
    expect(read(room(), 2, 2, 4, 2)).toBeGreaterThan(0)
  })
})
