/**
 * SPDX-FileCopyrightText: 2026 The Cubepals Authors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * How hard a server works for its game settings, as the settings page's meter shows it while the
 * owner slides them: an estimate, never a measurement, and never a limit. The page refuses nothing
 * on it; the bounds stay what the control plane gives.
 *
 * A size holds its players at Minecraft's own distances. Past those, each player keeps more
 * chunks: the ones the world simulates are ticked (the cores' work, which is what runs out first),
 * and the ones they only see are held and sent. Both grow with the square around the player.
 */
import { METER } from '@blockly/contracts/meter'

/** Minecraft's own view and simulation distance, which every new server starts with. */
export const GAME_DEFAULT_DISTANCE = 10

/** Blocks in a chunk's side, so a distance in chunks reads in blocks too. */
export const CHUNK_BLOCKS = 16

/** Chunks in the square a player keeps around them at `distance`. */
const square = (distance: number) => (2 * distance + 1) ** 2

/** How much each kind of chunk weighs: ticking one is most of the work. */
const TICKED = 0.75
const HELD = 0.25

export interface Load {
  /** All of `players` on at once; `holds`, what the size holds at Minecraft's distances. */
  players: number
  holds: number
  view: number
  simulation: number
}

/**
 * The work as a share of what the size holds at Minecraft's distances: 1 is a full server at 10
 * chunks. The world moves no further than players see, so simulation counts up to the view.
 */
export function workload({ players, holds, view, simulation }: Load): number {
  const base = square(GAME_DEFAULT_DISTANCE)
  const ticked = square(Math.min(view, simulation)) / base
  const held = square(view) / base
  return (Math.max(0, players) / Math.max(1, holds)) * (TICKED * ticked + HELD * held)
}

export type Level = 'light' | 'comfortable' | 'busy' | 'heavy'

/** Where each level ends; past the last, heavy. */
const LEVELS: [Level, number][] = [
  ['light', 0.6],
  ['comfortable', 1.25],
  ['busy', 2],
]

export const levelOf = (work: number): Level => LEVELS.find(([, upTo]) => work <= upTo)?.[0] ?? 'heavy'

/** The meter is full at this much work, so heavy fills it and the levels below sit along it. */
const FULL = 2.5

/** How many of the meter's blocks are lit: at least one, never past the end. */
export const blocksLit = (work: number): number =>
  Math.max(1, Math.min(METER.blocks, Math.ceil((work / FULL) * METER.blocks)))

/**
 * The meter's word and line for a level, with `players` on at once; `bigger`, when the size
 * section below lists a size that holds more.
 */
export function loadLine(level: Level, players: number, bigger: boolean): { word: string; line: string } {
  const all =
    players === 1
      ? 'With one player on'
      : players === 2
        ? 'With both on at once'
        : `With all ${players} on at once`
  switch (level) {
    case 'light':
      return { word: 'Light', line: `${all}, your server has room to spare.` }
    case 'comfortable':
      return { word: 'Comfortable', line: `${all}, your server keeps up easily.` }
    case 'busy':
      return { word: 'Busy', line: `${all}, your server works hard and may slow down now and then.` }
    case 'heavy':
      return {
        word: 'Heavy',
        line: `${all}, expect lag. Shorten the distances${bigger ? ', or pick a bigger size below' : ''}.`,
      }
  }
}
