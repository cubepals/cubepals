// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What keeps the island drawing (scene.ts's `keepsDrawing`): anything that moved, the light on its
 * way, and a server between two states, which only time moves on. The drawing itself needs WebGL;
 * the rule that decides whether another frame comes is held here without it.
 */
import { describe, expect, test } from 'bun:test'
import { keepsDrawing } from './scene'

const still = { drawn: false, moving: false, lamps: 0, day: 0 } as const
const lit = { ...still, lamps: 1, day: 1 } as const

describe('what keeps the island drawing', () => {
  test('a server between two states, with nothing else moving', () => {
    // Everyone left before any friend came: the light has gone, and the server isn't asleep yet.
    expect(keepsDrawing({ ...still, power: 'emptying' })).toBe(true)
    // Joined again before it slept: the light is still full, and the server isn't up yet.
    expect(keepsDrawing({ ...lit, power: 'starting' })).toBe(true)
  })

  test('nothing more once the server is where it was going and all is still', () => {
    expect(keepsDrawing({ ...still, power: 'sleeping' })).toBe(false)
    expect(keepsDrawing({ ...lit, power: 'online' })).toBe(false)
  })

  test('the light on its way, or anything that moved', () => {
    expect(keepsDrawing({ ...still, day: 0.4, power: 'sleeping' })).toBe(true)
    expect(keepsDrawing({ ...lit, moving: true, power: 'online' })).toBe(true)
    expect(keepsDrawing({ ...lit, drawn: true, power: 'online' })).toBe(true)
  })
})
