// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every way into the Arcade's games from the hub, and the one thing each does: a game's own
 * function, `arcade:play/<game>`, that sends a player there and tells them, as they arrive, what to
 * do. Standing on its pad on the balcony runs it, walking into its machine in the hall does
 * (`machines.ts`), and so does picking it in the book every player keeps (`kept.ts`), through the
 * `play` trigger. Not the games themselves, each its own file, or how the pads look (`hub.ts`).
 */
import { type Block, box, NS, PAPER, type Part } from './datapack.ts'
import { FLOOR_ARRIVAL } from './floor.ts'
import { PARKOUR_ARRIVAL } from './parkour.ts'

/** What a player types after `/trigger` to go to a game, as the book's links do: `play set 2`. */
export const PLAY = 'play'

export interface Game {
  /** Its function's name, under `arcade:play/`. */
  key: string
  name: string
  /** What it is, in a line: the book's. */
  line: string
  /** The block at its pad's middle, on the balcony: Ink in a ring of Paper (`scripts/lib/arcade-brand.ts`). */
  pad: Block
  /** Sending a player there, run as them. */
  sends: readonly string[]
}

/**
 * A title on a player's screen, as they arrive: the game's name, and what to do there under it, the
 * one four times the game's text and the other twice, each short enough to fit a screen.
 */
const told = (name: string, subtitle: string): string[] => [
  'title @s times 5 60 15',
  `title @s subtitle ${JSON.stringify(subtitle)}`,
  `title @s title {text:${JSON.stringify(name)},color:"${PAPER}",bold:true}`,
]

/** The games, in the order the book lists them; a game's number in the `play` trigger is its place here, from 1. */
export const GAMES: readonly Game[] = [
  {
    key: 'parkour',
    name: 'Parkour',
    line: 'Three courses against the clock',
    pad: [126, 77, 1431],
    sends: [`tp @s ${PARKOUR_ARRIVAL}`, ...told('Parkour', 'The clock starts as you step off.')],
  },
  {
    key: 'pit',
    name: 'The pit',
    line: 'Everyone fights everyone',
    pad: [175, 78, 1438],
    sends: [`function ${NS}:pit/arrive`, ...told('The pit', 'Every kill counts.')],
  },
  {
    key: 'floor',
    name: 'Falling floor',
    line: 'Last one standing',
    pad: [224, 77, 1431],
    // Under it, on the pad, the countdown to the round (`floor.ts`).
    sends: [`tp @s ${FLOOR_ARRIVAL}`, ...told('Falling floor', 'Stand on the pad for the next round.')],
  },
]

/** The command that sends a player to a game, run as them: its function. */
export const playing = (game: Game): string => `function ${NS}:play/${game.key}`

/** Standing on a pad; a moderator flying past in spectator mode isn't. */
const onPad = ([x, y, z]: Block) => `${box([x - 1, y + 1, z - 1], [x + 1, y + 2, z + 1])},gamemode=!spectator`

export const WAYS_IN_PART: Part = {
  functions: Object.fromEntries(GAMES.map((game) => [`play/${game.key}`, game.sends])),
  load: [`scoreboard objectives add ${PLAY} trigger`],
  build: [],
  tick: [
    ...GAMES.map((game) => `execute as @a[${onPad(game.pad)}] run ${playing(game)}`),
    `scoreboard players enable @a ${PLAY}`,
    ...GAMES.map((game, i) => `execute as @a[scores={${PLAY}=${i + 1}}] run ${playing(game)}`),
    `scoreboard players reset @a[scores={${PLAY}=1..}] ${PLAY}`,
  ],
}
