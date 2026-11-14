// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What the server's page and its Mods page say about the updates Cubepals found. */

import { expect, test } from 'bun:test'
import type { ModsView, ModView, PackView } from '@blockly/contracts'
import { updatesLine, type Versions, withUpdates } from './update-lines.ts'

const mod = (name: string): ModView => ({
  id: name.toLowerCase(),
  name,
  versionLabel: '1.0',
  origin: 'user',
  requiredBy: [],
  environment: 'server',
  source: 'catalog',
  url: null,
  revoked: false,
  malware: false,
  datapack: false,
})
const list = (mods: ModView[], kind: ModsView['kind'] = 'mods') => ({
  kind,
  mods,
  modpack: null,
  packUpdate: null,
})
/** Mods by name, each with the update found for it or null, and the versions the server sent. */
const found = (pairs: Array<[string, string | null]>, kind: ModsView['kind'] = 'mods') => {
  const versions: Versions = {}
  for (const [name, update] of pairs) if (update !== null) versions[name.toLowerCase()] = update
  return [
    list(
      pairs.map(([name]) => mod(name)),
      kind,
    ),
    versions,
  ] as const
}

test('nothing newer says nothing', () => {
  expect(updatesLine(...found([['VeinMiner', null]]))).toBeNull()
  expect(withUpdates(...found([['VeinMiner', null]]))).toEqual([])
})

test('a control plane that sends no updates, or not yet, reads as none', () => {
  expect(updatesLine(list([mod('VeinMiner')]), {})).toBeNull()
})

test('one update names the mod and its version, and that it was checked', () => {
  expect(
    updatesLine(
      ...found([
        ['VeinMiner', '2.13.1'],
        ['AppleSkin', null],
      ]),
    ),
  ).toBe('VeinMiner 2.13.1 is out. Cubepals checked it runs with your other mods.')
  expect(updatesLine(...found([['LuckPerms', '5.5']], 'plugins'))).toBe(
    'LuckPerms 5.5 is out. Cubepals checked it runs with your other plugins.',
  )
})

test('several updates are named together, and a long list is cut short', () => {
  expect(
    updatesLine(
      ...found([
        ['VeinMiner', '2.13.1'],
        ['Jade', '20.1'],
      ]),
    ),
  ).toBe('Updates for VeinMiner and Jade are out. Cubepals checked they run together with your other mods.')
  expect(updatesLine(...found(['A', 'B', 'C', 'D', 'E'].map((name) => [name, '2'])))).toBe(
    'Updates for A, B, C and 2 more are out. Cubepals checked they run together with your other mods.',
  )
})

test('a pack server speaks of its pack, and says when it moves the world', () => {
  const modpack = { name: 'Fabulously Optimized' } as PackView
  const update = { versionId: 'v', label: '7.1', gameVersion: '26.3', movesWorld: false, release: null }
  expect(updatesLine({ ...list([]), modpack }, {})).toBeNull()
  expect(updatesLine({ ...list([]), modpack, packUpdate: update }, {})).toBe(
    'Fabulously Optimized 7.1 is out.',
  )
  expect(updatesLine({ ...list([]), modpack, packUpdate: { ...update, movesWorld: true } }, {})).toBe(
    'Fabulously Optimized 7.1 is out, on Minecraft 26.3.',
  )
})
