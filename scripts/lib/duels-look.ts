// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Duels lobby's maps in Cubepals' look, as `duels-lobby.ts` turns each into a structure: each
 * block swapped, one for another of the same shape, for the site's sand, paper, ink and warm yellow,
 * so the build's shape stays as built; no real person's likeness, so player heads become skeleton
 * skulls turned the same way; and concrete powder as concrete of its colour, so nothing falls as it
 * is placed. What each map leaves out is here too. Each change is in the map's credits
 * (`duels-waiting/maps.ts`).
 *
 * Blocks a jump depends on keep their kind: ice stays slippery, ladders, bars and fences stay
 * where a player climbs or lands, and wood and coal stay as the ink and warmth already there.
 */

/** A block's name without its namespace, swapped for another's: the rest of its state stays. */
type Swaps = Readonly<Record<string, string>>

/** Each map's swaps, chosen by eye against the landing page. */
const SWAPS: Readonly<Record<string, Swaps>> = {
  // Quartz is already paper: its blue accents go warm yellow, its finish block gold.
  ice: {
    light_blue_wool: 'yellow_wool',
    light_blue_carpet: 'yellow_carpet',
    diamond_block: 'gold_block',
  },
  // Grey stone bricks to sand, each shape to the same shape.
  debris: {
    stone_bricks: 'cut_sandstone',
    stone_brick_slab: 'smooth_sandstone_slab',
    stone_brick_stairs: 'smooth_sandstone_stairs',
    cobblestone_wall: 'sandstone_wall',
    diamond_block: 'gold_block',
  },
  // The floor sand, flecked with paper; the ring round it paper; the walls sand; the trims yellow.
  cramped: {
    stone: 'smooth_sandstone',
    andesite: 'sandstone',
    cobblestone: 'cut_sandstone',
    gravel: 'smooth_quartz',
    polished_andesite: 'smooth_quartz',
    cyan_terracotta: 'yellow_terracotta',
    gray_concrete: 'white_concrete',
    stone_bricks: 'cut_sandstone',
    stone_brick_stairs: 'sandstone_stairs',
    smooth_stone_slab: 'smooth_sandstone_slab',
    cobblestone_wall: 'sandstone_wall',
  },
}

/** Player heads as skeleton skulls: the same block states, standing or on a wall. */
const LIKENESS: Swaps = { player_head: 'skeleton_skull', player_wall_head: 'skeleton_wall_skull' }

/**
 * What a map leaves out, as a test on a block's name and place in the map: the arena's barriers,
 * which the pit places itself as it opens and closes, and the two layers of rock under its floor,
 * which nobody sees.
 */
const LEFT_OUT: Readonly<Record<string, (name: string, at: readonly [number, number, number]) => boolean>> = {
  cramped: (name, [, y]) => name === 'barrier' || y < 78,
}

/** A block of a map as the structure has it, or null where it is left out. */
export function looked(
  key: string,
  name: string,
  at: readonly [number, number, number],
): { name: string; skull: boolean } | null {
  const plain = name.replace(/^minecraft:/, '')
  if (LEFT_OUT[key]?.(plain, at)) return null
  const skull = LIKENESS[plain]
  if (skull !== undefined) return { name: `minecraft:${skull}`, skull: true }
  const set = plain.replace(/_concrete_powder$/, '_concrete')
  return { name: `minecraft:${SWAPS[key]?.[set] ?? set}`, skull: false }
}
