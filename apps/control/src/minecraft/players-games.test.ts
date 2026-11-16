// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { PinnedMod } from '../domain/mods/artifact.ts'
import { inPlayersGames } from './mods.ts'

type Mod = Pick<PinnedMod, 'name' | 'environment' | 'loaders'>

const mod = (name: string, environment: Mod['environment'], loaders = ['fabric']): Mod => ({
  name,
  environment,
  loaders,
})

describe('inPlayersGames', () => {
  test('every jar, whatever its authors say it asks of players, the likeliest in a game first', () => {
    const mods = [
      // VeinMiner 2.14.0 is marked for the server alone; 2.13.0, which a game may still have, was not.
      mod('VeinMiner', 'server'),
      mod('voice', 'optional'),
      mod('Create', 'both'),
      mod('Collective', 'server'),
      mod('Appleskin', 'optional'),
    ]
    expect(inPlayersGames(mods, 'fabric').map((m) => m.name)).toEqual([
      'Create',
      'Appleskin',
      'voice',
      'Collective',
      'VeinMiner',
    ])
  })

  test('a datapack goes in the world, never in a game', () => {
    const mods = [
      mod('Terralith', 'server', ['datapack']),
      mod('Both ways', 'server', ['datapack', 'fabric']),
    ]
    // One published as a mod too is loaded as the mod where the server can.
    expect(inPlayersGames(mods, 'fabric').map((m) => m.name)).toEqual(['Both ways'])
    expect(inPlayersGames(mods, 'neoforge')).toEqual([])
  })

  test('a plugin server has nothing a game can carry, whatever a catalog says of its plugins', () => {
    expect(inPlayersGames([mod('ChatSentinel', 'both', ['paper'])], 'paper')).toEqual([])
  })
})
