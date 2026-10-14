// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The datapack Cubepals writes so a player alone on a Duels server has something to do, read the
 * way Minecraft reads it: where it goes, which releases load it, where it builds, and what it says.
 */
import { describe, expect, test } from 'bun:test'
import { onLevel } from '../domain/revision/carried.ts'
import { placeablePath } from './carried.ts'
import { WAITING_FILES } from './duels-waiting.ts'

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
})
