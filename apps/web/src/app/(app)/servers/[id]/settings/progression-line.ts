// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the Offline world progression section says, and what its drawing shows: the same words
 * and things whatever the server runs, since the Paper plugin and the Fabric mod do the same.
 */

import type { ProgressionPart } from '@blockly/contracts'

/** The section's line: what keeps going, and when. */
export const PROGRESSION_LINE =
  'Your world keeps going while nobody is near it: while players are elsewhere or in another dimension, and while the server sleeps. Furnaces finish, crops grow and animals grow up, by the game’s own rules.'

/** What waits, and why, under the switch. */
export const PROGRESSION_WAITS =
  'Hoppers and redstone, mob spawning and mob farms, and villagers’ trades and breeding wait for you: they can only happen by running the whole world, which a sleeping server doesn’t.'

/** Each part's switch under Advanced: its name, and what it covers. */
export const PROGRESSION_PARTS_SHOWN: ReadonlyArray<{
  part: ProgressionPart
  label: string
  covers: string
}> = [
  {
    part: 'furnaces',
    label: 'Furnaces and brewing',
    covers:
      'Furnaces, smokers, blast furnaces, brewing stands and campfires use their fuel and stop when their output is full.',
  },
  {
    part: 'plants',
    label: 'Crops and plants',
    covers:
      'Crops, melons, pumpkins, sugar cane, cactus, bamboo, kelp, berries, cocoa, nether wart, vines, mushrooms and saplings grow in the light and water they have.',
  },
  {
    part: 'animals',
    label: 'Animals growing up',
    covers:
      'Baby animals grow up, parents can breed again, sheared sheep on grass grow their wool back, and turtle eggs hatch.',
  },
  {
    part: 'world',
    label: 'World changes',
    covers:
      'Copper ages, leaves fall from cut trees, grass and mycelium spread, ice and snow melt beside light, and amethyst and dripstone grow.',
  },
  {
    part: 'fire',
    label: 'Fire and lava spreading',
    covers:
      'Lava sets things alight and fire spreads and burns, with nobody there to put it out. Off unless you turn it on.',
  },
]

/** What a start that failed with it says, where Cubepals turned it off itself. */
export const PROGRESSION_CLASH =
  'Cubepals turned this off because the server didn’t start with it. You can turn it back on after changing your mods.'

/** One thing in the drawing: as it is left, and as it is found while this is on. */
export interface Change {
  id: string
  left: { name: string; count: number }
  found: { name: string; count: number }
}

/** Three things a base leaves going: a furnace of iron, a crop, and sugar cane. */
export const CHANGES: readonly Change[] = [
  { id: 'raw_iron', left: { name: 'Raw Iron', count: 8 }, found: { name: 'Iron Ingot', count: 8 } },
  { id: 'wheat_seeds', left: { name: 'Wheat Seeds', count: 1 }, found: { name: 'Wheat', count: 1 } },
  { id: 'sugar_cane', left: { name: 'Sugar Cane', count: 1 }, found: { name: 'Sugar Cane', count: 3 } },
]

/** The item each is found as, by id: what the drawing shows on its right. */
export const FOUND_AS: Readonly<Record<string, string>> = {
  raw_iron: 'iron_ingot',
  wheat_seeds: 'wheat',
  sugar_cane: 'sugar_cane',
}
