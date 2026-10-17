// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ways into the Arcade's games, as the datapack writes them: each game's pad and its line in the
 * book run that game's one function, the book lists every game, and what a player keeps in their
 * hotbar stays one of each, in its slot.
 */
import { describe, expect, test } from 'bun:test'
import { onLevel } from '../../domain/revision/carried.ts'
import { ARCADE_FILES } from '../arcade.ts'
import { PADS } from './hub.ts'
import { KEPT } from './kept.ts'
import { lineWidths } from './label-space.ts'
import { inside, MACHINES, passage } from './machines.ts'
import { GAMES, PLAY, playing } from './ways-in.ts'

const FUNCTIONS = 'world/datapacks/cubepals-arcade/data/arcade/function/'
const functions = new Map(
  ARCADE_FILES.map((file) => onLevel(file, 'world'))
    .filter((file) => file.path.startsWith(FUNCTIONS))
    .map((file) => [
      file.path.slice(FUNCTIONS.length, -'.mcfunction'.length),
      file.content.trim().split('\n'),
    ]),
)
const commands = (name: string) => functions.get(name) ?? []
const tick = commands('play')

/** The game whose function a command runs, by its key. */
const runs = (command: string) => command.match(/ run function arcade:play\/([a-z]+)$/)?.[1]

describe('the ways into the Arcade’s games', () => {
  test('each game has one function, and its pad and its line in the book both run it', () => {
    for (const [i, game] of GAMES.entries()) {
      expect(commands(`play/${game.key}`)).toEqual([...game.sends])
      expect(PADS[i]?.sends).toBe(playing(game))
      const [x, y, z] = game.pad
      const pad = tick.filter((command) =>
        command.includes(`x=${x - 1},y=${y + 1},z=${z - 1},dx=2,dy=1,dz=2`),
      )
      expect(pad.map(runs)).toEqual([game.key])
      const picked = tick.filter((command) => command.startsWith(`execute as @a[scores={${PLAY}=${i + 1}}] `))
      expect(picked.map(runs)).toEqual([game.key])
    }
    // The trigger is open to everyone, and spent once used.
    expect(tick).toContain(`scoreboard players enable @a ${PLAY}`)
    const reset = tick.indexOf(`scoreboard players reset @a[scores={${PLAY}=1..}] ${PLAY}`)
    expect(reset).toBeGreaterThan(
      Math.max(
        ...tick.map((command, at) => (command.includes(`${PLAY}=`) ? at : -1)).filter((at) => at !== reset),
      ),
    )
  })

  test('the book is titled "Pick a game" and lists every game, each name and line a link to that game', () => {
    const book = commands('kept/picker').at(-1) ?? ''
    expect(book).toStartWith('item replace entity @s hotbar.1 with minecraft:written_book[')
    expect(book).toContain('title:"Pick a game"')
    const links = [
      ...book.matchAll(
        /\{text:"([^"]+)",[^{}]*click_event:\{action:"run_command",command:"\/trigger play set (\d)"\}/g,
      ),
    ]
    const listed = links.map(([, text, n]) => ({
      text: text?.replaceAll('\\n', '').trim(),
      game: GAMES[Number(n) - 1]?.key,
    }))
    expect(listed).toEqual(
      GAMES.flatMap((game) => [
        { text: game.name, game: game.key },
        { text: game.line, game: game.key },
      ]),
    )
  })

  test('arriving at a game puts its name on the screen, and what to do there, short enough to fit it', () => {
    // The game's text pixels across a 1920 by 1080 screen at the usual interface size, four to a pixel.
    const SCREEN = 1920 / 4
    for (const game of GAMES) {
      const said = (kind: 'title' | 'subtitle') =>
        commands(`play/${game.key}`).find((command) => command.startsWith(`title @s ${kind} `)) ?? ''
      const title = said('title').match(/text:"([^"]+)"/)?.[1] ?? ''
      const subtitle = JSON.parse(said('subtitle').replace('title @s subtitle ', '')) as string
      expect(title).toBe(game.name)
      expect(subtitle.length).toBeGreaterThan(0)
      expect(4 * Math.max(...lineWidths([{ text: title, color: '', bold: true }]))).toBeLessThanOrEqual(
        SCREEN,
      )
      expect(2 * Math.max(...lineWidths([{ text: subtitle, color: '' }]))).toBeLessThanOrEqual(SCREEN)
    }
  })
})

