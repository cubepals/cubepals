// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Addresses Blockly holds back from players, beside the platform's own hosts (`slug.ts`), and which
 * hold each falls under; `app/servers/names.ts` says who may still give one. A server that already
 * has one keeps it: these are read when an address is chosen, never when one is routed. Offensive
 * words are not here; an open-source matcher judges those (`@blockly/contracts/names`).
 */

/**
 * Names that pass for Cubepals, Mojang or Microsoft, their people or their products. A player
 * would read a server at one as official. Only an operator gives one to a server.
 */
const BRAND: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'blockly',
  'cubepal',
  'cubepals',
  'microsoft',
  'minecraft',
  'mod',
  'moderator',
  'moderators',
  'mojang',
  'official',
  'owner',
  'realms',
  'security',
  'staff',
  'support',
  'team',
  'xbox',
])

/**
 * The plain words for game modes and hubs, held for Cubepals' own public servers
 * (the first is Duels, at the address `duels`). Taking one is like taking an address another
 * server has; an operator or a platform admin gives one to a server.
 */
export const HELD_FOR_CUBEPALS: ReadonlySet<string> = new Set([
  'arena',
  'bedwars',
  'creative',
  'duels',
  'events',
  'factions',
  'hardcore',
  'hub',
  'lifesteal',
  'lobby',
  'manhunt',
  'minigames',
  'modded',
  'oneblock',
  'parkour',
  'prison',
  'pvp',
  'skyblock',
  'skywars',
  'smp',
  'spawn',
  'survival',
  'vanilla',
])

/** Which hold an address falls under, if any: `brand` for operators alone, `cubepals` for staff. */
export type Hold = 'brand' | 'cubepals'

export function holdOn(slug: string): Hold | null {
  if (passesForBrand(slug)) return 'brand'
  if (HELD_FOR_CUBEPALS.has(slug)) return 'cubepals'
  return null
}

/**
 * Whether an address reads as a brand word once the dressing a lookalike adds is taken off:
 * dashes (`cube-pals`), a number after it (`cubepals1`, `staff-2`), digits for letters
 * (`cub3pals`), or brand words strung together (`cubepals-staff`, `official-team`).
 */
function passesForBrand(slug: string): boolean {
  const words = slug
    .split('-')
    .map(bare)
    .filter((word) => word.length > 0)
  return brandWord(bare(slug.replaceAll('-', ''))) || (words.length > 0 && words.every(brandWord))
}

const brandWord = (word: string): boolean =>
  BRAND.has(word.replaceAll('1', 'i')) || BRAND.has(word.replaceAll('1', 'l'))

/** A word without the number after it, with the digits that stand for letters read as those letters. */
const bare = (word: string): string =>
  word
    .replace(/\d+$/, '')
    .replaceAll('0', 'o')
    .replaceAll('3', 'e')
    .replaceAll('4', 'a')
    .replaceAll('5', 's')
    .replaceAll('7', 't')
