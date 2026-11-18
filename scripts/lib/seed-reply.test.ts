// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { seedIn } from './seed-reply.ts'

describe('the seed in the console answer', () => {
  test('is read from the answer to seed', () => {
    expect(seedIn('Seed: [-3028258863955102826]\n')).toBe('-3028258863955102826')
    expect(seedIn('Seed: [49]')).toBe('49')
  })

  test("another command's answer is refused, not read as a seed", () => {
    expect(() =>
      seedIn('There are 49 force loaded chunks in minecraft:overworld at: [-3, -3], [-3, -2]'),
    ).toThrow('the console answered "There are 49 force loaded chunks')
    expect(() =>
      seedIn('Marked 49 chunks in minecraft:overworld from [-3, -3] to [3, 3] to be force loaded'),
    ).toThrow()
    expect(() => seedIn('')).toThrow()
  })
})
