// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The datapack Cubepals writes so a player alone on a Duels server has something to do, read the
 * way Minecraft reads it: where it goes, which releases load it, where it builds, and what it says.
 */
import { describe, expect, test } from 'bun:test'
import { onLevel } from '../domain/revision/carried.ts'
import { inRoom, markerRoom } from './arcade/label-space.ts'
import { placeablePath } from './carried.ts'
import { EXIT_MARKER, WAITING_FILES } from './duels-waiting.ts'

const PACK = 'world-2/datapacks/cubepals-duels'

/** A file as a server running `world-2` has it. */
const fileAt = (path: string) =>
  WAITING_FILES.map((file) => onLevel(file, 'world-2')).find((file) => file.path === `${PACK}/${path}`)
    ?.content ?? ''

/** A function's commands, one to a line. */
const commands = (name: string) => fileAt(`data/cubepals/function/${name}.mcfunction`).trim().split('\n')

/** The block positions a building command names: its first three numbers, and the next three. */
function positions(command: string): Array<[number, number, number]> {
  const numbers = (command.match(/-?\d+/g) ?? []).map(Number)
  const at: Array<[number, number, number]> = [[numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0]]
  if (command.startsWith('fill ')) at.push([numbers[3] ?? 0, numbers[4] ?? 0, numbers[5] ?? 0])
  return at
}

/** Every block a building command sets, by `x y z`. */
function cellsOf(command: string): string[] {
  const [from = [0, 0, 0], to = from] = positions(command)
  const span = (axis: 0 | 1 | 2) =>
    Array.from({ length: Math.abs(to[axis] - from[axis]) + 1 }, (_, i) => Math.min(from[axis], to[axis]) + i)
  return span(0).flatMap((x) => span(1).flatMap((y) => span(2).map((z) => `${x} ${y} ${z}`)))
}

/** The blocks the build leaves, the pit's lid shut: each fill or setblock in turn, air taking a block away. */
function builtBlocks(): Set<string> {
  const solid = new Set<string>()
  for (const command of commands('build').filter((line) => /^(fill|setblock) /.test(line))) {
    const block = command.split(' ')[command.startsWith('fill ') ? 7 : 4] ?? ''
    for (const cell of cellsOf(command))
      if (block.startsWith('minecraft:air')) solid.delete(cell)
      else solid.add(cell)
  }
  return solid
}

