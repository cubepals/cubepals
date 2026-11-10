// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The control plane's side of item pictures: what it keeps of each release's art, and the list of
 * every item a release has, which the field that gives an item offers.
 */
import { expect, test } from 'bun:test'
import { offeredVersions } from '../../minecraft/versions.ts'
import { ItemIcons } from './icons.ts'

test('icons for made-up ids stop being kept once there are enough, the oldest first', async () => {
  const version = offeredVersions()[0]?.id ?? ''
  const asked: string[] = []
  const icons = new ItemIcons({
    assets: {
      open: async () => ({
        read: (path) => {
          asked.push(path)
          return null
        },
        paths: () => [],
      }),
    },
  })
  await icons.icons(version, ['minecraft:first_made_up'])
  const firstReads = asked.length
  expect(firstReads).toBeGreaterThan(0)

  // Asked again, it is kept: nothing more is read.
  await icons.icons(version, ['minecraft:first_made_up'])
  expect(asked.length).toBe(firstReads)

  // Enough other ids push it out, so it is worked out again.
  await icons.icons(
    version,
    Array.from({ length: 20_000 }, (_, i) => `minecraft:made_up_${i}`),
  )
  const before = asked.length
  await icons.icons(version, ['minecraft:first_made_up'])
  expect(asked.length).toBeGreaterThan(before)
})

test('every item of a release, by id, worked out once; none for a release Cubepals doesn’t offer', async () => {
  const version = offeredVersions()[0]?.id ?? ''
  let listed = 0
  const icons = new ItemIcons({
    assets: {
      open: async () => ({
        read: () => null,
        paths: () => {
          listed++
          return ['items/stone.json', 'items/diamond.json', 'textures/item/diamond.png']
        },
      }),
    },
  })
  expect(await icons.items(version)).toEqual(['minecraft:diamond', 'minecraft:stone'])
  expect(await icons.items(version)).toEqual(['minecraft:diamond', 'minecraft:stone'])
  expect(listed).toBe(1)
  expect(await icons.items('0.0.1-made-up')).toEqual([])
})
