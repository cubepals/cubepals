// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hall's three machines that are ways into the games, one each, side by side on its north wall
 * facing the balcony, in the order of the balcony's pads, west to east: the blue 101 for the
 * parkour, the big ARCADE cabinet for the pit, and the red 101 for the falling floor. Each has a
 * mouth cut into its front at the level a player stands at before it, two wide and three high, and
 * a short dark passage behind; walking in sends the player to the game, as its pad does
 * (`ways-in.ts`). The game's name is on the machine over its mouth. The datapack cuts them as it
 * builds, on the world as the Arcade has it, so nothing else of the world changes. Not the other
 * machines, which are still the map's.
 */
import { type Block, box, type Facing, type Label, NS, type Part, titled } from './datapack.ts'
import { GAMES, playing } from './ways-in.ts'

/** A step toward each way a machine faces, out of its front. */
const OUT: Record<Facing, Block> = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }

export interface Machine {
  /** The game it is the way into, by its key (`ways-in.ts`). */
  game: string
  /** The way its front faces, out into the hall. */
  facing: Facing
  /** Its mouth: the blocks of its front cut away, two wide and three high, from its outermost to its innermost. */
  mouth: [Block, Block]
  /** How many blocks of passage go on behind the mouth, dark, to where walking in sends a player on. */
  depth: number
  /**
   * Where the words over its mouth stand, flat on its front a twentieth of a block off it, and how
   * large: as large as the solid face over the mouth holds (`labels.test.ts`).
   */
  label: { at: readonly [number, number, number]; scale: number }
}

export const MACHINES: readonly Machine[] = [
  {
    game: 'parkour',
    facing: 'south',
    mouth: [
      [148, 52, 1365],
      [149, 54, 1364],
    ],
    depth: 3,
    label: { at: [149, 56.3, 1365.05], scale: 3 },
  },
  {
    game: 'pit',
    facing: 'south',
    mouth: [
      [175, 52, 1372],
      [176, 54, 1370],
    ],
    depth: 3,
    label: { at: [176, 55.06, 1372.05], scale: 1.6 },
  },
  {
    game: 'floor',
    facing: 'south',
    mouth: [
      [202, 52, 1365],
      [203, 54, 1364],
    ],
    depth: 3,
    label: { at: [203, 56.3, 1365.05], scale: 3 },
  },
]

/** A box's corners, least first. */
const sorted = ([a, b]: [Block, Block]): [Block, Block] => [
  [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
  [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
]

/**
 * A run of blocks behind a machine's mouth, as wide and high as it: from `first` to `last` blocks in,
 * counting the first block past the mouth as 1.
 */
function behind(machine: Machine, first: number, last: number): [Block, Block] {
  const [from, to] = sorted(machine.mouth)
  const axis = machine.facing === 'east' || machine.facing === 'west' ? 0 : 2
  const inward = -(OUT[machine.facing][axis] ?? 0)
  const mouthEnd = inward > 0 ? to[axis] : from[axis]
  const [a, b] = [mouthEnd + inward * first, mouthEnd + inward * last]
  const at = (corner: Block, value: number) =>
    corner.map((v, i) => (i === axis ? value : v)) as unknown as Block
  return sorted([at(from, a), at(to, b)])
}

/** The passage behind a machine's mouth, to its far end. */
export const passage = (machine: Machine) => behind(machine, 1, machine.depth)

/** Where walking in sends a player on: the passage's last two blocks. */
export const inside = (machine: Machine) => behind(machine, machine.depth - 1, machine.depth)

const gameOf = (machine: Machine) => {
  const game = GAMES.find((candidate) => candidate.key === machine.game)
  if (game === undefined) throw new Error(`No Arcade game ${machine.game}`)
  return game
}

const fill = ([from, to]: [Block, Block], block: string) =>
  `fill ${from.join(' ')} ${to.join(' ')} minecraft:${block}`

/**
 * Cutting a machine's mouth and passage: the passage's walls, floor, ceiling and end in black, then
 * the mouth and passage cleared. Nothing in front of its front is touched.
 */
function cut(machine: Machine): string[] {
  // Behind the front alone, one block out round the passage and past its end.
  const [from, to] = behind(machine, 1, machine.depth + 1)
  const across = machine.facing === 'east' || machine.facing === 'west' ? 2 : 0
  const out = (corner: Block, by: number) =>
    corner.map((v, i) => (i === across || i === 1 ? v + by : v)) as unknown as Block
  return [
    fill([out(from, -1), out(to, 1)], 'black_concrete'),
    fill(passage(machine), 'air'),
    fill(sorted(machine.mouth), 'air'),
  ]
}

const MACHINE_LABELS: readonly Label[] = MACHINES.map((machine) => ({
  at: machine.label.at,
  tag: `${NS}.label`,
  text: titled(gameOf(machine).name, 'Walk in to play'),
  scale: machine.label.scale,
  facing: machine.facing,
}))

/** Walking into a machine, as its pad's standing does: a moderator flying through in spectator mode isn't. */
const MACHINE_TICK: readonly string[] = MACHINES.map(
  (machine) =>
    `execute as @a[${box(...inside(machine))},gamemode=!spectator] run ${playing(gameOf(machine))}`,
)

export const MACHINES_PART: Part = {
  functions: {},
  load: [],
  labels: MACHINE_LABELS,
  build: MACHINES.flatMap(cut),
  tick: MACHINE_TICK,
}