describe('the datapack for waiting on a Duels server', () => {
  test('it goes in the world the server runs, at paths Cubepals may write', () => {
    for (const file of WAITING_FILES.map((carried) => onLevel(carried, 'world-2'))) {
      expect(file.path).toStartWith(`${PACK}/`)
      expect(placeablePath(file.path)).toBe(true)
    }
    expect(JSON.parse(fileAt('data/minecraft/tags/function/load.json'))).toEqual({
      values: ['cubepals:load'],
    })
    expect(JSON.parse(fileAt('data/minecraft/tags/function/tick.json'))).toEqual({
      values: ['cubepals:tick'],
    })
  })

  test('Minecraft 1.21.11 loads it: its data pack format, 94, is in the range the pack names', () => {
    const { pack } = JSON.parse(fileAt('pack.mcmeta')) as { pack: { min_format: number; max_format: number } }
    expect(pack.min_format).toBeLessThanOrEqual(94)
    expect(pack.max_format).toBeGreaterThanOrEqual(94)
  })

  test('the course and the pit are built on a void world only, in chunks kept loaded, off the arena', () => {
    const load = commands('load')
    expect(load).toContain('execute if block 8 -62 8 minecraft:air run function cubepals:build')
    // `forceload add` names x and z only, of two corners.
    const forceload = load.find((command) => command.startsWith('forceload add ')) ?? ''
    const [x1 = 0, z1 = 0, x2 = 0, z2 = 0] = (forceload.match(/-?\d+/g) ?? []).map(Number)
    for (const command of commands('build'))
      for (const [x, y, z] of positions(command)) {
        expect(x).toBeGreaterThanOrEqual(x1)
        expect(x).toBeLessThanOrEqual(x2)
        expect(z).toBeGreaterThanOrEqual(z1)
        expect(z).toBeLessThanOrEqual(z2)
        expect(y).toBeGreaterThanOrEqual(-64)
        // The arena's platform is x and z -8 to 24, at y -61: nothing is built on it.
        const onPlatform = x >= -8 && x <= 24 && z >= -8 && z <= 24
        expect(onPlatform).toBe(false)
      }
  })

  test('a new player is told how to duel, and of the parkour and pit only where they are', () => {
    const tick = commands('tick')
    const welcome = tick.filter((command) => command.includes('tag=!cubepals.welcomed'))
    expect(welcome[0]).toContain('/duel join')
    expect(welcome[1]).toStartWith('execute if block -32 -55 0 minecraft:gold_block run tellraw')
    expect(commands('build')).toContain('setblock -32 -55 0 minecraft:gold_block')
    expect(welcome.at(-1)).toBe('tag @a[tag=!cubepals.welcomed] add cubepals.welcomed')
  })

  test('the pit gives its kit once on the way in, and again only after losing', () => {
    const tick = commands('tick')
    const giving = tick.filter((command) =>
      /^(clear|item replace|give) @a\[tag=!cubepals\.pit,/.test(command),
    )
    // Its inventory is cleared first, then the kit, then the player is marked as having it.
    expect(giving[0]).toStartWith('clear ')
    expect(tick.indexOf(giving.at(-1) ?? '')).toBeLessThan(
      tick.findIndex((command) => command.startsWith('tag @a[tag=!cubepals.pit,')),
    )
    expect(tick).toContain('tag @a[scores={cubepals.died=1..}] remove cubepals.pit')
    expect(commands('load')).toContain('scoreboard objectives add cubepals.died deathCount')
  })

  test('the pit is built closed: a glass lid over its inside at the rim, and a sign that says why', () => {
    const build = commands('build')
    expect(build).toContain('fill -6 -61 -26 8 -61 -12 minecraft:white_stained_glass')
    // The lid comes after the inside is cleared, which stops below it.
    expect(build.indexOf('fill -6 -61 -26 8 -61 -12 minecraft:white_stained_glass')).toBeGreaterThan(
      build.findIndex((command) => command.endsWith('minecraft:air')),
    )
    expect(build.find((command) => command.endsWith('minecraft:air'))).toBe(
      'fill -6 -63 -26 8 -62 -12 minecraft:air',
    )
    const sign = build.findIndex((command) => command.startsWith('setblock 2 -60 -11 minecraft:oak_sign'))
    expect(build[sign + 1]).toContain('"the pit is closed:","it opens when","two can fight"')
  })

  test('the lid opens when two outside a duel can fight, and closes under two only over an empty pit', () => {
    const tick = commands('tick')
    expect(tick).toContain(
      'execute as @a[gamemode=!spectator] unless items entity @s container.* minecraft:bow run scoreboard players add #waiting cubepals.waiting 1',
    )
    expect(commands('load')).toContain('scoreboard objectives add cubepals.waiting dummy')
    // The count starts from nothing each tick, before anything reads it.
    const counted = tick.indexOf('scoreboard players set #waiting cubepals.waiting 0')
    const opening = tick.find((command) => command.endsWith('run function cubepals:open')) ?? ''
    const closing = tick.find((command) => command.endsWith('run function cubepals:close')) ?? ''
    expect(counted).toBeGreaterThanOrEqual(0)
    expect(counted).toBeLessThan(tick.indexOf(opening))
    expect(opening).toContain('if score #waiting cubepals.waiting matches 2.. ')
    expect(closing).toContain('if score #waiting cubepals.waiting matches ..1 ')
    expect(commands('open')).toEqual([
      'fill -6 -61 -26 8 -61 -12 minecraft:air replace minecraft:white_stained_glass',
      expect.stringContaining('"the pit:","everyone fights","everyone"'),
    ])
    expect(commands('close')).toEqual([
      'fill -6 -61 -26 8 -61 -12 minecraft:white_stained_glass replace minecraft:air',
      expect.stringContaining('"the pit is closed:","it opens when","two can fight"'),
    ])
    // Never over a player: nobody may be anywhere in the pit, the lid's own layer included.
    const [, x = 0, y = 0, z = 0, dx = 0, dy = 0, dz = 0] = (
      /unless entity @a\[x=(-?\d+),y=(-?\d+),z=(-?\d+),dx=(\d+),dy=(\d+),dz=(\d+)\]/.exec(closing) ?? []
    ).map(Number)
    expect([x, z, x + dx, z + dz]).toEqual([-6, -26, 8, -12])
    expect(y).toBeLessThanOrEqual(-63)
    // The box reaches from y to y + dy + 1, so through the top of the lid's layer, -61.
    expect(y + dy + 1).toBeGreaterThanOrEqual(-60)
  })

  test('a player in the pit is told the way out, and leaves by it without the kit', () => {
    const tick = commands('tick')
    expect(commands('build')).toContain('fill 7 -64 -26 8 -64 -25 minecraft:lime_concrete')
    const told = tick.find((command) => command.startsWith('tellraw @a[tag=!cubepals.pit,')) ?? ''
    expect(told).toContain('green square')
    // Told once, on the way in: before the player is marked as having the kit.
    expect(tick.indexOf(told)).toBeLessThan(
      tick.findIndex((command) => command.startsWith('tag @a[tag=!cubepals.pit,')),
    )
    expect(tick).toContain(
      'execute as @a[x=-6,y=-64,z=-26,dx=14,dy=3,dz=14] at @s if block ~ ~-1 ~ minecraft:lime_concrete run function cubepals:leave',
    )
    const leave = commands('leave')
    // The kit is taken before the player is moved, and they get it again next time they drop in.
    expect(leave[0]).toBe('clear @s')
    expect(leave).toContain('tag @s remove cubepals.pit')
    expect(leave.at(-1)).toStartWith('tp @s ')
  })
})

describe('the way out of the pit, marked', () => {
  test('an open door over the way out stands on the pit wall beside it, clear of every block the pit is built of, once', () => {
    const solid = builtBlocks()
    const room = markerRoom(EXIT_MARKER)
    const inside = [...solid].filter((at) =>
      inRoom(room, at.split(' ').map(Number) as [number, number, number]),
    )
    expect(inside).toEqual([])
    // On the wall: the block behind it, east, is the pit's, and the way out is under it.
    expect(solid.has('9 -62 -25')).toBe(true)
    expect(commands('build')).toContain('fill 7 -64 -26 8 -64 -25 minecraft:lime_concrete')
    const shows = commands('tick').filter((command) => command.includes('summon minecraft:item_display'))
    expect(shows).toHaveLength(1)
    expect(shows[0]).toContain('unless entity @e[type=minecraft:item_display,tag=cubepals.exit]')
  })
})
