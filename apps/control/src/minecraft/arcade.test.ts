// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's datapack, read the way Minecraft reads it: where it goes, which releases load it,
 * that every function it calls is one it has, that it builds only where its chunks are loaded and
 * each game in its own place, that the parkour can be jumped, and what it tells a new player.
 */
import { describe, expect, test } from 'bun:test'
import { onLevel } from '../domain/revision/carried.ts'
import { COURSE } from './arcade/parkour.ts'
import { ARCADE_FILES } from './arcade.ts'
import { placeablePath } from './carried.ts'

const PACK = 'world-2/datapacks/cubepals-arcade'
const FUNCTIONS = `${PACK}/data/arcade/function/`

const files = ARCADE_FILES.map((file) => onLevel(file, 'world-2'))

/** A file as a server running `world-2` has it. */
const fileAt = (path: string) => files.find((file) => file.path === `${PACK}/${path}`)?.content ?? ''

/** Every function, by its name under `arcade:`, as its commands. */
const functions = new Map(
  files
    .filter((file) => file.path.startsWith(FUNCTIONS))
    .map((file) => [
      file.path.slice(FUNCTIONS.length, -'.mcfunction'.length),
      file.content.trim().split('\n'),
    ]),
)
const commands = (name: string) => functions.get(name) ?? []
const everyCommand = [...functions.values()].flat()

type Box = { x: [number, number]; y: [number, number]; z: [number, number] }

/** The box a selector's `x=,y=,z=,dx=,dy=,dz=` names, both corners included. */
function boxOf(selector: string): Box {
  const n = (key: string) => Number(selector.match(new RegExp(`\\b${key}=(-?\\d+)`))?.[1])
  return {
    x: [n('x'), n('x') + n('dx')],
    y: [n('y'), n('y') + n('dy')],
    z: [n('z'), n('z') + n('dz')],
  }
}
const overlap = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1]
const overlaps = (a: Box, b: Box) => overlap(a.x, b.x) && overlap(a.y, b.y) && overlap(a.z, b.z)
const inside = (a: Box, [x, y, z]: number[]) =>
  x !== undefined &&
  y !== undefined &&
  z !== undefined &&
  x >= a.x[0] &&
  x <= a.x[1] &&
  y >= a.y[0] &&
  y <= a.y[1] &&
  z >= a.z[0] &&
  z <= a.z[1]

/** Each game's zone, as the command that puts the players in it on the game's team names it. */
const zones = new Map(
  commands('tick')
    .filter((command) => command.startsWith('team join '))
    .map((command) => [command.split(' ')[2] ?? '', boxOf(command)]),
)

