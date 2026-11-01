// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Portable setup copies preserve game choices while leaving identity and account checks private. */
import { expect, test } from 'bun:test'
import type { ServerSettings } from '../revision/revision.ts'
import { setupOf } from './setup.ts'

const settings: ServerSettings = {
  difficulty: 'hard',
  defaultGameMode: 'creative',
  pvp: false,
  spawnProtection: 7,
  viewDistance: 16,
  simulationDistance: 9,
  maxPlayers: 17,
  motd: 'Only the original server',
  onlineMode: false,
  otherVersions: 'off',
  bedrock: true,
}
const portable = {
  difficulty: 'hard',
  defaultGameMode: 'creative',
  pvp: false,
  spawnProtection: 7,
  viewDistance: 16,
  simulationDistance: 9,
  otherVersions: 'off',
  bedrock: true,
} as const

for (const choice of [undefined, false, true]) {
  test(`a copied setup preserves keep inventory ${choice === undefined ? 'unset' : choice}`, () => {
    const chosen = choice === undefined ? {} : { keepInventory: choice }
    const revision = {
      gameVersion: '1.21.1',
      loader: 'paper' as const,
      loaderVersion: '123',
      mods: [],
      modpack: null,
      files: [],
      settings: { ...settings, ...chosen },
    }
    const world = { levelType: 'flat', hardcore: true, seed: 'the original world only' }
    expect(setupOf(revision, world, '20')).toStrictEqual({
      gameVersion: '1.21.1',
      loader: 'paper',
      loaderVersion: '123',
      mods: [],
      modpack: null,
      settings: { ...portable, ...chosen },
      world: { levelType: 'flat', hardcore: true },
      party: '20',
    })
  })
}
