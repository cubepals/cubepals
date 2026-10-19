// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's leaderboards, kept as every Cubepals leaderboard is (`leaderboards.ts`), and drawn
 * on boards floating before the hub's domes. Not what a score is or when it counts, which each
 * game decides; a game hands its board a score and the words to show for it.
 */
import { leaderboards } from '../leaderboards.ts'
import { type Read, turnedTo } from '../readable.ts'
import { type Block, INDIGO, type Label, NS, PAPER, type Part, type Run } from './datapack.ts'
import { plateOf } from './label-space.ts'

interface Board {
  key: string
  title: string
  at: Block
}

/**
 * The boards, west to east, one on each of the four domes along the hub's balcony, each beside its
 * game's pad: the parkour's west of the middle, the pit's by the middle, the falling floor's two
 * east of it. A dome's glass front curves back from a flat middle five blocks wide, a block in
 * from the balcony's ledge; each board hangs square on that middle, a twentieth of a block off it,
 * high enough over the ledge's quartz, a block in front of it, that the quartz hides none of it
 * from where it is read (`BOARD_READS`).
 */
const FACE = 1436 - 0.05
const BOARD_Y = 85.9
const BOARD_LIST: readonly Board[] = [
  { key: 'pk', title: 'Parkour: fastest', at: [124.5, BOARD_Y, FACE] },
  { key: 'kills', title: 'The pit: kills', at: [152.5, BOARD_Y, FACE] },
  { key: 'ff', title: 'Falling floor: longest', at: [199.5, BOARD_Y, FACE] },
  { key: 'wins', title: 'Falling floor: wins', at: [227.5, BOARD_Y, FACE] },
]

/** How much larger a board's text is than the game's: as large as fits the widest board on a dome's flat middle. */
const BOARD_SCALE = 1.1

/**
 * The most a board shows, which its room is measured by: its title over ten lines, each the
 * widest name the game allows (sixteen characters) and a long score.
 */
export const widest = (title: string): Run[] => [
  { text: title, color: INDIGO, bold: true },
  ...Array.from({ length: 10 }, (): Run[] => [
    { text: '\n10. ', color: 'gray' },
    { text: 'W'.repeat(16), color: 'white' },
    { text: '  9999.9s', color: PAPER, bold: true },
  ]).flat(),
]

/** Each board's text display, empty until its first drawing. */
const boardLabels: Label[] = BOARD_LIST.map(({ key, title, at }) => ({
  at,
  tag: `${NS}.board.${key}`,
  text: [],
  scale: BOARD_SCALE,
  // Flat on its dome, facing the balcony: turning, it would sweep into the dome behind it.
  facing: 'north',
  widest: widest(title),
}))

/**
 * Where each board is first read: on the balcony, on the way to it from the hub's middle, turned
 * to its middle. Not from right behind a pad, where the pad's words, two blocks off and over the
 * player, stand in front of the board behind them.
 */
const BOARD_READ_FROM: Readonly<Record<string, Block>> = {
  pk: [130.5, 78, 1431.5],
  kills: [157.5, 78, 1430.5],
  ff: [194.5, 78, 1430.5],
  wins: [222.5, 78, 1432.5],
}

export const BOARD_READS: readonly Read[] = boardLabels.map((label) => {
  const from = BOARD_READ_FROM[label.tag.replace(`${NS}.board.`, '')]
  if (from === undefined) throw new Error(`No place to read ${label.tag} from`)
  const { bottom, top } = plateOf(label)
  const [x, y, z] = label.at
  return { label, from: turnedTo(from, [x, y + (bottom + top) / 2, z]) }
})

const BOARDS = leaderboards(NS, BOARD_LIST)

export const { WORK, TMP, submit, SECONDS, shown, AS_COUNT, onSidebar } = BOARDS

export const BOARDS_PART: Part = {
  functions: BOARDS.functions,
  load: BOARDS.load,
  labels: boardLabels,
  build: BOARDS.build,
  tick: [],
  data: BOARDS.data,
}
