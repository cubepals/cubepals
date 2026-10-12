// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Play as Cubepals draws it: ten blocks filled to the mark, the meter players know from the game,
 * with a line under it in words. The emails draw it as a table and the site as a part of its
 * own; both take their shape, their rounding and their line from here, so the two always match.
 * It imports nothing.
 */

/** How many blocks, and their size in CSS pixels: each block, the gap between two, its edge. */
export const METER = { blocks: 10, blockPx: 22, gapPx: 4, edgePx: 2 } as const

/** How many of the blocks are filled for `hours` of `included`: to the nearest, never past the end. */
export const blocksFilled = (hours: number, included: number): number =>
  included > 0 ? Math.max(0, Math.min(METER.blocks, Math.round((hours / included) * METER.blocks))) : 0

/** "96 of 120 hours", or with `left`, "96 of 120 hours left": to a tenth, never thousandths. */
export const meterLine = (hours: number, included: number, said: 'used' | 'left' = 'used'): string =>
  `${Math.round(hours * 10) / 10} of ${Math.round(included * 10) / 10} hours${said === 'left' ? ' left' : ''}`
