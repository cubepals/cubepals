// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

import { describe, expect, test } from 'bun:test'
import { Kind, World } from './world'

/** A face's four corners, from its byte: 3 is open, 0 shut in. */
const corners = (byte: number) => [0, 1, 2, 3].map((k) => (byte >> (2 * k)) & 3)

describe('corner shading', () => {
  test('a block alone on open ground has every top corner open', () => {
    const world = new World(8, 0, 8)
    world.set(4, 1, 4, Kind.stone)
    expect(corners(world.occlusion(4, 1, 4)[0] as number)).toEqual([3, 3, 3, 3])
  })

  test('the ground beside a wall is darker at the wall, and darkest in the corner of two', () => {
    const world = new World(8, 0, 8)
    world.fill({ x0: 0, y0: 0, z0: 0, x1: 7, y1: 0, z1: 7 }, Kind.stone)
    // A wall along +x of the cell above (4, 0, 4), and one along +z.
    world.set(5, 1, 4, Kind.stone)
    world.set(5, 1, 5, Kind.stone)
    world.set(4, 1, 5, Kind.stone)
    // The top face's corners: (0,0) (1,0) (1,1) (0,1), as x and z.
    const top = corners(world.occlusion(4, 0, 4)[0] as number)
    expect(top[0]).toBe(3)
    expect(top[1]).toBe(2)
    expect(top[3]).toBe(2)
    expect(top[2]).toBe(0)
  })
})
