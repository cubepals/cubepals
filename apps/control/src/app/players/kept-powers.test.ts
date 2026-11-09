// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { MOST_GIVEN, MOST_LEVELS } from '@blockly/contracts'
import { inJoinOrder, joined, keptOf, keptPowers, waitingView } from './kept-powers.ts'

describe('what waits for a player away', () => {
  test('a heal, a kick and a trip to someone on don’t wait', () => {
    expect(keptOf({ kind: 'heal' })).toBeNull()
    expect(keptOf({ kind: 'kick', reason: '' })).toBeNull()
    expect(keptOf({ kind: 'to_player', to: '00000000-0000-4000-8000-000000000000' })).toBeNull()
  })

  test('items add up by the game’s name for them, levels add up, a trip replaces a trip', () => {
    const diamond = keptOf({ kind: 'give', item: 'diamond', count: 2 })?.what ?? ''
    const named = keptOf({ kind: 'give', item: 'minecraft:diamond', count: 3 })?.what ?? ''
    expect(JSON.parse(joined('give', diamond, named) ?? '')).toEqual([
      { item: 'minecraft:diamond', count: 5 },
    ])
    expect(joined('levels', '5', '3')).toBe('8')
    expect(joined('place', 'death', '{"dimension":"minecraft:overworld","x":1,"y":null,"z":2}')).toBe(
      '{"dimension":"minecraft:overworld","x":1,"y":null,"z":2}',
    )
  })

  test('never more than the game hands over at once', () => {
    expect(joined('levels', String(MOST_LEVELS), '1')).toBeNull()
    const most = JSON.stringify([{ item: 'minecraft:dirt', count: MOST_GIVEN }])
    expect(joined('give', most, JSON.stringify([{ item: 'minecraft:dirt', count: 1 }]))).toBeNull()
  })

  test('an emptied inventory first, so the items after it stay', () => {
    const order = inJoinOrder([
      { kind: 'give' },
      { kind: 'levels' },
      { kind: 'clear_inventory' },
      { kind: 'place' },
    ])
    expect(order.map((w) => w.kind)).toEqual(['clear_inventory', 'place', 'give', 'levels'])
  })

  test('a row that can’t be read is dropped, not shown', () => {
    expect(keptPowers('place', 'nonsense')).toEqual([])
    expect(keptPowers('give', 'nonsense')).toEqual([])
    expect(waitingView('place', 'nonsense', new Date())).toBeNull()
    expect(keptPowers('place', 'spawn')).toBeNull()
  })
})