describe('the hall’s machines a player walks into', () => {
  const build = commands('build')
  const span = (from: readonly number[], to: readonly number[]) =>
    from.map((v, i) => Math.abs((to[i] ?? 0) - v) + 1)

  test('there is one for each game, west to east as the pads are, each a mouth two wide and three high', () => {
    expect(MACHINES.map((machine) => machine.game)).toEqual(GAMES.map((game) => game.key))
    const west = (machine: (typeof MACHINES)[number]) => Math.min(machine.mouth[0][0], machine.mouth[1][0])
    expect(MACHINES.map(west)).toEqual([...MACHINES.map(west)].sort((a, b) => a - b))
    for (const machine of MACHINES) {
      const [x, y, z] = span(...machine.mouth)
      const across = machine.facing === 'north' || machine.facing === 'south' ? x : z
      expect([across, y]).toEqual([2, 3])
    }
  })

  test('the build cuts each mouth and its passage out of the machine, its passage lined in black', () => {
    for (const machine of MACHINES) {
      const [from, to] = passage(machine)
      const cuts = build.filter(
        (command) => command.startsWith('fill ') && command.endsWith(' minecraft:air'),
      )
      expect(cuts).toContain(`fill ${from.join(' ')} ${to.join(' ')} minecraft:air`)
      const lining = build[build.indexOf(`fill ${from.join(' ')} ${to.join(' ')} minecraft:air`) - 1] ?? ''
      expect(lining).toEndWith(' minecraft:black_concrete')
    }
  })

  test('walking in, past the mouth to the passage’s end, runs the same function as the game’s pad and book', () => {
    for (const [i, machine] of MACHINES.entries()) {
      const [from, to] = inside(machine)
      const [pFrom, pTo] = passage(machine)
      // The box where walking in sends a player is in the passage, not in front of the machine.
      for (const axis of [0, 1, 2]) {
        expect(from[axis] ?? 0).toBeGreaterThanOrEqual(pFrom[axis] ?? 0)
        expect(to[axis] ?? 0).toBeLessThanOrEqual(pTo[axis] ?? 0)
      }
      const box = `x=${from[0]},y=${from[1]},z=${from[2]},dx=${(to[0] ?? 0) - (from[0] ?? 0)},dy=${(to[1] ?? 0) - (from[1] ?? 0)},dz=${(to[2] ?? 0) - (from[2] ?? 0)}`
      const walking = tick.filter((command) => command.includes(box))
      expect(walking.map(runs)).toEqual([GAMES[i]?.key])
      expect(walking[0]).toContain('gamemode=!spectator')
    }
  })
})

describe('what every player keeps in their hotbar', () => {
  test('one of each, in its own slot: every other copy is cleared before one is put in its slot', () => {
    expect(new Set(KEPT.map((kept) => kept.slot)).size).toBe(KEPT.length)
    for (const kept of KEPT) {
      const putBack = commands(`kept/${kept.key}`)
      expect(putBack[0]).toBe(`clear @s ${kept.copy}`)
      expect(putBack.at(-1)).toBe(`item replace entity @s ${kept.slot} with ${kept.item}`)
      expect(tick).toContain(
        `execute as @a unless items entity @s ${kept.slot} ${kept.is} run function arcade:kept/${kept.key}`,
      )
    }
  })

  test('whatever else was in the slot is dropped at the player’s feet, never lost', () => {
    for (const kept of KEPT) {
      const putBack = commands(`kept/${kept.key}`)
      const dropped = putBack.findIndex((command) => command.includes(`Inventory[{Slot:${kept.number}b}]`))
      expect(dropped).toBeGreaterThan(0)
      expect(dropped).toBeLessThan(putBack.length - 1)
    }
  })

  test('a copy dropped on the ground is removed, and the player keeps theirs', () => {
    for (const kept of KEPT)
      expect(tick).toContain(
        `execute as @e[type=minecraft:item] if items entity @s contents ${kept.copy} run kill @s`,
      )
  })

  test('the pit gives its kit after what everyone keeps, so it never takes a kept slot', () => {
    const arrive = commands('pit/arrive')
    const keep = arrive.indexOf('function arcade:kept')
    expect(keep).toBe(arrive.indexOf('clear @s') + 1)
    expect(arrive.findIndex((command) => command.startsWith('give '))).toBeGreaterThan(keep)
  })
})
