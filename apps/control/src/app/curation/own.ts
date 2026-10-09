import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { isReleaseVersion } from '../../domain/mods/curation.ts'
import type { PackLoader } from '../../minecraft/mrpack.ts'
import { compareVersions } from '../../minecraft/versions.ts'

/**
 * Blockly's own packs (docs/modpack-templates.md § Blockly's own packs): short lists of mods Blockly
 * chose, each read for its licence, offered beside the packs other people publish. This file is the
 * review. What a list becomes on each Minecraft release is found by checking it (`service.ts`), not
 * written here: the newest release every mod in it runs on, with the exact files the catalog
 * publishes for it then, pinned as one release of the pack.
 *
 * Every mod and library they bring is under an open licence, and most ask nothing of players, so
 * plain Minecraft joins. One that players install says so (`playersInstall`), and its release is
 * then the pack players install too. Checking refuses a release that stops being what it says.
 */
export interface OwnPack {
  /** Its name in every reference (`key@version`): never renamed, never reused for another pack. */
  key: string
  name: string
  /** One line of what playing it is. */
  blurb: string
  /** Credit on its card: the choice is Blockly's, the mods their authors'. */
  authors: string
  loader: PackLoader
  /** What it brings, by catalog project; what each needs comes along when it is checked. */
  mods: ReadonlyArray<{ catalog: string; projectId: string }>
  /** Where the review is written up. */
  review: string
  /**
   * Players install it to join, as its review decided: what it is played for has to be in their
   * games too. Absent, checking refuses a release that would need anything of players.
   */
  playersInstall?: true
  /** Why no admin may offer it yet, as for a curated pack (`packs.ts`). */
  held?: string
}

export const OWN_PACKS: readonly OwnPack[] = [
  {
    key: 'easy-survival',
    name: 'Easy survival',
    blurb: 'Survival without the chores: graves keep your things, and trees fall whole.',
    authors: 'Cubepals',
    loader: 'fabric',
    mods: [
      // Lithium, FerriteCore and ServerCore: the same game, on less of the server.
      { catalog: 'modrinth', projectId: 'gvQqBUqZ' },
      { catalog: 'modrinth', projectId: 'uXXizFIs' },
      { catalog: 'modrinth', projectId: '4WWQxlQP' },
      // Universal Graves, Right Click Harvest, FallingTree.
      { catalog: 'modrinth', projectId: 'yn9u3ypm' },
      { catalog: 'modrinth', projectId: 'Cnejf5xM' },
      { catalog: 'modrinth', projectId: 'Fb4jn8m6' },
    ],
    review: 'docs/modpack-templates.md#easy-survival',
  },
  {
    key: 'adventure',
    name: 'Adventure',
    blurb: 'Taller mountains, deeper dungeons, and strongholds worth the trip.',
    authors: 'Cubepals',
    loader: 'fabric',
    mods: [
      // Tectonic; YUNG's Better Dungeons, Better Strongholds, Better Mineshafts.
      { catalog: 'modrinth', projectId: 'lWDHr9jE' },
      { catalog: 'modrinth', projectId: 'o1C1Dkj5' },
      { catalog: 'modrinth', projectId: 'kidLKymU' },
      { catalog: 'modrinth', projectId: 'HjmxVlSr' },
    ],
    review: 'docs/modpack-templates.md#adventure',
  },
  {
    key: 'cubepals-cobblemon',
    name: 'Cubepals Cobblemon',
    blurb: 'Catch, raise and battle creatures across a world full of them.',
    authors: 'Cubepals',
    loader: 'fabric',
    mods: [
      // Cobblemon, then the official pack's open-licensed companions that run on a server.
      { catalog: 'modrinth', projectId: 'MdwFAVRL' },
      // Lithium, FerriteCore, Krypton, Clumps, Let Me Despawn: the same game, on less of the server.
      { catalog: 'modrinth', projectId: 'gvQqBUqZ' },
      { catalog: 'modrinth', projectId: 'uXXizFIs' },
      { catalog: 'modrinth', projectId: 'fQEb0iXm' },
      { catalog: 'modrinth', projectId: 'Wnxd13zP' },
      { catalog: 'modrinth', projectId: 'vE2FN5qn' },
      // Monsters in the Closet, AppleSkin, Shulker Box Tooltip, Enchantment Descriptions.
      { catalog: 'modrinth', projectId: 'GMA8jFBD' },
      { catalog: 'modrinth', projectId: 'EsAfCjCV' },
      { catalog: 'modrinth', projectId: '2M01OLQq' },
      { catalog: 'modrinth', projectId: 'UVtY3ZAC' },
      // EMI, EMI Ores, JEI, Advanced Loot Info: recipes, ores and loot, looked up in game.
      { catalog: 'modrinth', projectId: 'fRiHVvU7' },
      { catalog: 'modrinth', projectId: 'sG4TqDb8' },
      { catalog: 'modrinth', projectId: 'u6dRKJwZ' },
      { catalog: 'modrinth', projectId: 'PEPVViac' },
    ],
    review: 'docs/modpack-templates.md#cubepals-cobblemon',
    playersInstall: true,
    held: 'Players install this pack, and nothing publishes it where they can download it yet. Where it is published, a Modrinth project under Cubepals say, is the owner’s decision.',
  },
]

export const ownPack = (key: string, packs: readonly OwnPack[] = OWN_PACKS): OwnPack | null =>
  packs.find((pack) => pack.key === key) ?? null

/**
 * A release of one of Blockly's own packs, named for the day it was put together and the Minecraft
 * it runs on: `2026.09.28+26.3`. One is put together for a Minecraft release at most once; a
 * refused one is checked again when an admin asks.
 */
export function ownRelease(day: Date, gameVersion: string): string {
  const [date] = day.toISOString().split('T')
  return `${(date ?? '').replaceAll('-', '.')}+${gameVersion}`
}

/** The Minecraft a release of one of Blockly's own packs runs on, from its name. */
export function ownGameVersion(version: string): string | null {
  const at = version.indexOf('+')
  return at < 0 || !isReleaseVersion(version) ? null : version.slice(at + 1)
}

/** Releases newest first: by the Minecraft they run on, then by the day they were put together. */
export function ownOrder(versions: readonly string[]): string[] {
  return [...versions].sort(
    (a, b) => compareVersions(ownGameVersion(b) ?? '0', ownGameVersion(a) ?? '0') || b.localeCompare(a, 'en'),
  )
}

/**
 * The mods of a list that players would have to install to join. A library whose catalog says both
 * sides need it is needed in players' games only when something there needs it: YUNG's API is marked
 * for both, yet every YUNG's structure mod that asks for it runs on the server alone.
 */
export function neededByPlayers<T extends Pick<PinnedMod, 'name' | 'environment' | 'origin' | 'requiredBy'>>(
  mods: readonly T[],
): T[] {
  const needed = new Set(mods.filter((mod) => mod.environment === 'both').map((mod) => mod.name))
  let changed = true
  while (changed) {
    changed = false
    for (const mod of mods) {
      if (!needed.has(mod.name) || mod.origin !== 'dependency') continue
      if (mod.requiredBy.some((name) => needed.has(name))) continue
      needed.delete(mod.name)
      changed = true
    }
  }
  return mods.filter((mod) => needed.has(mod.name))
}
