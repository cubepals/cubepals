// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { forPlayers, runsPlugins } from './artifact.ts'

const mods = [
  { name: 'ChatSentinel', environment: 'both' as const },
  { name: 'Spark', environment: 'server' as const },
  { name: 'Voice', environment: 'optional' as const },
]

describe('forPlayers', () => {
  test('a plugin server asks nothing of players, whatever the catalog says of its plugins', () => {
    expect(forPlayers(mods, 'paper')).toEqual([])
  })

  test('a mod loader still lists what players need, with the optional ones that come along', () => {
    expect(forPlayers(mods, 'fabric').map((mod) => mod.name)).toEqual(['ChatSentinel', 'Voice'])
  })

  test('mods that run on the server alone ask nothing on a mod loader', () => {
    expect(
      forPlayers(
        mods.filter((mod) => mod.environment !== 'both'),
        'fabric',
      ),
    ).toEqual([])
  })

  test('only Paper runs plugins', () => {
    expect(['vanilla', 'paper', 'fabric', 'quilt', 'neoforge', 'forge'].filter(runsPlugins)).toEqual([
      'paper',
    ])
  })
})