describe('the Arcade datapack as Minecraft loads it', () => {
  test('it goes in the world the server runs, at paths Cubepals may write, and runs as the world loads', () => {
    for (const file of files) {
      expect(file.path).toStartWith(`${PACK}/`)
      expect(placeablePath(file.path)).toBe(true)
    }
    expect(JSON.parse(fileAt('data/minecraft/tags/function/load.json'))).toEqual({ values: ['arcade:load'] })
    expect(JSON.parse(fileAt('data/minecraft/tags/function/tick.json'))).toEqual({ values: ['arcade:tick'] })
    expect(JSON.parse(fileAt('data/arcade/loot_table/head.json')).pools[0].entries[0].name).toBe(
      'minecraft:player_head',
    )
  })

  test('Minecraft 26.2 loads it: its data pack format, 107, is in the range the pack names', () => {
    const { pack } = JSON.parse(fileAt('pack.mcmeta')) as { pack: { min_format: number; max_format: number } }
    expect(pack.min_format).toBeLessThanOrEqual(107)
    expect(pack.max_format).toBeGreaterThanOrEqual(107)
  })

  test('every function it calls is one of its own, and one taking arguments is always given them', () => {
    const takesArguments = new Set(
      [...functions].filter(([, lines]) => lines.some((line) => line.startsWith('$'))).map(([name]) => name),
    )
    for (const command of everyCommand)
      for (const [, name, rest] of command.matchAll(/function arcade:([a-z/]+)(.*)/g)) {
        expect(functions.has(name ?? '')).toBe(true)
        const given = /^ (with |\{)/.test(rest ?? '')
        expect(`${name}: ${given}`).toBe(`${name}: ${takesArguments.has(name ?? '')}`)
      }
  })

  test('the game rules are a function of their own, so a release that renames one fails only it', () => {
    expect(commands('load')).toContain('function arcade:rules')
    expect(everyCommand.filter((command) => command.startsWith('gamerule '))).toEqual(
      commands('rules').filter((command) => command.startsWith('gamerule ')),
    )
  })

  test('it builds a moment after the world loads, and only in chunks the load forces', () => {
    expect(commands('load').at(-1)).toBe('scoreboard players set #build arcade.tmp 40')
    expect(commands('tick').slice(0, 2)).toEqual([
      'execute if score #build arcade.tmp matches 1.. run scoreboard players remove #build arcade.tmp 1',
      'execute if score #build arcade.tmp matches 0 run function arcade:build',
    ])
    const forced = commands('load')
      .filter((command) => command.startsWith('forceload add '))
      .map((command) => {
        const [x1 = 0, z1 = 0, x2 = 0, z2 = 0] = (command.match(/-?\d+/g) ?? []).map(Number)
        return { x: [x1, x2], y: [-64, 320], z: [z1, z2] } as Box
      })
    const building = commands('build').filter((command) => /^(fill|setblock|summon) /.test(command))
    expect(building.length).toBeGreaterThan(40)
    for (const command of building) {
      const numbers = (command.replace(/\{.*$/, '').match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
      const corners = command.startsWith('fill ')
        ? [numbers.slice(0, 3), numbers.slice(3, 6)]
        : [numbers.slice(0, 3)]
      for (const corner of corners)
        expect(`${command}: ${forced.some((area) => inside(area, corner.map(Math.floor)))}`).toBe(
          `${command}: true`,
        )
    }
  })
})

describe('the Arcade as its players find it', () => {
  test('each game has its place, apart from the hub and from each other', () => {
    expect([...zones.keys()].sort()).toEqual(['arcade.floor', 'arcade.hub', 'arcade.parkour', 'arcade.pit'])
    const all = [...zones.values()]
    for (const [i, a] of all.entries()) for (const b of all.slice(i + 1)) expect(overlaps(a, b)).toBe(false)
  })

  test('the hub sends a player to each game, onto its platform and off every pad', () => {
    const pads = commands('tick').filter((command) => /^tp @a\[x=/.test(command))
    expect(pads).toHaveLength(3)
    const backPads = commands('tick')
      .filter((command) => command.includes('run function arcade:hub/back') && command.includes('dx='))
      .map(boxOf)
    for (const pad of pads) {
      const [x = 0, y = 0, z = 0] = (pad.split('] ')[1] ?? '').split(' ').map(Number)
      const arrival = [Math.floor(x), Math.floor(y), Math.floor(z)]
      const team = [...zones].find(([, zone]) => inside(zone, arrival))?.[0]
      expect(team).toBeDefined()
      expect(team).not.toBe('arcade.hub')
      // Not straight back onto a pad, the hub's or the game's own way back.
      for (const other of [...pads.map(boxOf), ...backPads]) expect(inside(other, arrival)).toBe(false)
      // Standing on something the build makes: the block under the arrival is in a fill.
      const under = [arrival[0] ?? 0, (arrival[1] ?? 0) - 1, arrival[2] ?? 0]
      const floors = commands('build')
        .filter((command) => command.startsWith('fill '))
        .map((command) => {
          const [x1 = 0, y1 = 0, z1 = 0, x2 = 0, y2 = 0, z2 = 0] = (command.match(/-?\d+/g) ?? []).map(Number)
          return { x: [x1, x2], y: [y1, y2], z: [z1, z2] } as Box
        })
      expect(floors.some((floor) => inside(floor, under))).toBe(true)
    }
  })

  test('the parkour can be jumped, its checkpoints in order and its finish last', () => {
    expect(COURSE.filter((step) => step.kind === 'checkpoint')).toHaveLength(3)
    expect(COURSE.at(-1)?.kind).toBe('finish')
    // From the start's west edge, each jump from the edge of one step to the next: two blocks
    // across on the level, one going a block up, three going down, and never more than a block up.
    let from: { at: readonly number[]; kind: string } = { at: [-36, 100, 0], kind: 'stone' }
    for (const step of COURSE) {
      const half = (kind: string) => (kind === 'stone' ? 0 : 1)
      const gap = (axis: 0 | 2) =>
        Math.max(
          0,
          Math.abs((step.at[axis] ?? 0) - (from.at[axis] ?? 0)) - half(step.kind) - half(from.kind) - 1,
        )
      const across = Math.hypot(gap(0), gap(2))
      const up = (step.at[1] ?? 0) - (from.at[1] ?? 0)
      expect(up).toBeLessThanOrEqual(1)
      expect(across).toBeLessThanOrEqual(up === 1 ? 1.5 : up === 0 ? 2.3 : 3)
      expect(across).toBeGreaterThan(0)
      from = step
    }
  })

  test('a new player is told in one sentence what to do, once', () => {
    const welcome = commands('tick').filter((command) => command.includes('tag=!arcade.welcomed'))
    expect(welcome).toEqual([
      'tellraw @a[tag=!arcade.welcomed] "Step on a coloured pad to play a game, and see if you can get your name on the boards."',
      'tag @a[tag=!arcade.welcomed] add arcade.welcomed',
    ])
  })

  test('each board keeps a top ten, and a player once', () => {
    const submit = commands('boards/submit')
    expect(submit).toContain('function arcade:boards/forget with storage arcade:work new')
    expect(submit).toContain('data remove storage arcade:work out[10]')
    expect(commands('boards/forget')).toEqual(['$data remove storage arcade:work list[{uuid:$(uuid)}]'])
    for (const board of ['pk', 'ff', 'wins', 'kills'])
      expect(everyCommand).toContain(`function arcade:boards/submit {board:"${board}"}`)
  })
})
