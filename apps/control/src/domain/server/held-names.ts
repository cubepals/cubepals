// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Addresses Blockly holds back from players, beside the platform's own hosts (`slug.ts`), and which
 * hold each falls under; `app/servers/names.ts` says who may still give one. A server that already
 * has one keeps it: these are read when an address is chosen, never when one is routed. Offensive
 * words are not here; an open-source matcher judges those (`@blockly/contracts/names`). Addresses
 * Cubepals keeps for its own servers are `kept-addresses.ts`'s, and fall under a hold here.
 *
 * Also the words the name or description of a server not marked official can't say
 * (`saysOfficial`), read when either is chosen.
 */
import { keptFor } from './kept-addresses.ts'

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

/**
 * Which hold an address falls under, if any: `brand` for operators alone, `cubepals` for staff,
 * `kept` for nobody, since it already points at one of Cubepals' own servers.
 */
export type Hold = 'brand' | 'cubepals' | 'kept'

export function holdOn(slug: string): Hold | null {
  if (keptFor(slug) !== null) return 'kept'
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

/** Words a server's name or description can't say unless the server is marked official. */
const OFFICIAL_WORDS: ReadonlySet<string> = new Set(['cubepal', 'cubepals', 'official', 'verified', 'staff'])

/** Cyrillic and Greek letters drawn like the Latin ones they stand for here. */
const LOOK_ALIKE_LETTERS: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ѕ: 's',
  і: 'i',
  ј: 'j',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  ԁ: 'd',
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  ο: 'o',
  ρ: 'p',
  υ: 'u',
  ν: 'v',
}

/**
 * Whether a server's name or description says Cubepals, Official, Verified or Staff as a word:
 * read without case, accents or widths, with look-alike letters as the Latin ones, digits for
 * letters and a number after the word as the address rule reads them (`cub3pals`, `staff2`), and
 * words spelled across spaces or marks joined up (`Cube pals`, `O f f i c i a l`).
 */
export function saysOfficial(text: string): boolean {
  const words = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/./gu, (letter) => LOOK_ALIKE_LETTERS[letter] ?? letter)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
  for (let start = 0; start < words.length; start++) {
    let joined = ''
    for (let end = start; end < words.length && joined.length < 12; end++) {
      joined += words[end]
      if (officialWord(bare(joined))) return true
    }
  }
  return false
}

const officialWord = (word: string): boolean =>
  OFFICIAL_WORDS.has(word.replaceAll('1', 'i')) || OFFICIAL_WORDS.has(word.replaceAll('1', 'l'))
