// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The datapack Cubepals writes so a player on a Duels server has something to do while they wait,
 * read the way Minecraft reads it: where it goes, which releases load it, where it places its maps,
 * how the parkour, the pit and the lobby play, and what it says.
 */
import { describe, expect, test } from 'bun:test'
import { onLevel } from '../domain/revision/carried.ts'
import { inRoom, markerRoom } from './arcade/label-space.ts'
import { placeablePath } from './carried.ts'
import { DUELS_MAPS, DUELS_SOURCES, placed } from './duels-waiting/maps.ts'
import {
  PARKOUR_FINISHES,
  PARKOUR_LOBBY,
  PARKOUR_PAD,
  PARKOUR_START,
  START_EXIT,
} from './duels-waiting/parkour.ts'
import { IN_PIT, OUTSIDE, PIT_EXIT, PIT_PAD, PIT_SIGN } from './duels-waiting/pit.ts'
import { DUELS_PLACES, EXIT_MARKER, START_SIGNS, WAITING_FILES } from './duels-waiting.ts'
import { LICENCES } from './map-credits.ts'
import { marqueeExtent } from './marquee.ts'

const PACK = 'world-2/datapacks/cubepals-duels'

/** A file as a server running `world-2` has it. */
const fileOf = (path: string) =>
  WAITING_FILES.map((file) => onLevel(file, 'world-2')).find((file) => file.path === `${PACK}/${path}`)
const fileAt = (path: string) => fileOf(path)?.content ?? ''

/** A function's commands, one to a line. */
const commands = (name: string) => fileAt(`data/cubepals/function/${name}.mcfunction`).trim().split('\n')

/** The numbers a command names, in order. */
const numbers = (command: string) => (command.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)

/** A selector's box, `x=…,dx=…`, as its least and greatest corners, both included. */
function boxOf(selector: string): { from: readonly number[]; to: readonly number[] } {
  const [x = 0, y = 0, z = 0, dx = 0, dy = 0, dz = 0] = (
    /x=(-?\d+),y=(-?\d+),z=(-?\d+),dx=(-?\d+),dy=(-?\d+),dz=(-?\d+)/.exec(selector) ?? []
  )
    .slice(1)
    .map(Number)
  return { from: [x, y, z], to: [x + dx, y + dy, z + dz] }
}
const within = (at: readonly number[], { from, to }: { from: readonly number[]; to: readonly number[] }) =>
  at.every((n, i) => n >= (from[i] ?? 0) && n <= (to[i] ?? 0) + 1)

/** The void world's platform, where the Duels plugin's arena is: x and z -8 to 24, its top at y -61. */
const onPlatform = ([x = 0, , z = 0]: readonly number[]) => x >= -8 && x <= 24 && z >= -8 && z <= 24

describe('the datapack for waiting on a Duels server', () => {
  test('it goes in the world the server runs, at paths Cubepals may write, its signs’ maps in the world’s data', () => {
    for (const file of WAITING_FILES.map((carried) => onLevel(carried, 'world-2'))) {
      expect(file.path.startsWith(`${PACK}/`) || /^world-2\/data\/map_92\d\d\.dat$/.test(file.path)).toBe(
        true,
      )
      expect(placeablePath(file.path)).toBe(true)
    }
    // The big sign's sixteen maps and the start signs' four; the maps' structures are carried beside.
    expect(WAITING_FILES.filter((file) => file.encoding === 'base64')).toHaveLength(16 + 4)
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

  test('it builds on a void world only, a moment after it loads, in chunks it keeps loaded, off the arena', () => {
    const load = commands('load')
    expect(load.at(-1)).toBe(
      'execute if block 8 -62 8 minecraft:air run scoreboard players set #build cubepals.waiting 40',
    )
    expect(commands('tick')).toContain(
      'execute if score #build cubepals.waiting matches 0 run function cubepals:build',
    )
    const [x1 = 0, z1 = 0, x2 = 0, z2 = 0] = numbers(load.find((c) => c.startsWith('forceload add ')) ?? '')
    const kept = ([x = 0, , z = 0]: readonly number[]) => x >= x1 && x <= x2 && z >= z1 && z <= z2
    for (const map of DUELS_MAPS) {
      expect(kept(placed(map.key, map.from))).toBe(true)
      expect(kept(placed(map.key, map.to))).toBe(true)
      expect(placed(map.key, map.from)[1]).toBeGreaterThanOrEqual(-64)
      // Nothing of a map is on the platform, at any corner of its box.
      for (const x of [map.from[0], map.to[0]])
        for (const z of [map.from[2], map.to[2]]) expect(onPlatform(placed(map.key, [x, 0, z]))).toBe(false)
    }
    for (const command of commands('build').filter((c) => /^(setblock|fill) /.test(c))) {
      const at = numbers(command)
      expect(`${command}: ${kept(at)}`).toBe(`${command}: true`)
      expect(onPlatform(at.slice(0, 3))).toBe(false)
    }
  })
})

describe('the published maps', () => {
  test('each is placed from its own structure, its first corner at its box’s, moved to where it sits', () => {
    const build = commands('build')
    for (const map of DUELS_MAPS)
      expect(build).toContain(`place template cubepals:${map.key} ${placed(map.key, map.from).join(' ')}`)
    // The old lobby, built block by block, comes down before the maps go in.
    const firstPlace = build.findIndex((c) => c.startsWith('place template '))
    expect(build.indexOf('fill -33 -61 -2 -11 -55 2 minecraft:air')).toBeLessThan(firstPlace)
    expect(build.indexOf('fill -7 -64 -27 9 -60 -9 minecraft:air')).toBeLessThan(firstPlace)
  })

  test('every map is credited with its builders, licence and source, in the game and beside the structures', () => {
    const credits = commands('credits')
    const text = fileAt('CREDITS.txt')
    for (const map of DUELS_MAPS) {
      const source = DUELS_SOURCES[map.key]
      expect(source).toBeDefined()
      expect(Object.keys(LICENCES)).toContain(map.licence)
      expect(map.changes.length).toBeGreaterThan(0)
      expect(credits.some((line) => line.includes(map.title) && line.includes(map.builders.join(', ')))).toBe(
        true,
      )
      expect(text).toContain(`${map.title} (${map.role})`)
      expect(text).toContain(`${source?.repo}/tree/${source?.commit}/${source?.path}`)
      expect(text).toContain(LICENCES[map.licence].url)
    }
    expect(commands('load')).toContain('scoreboard objectives add credits trigger')
    expect(commands('tick')).toContain('execute as @a[scores={credits=1..}] run function cubepals:credits')
  })
})

describe('the parkour', () => {
  const tick = () => commands('tick')

  test('the pad off the platform’s west edge puts a player on the first start, from the map’s own spawn', () => {
    expect(onPlatform(PARKOUR_PAD.from)).toBe(false)
    expect(PARKOUR_PAD.to[0]).toBe(-9)
    expect(commands('build')).toContain('fill -11 -61 7 -9 -61 9 minecraft:yellow_concrete')
    expect(
      tick().some(
        (c) => c.includes('x=-11,y=-60,z=7,dx=2,dy=0,dz=2') && c.endsWith('function cubepals:parkour/arrive'),
      ),
    ).toBe(true)
    expect(commands('parkour/arrive')[0]).toBe(`tp @s ${PARKOUR_START}`)
    expect(PARKOUR_START).toBe(
      `${placed('ice', [-115.5, 1, 9.5])
        .map((n) => n.toFixed(1))
        .join(' ')} 180 0`,
    )
  })

  test('the clock runs from stepping off the start, and each checkpoint counts only after the one before it', () => {
    const start = boxOf(tick().find((c) => c.startsWith('tag @a[x=')) ?? '')
    expect(start).toEqual({ from: placed('ice', [-117, 1, 8]), to: placed('ice', [-114, 3, 10]) })
    expect(tick()).toContain('scoreboard players add @a[tag=cubepals.pk.run] cubepals.pk.time 1')
    const reaching = tick().filter((c) => /run function cubepals:parkour\/checkpoint \{cp:\d+\}$/.test(c))
    // Ice's three, in order, each from the one before.
    expect(reaching.map((c) => /cp=(\d+)\}/.exec(c)?.[1])).toEqual(['0', '1', '2'])
    expect(reaching.map((c) => /\{cp:(\d+)\}$/.exec(c)?.[1])).toEqual(['1', '2', '3'])
    expect(commands('parkour/checkpoint').at(-1)).toBe('$scoreboard players set @s cubepals.pk.cp $(cp)')
    expect(boxOf(reaching[0] ?? '')).toEqual({
      from: placed('ice', [-130, 11, -10]),
      to: placed('ice', [-127, 14, 7]),
    })
  })

  test('a fall puts a running player back on their last checkpoint; anyone else goes back to the platform', () => {
    const fall = commands('parkour/fall')
    expect(fall[0]).toBe(
      'execute unless entity @s[tag=cubepals.pk.run] run return run function cubepals:parkour/back',
    )
    expect(fall.slice(1)).toHaveLength(5)
    expect(fall[2]).toBe(
      `execute if score @s cubepals.pk.cp matches 1 run tp @s ${placed('ice', [-128.5, 11, -8.5])
        .map((n) => n.toFixed(1))
        .join(' ')} 180 0`,
    )
    expect(commands('parkour/back')).toEqual(['tag @s remove cubepals.pk.run', `tp @s ${PARKOUR_LOBBY}`])
    // The fall is caught under the courses, inside the course's own zone, so the run is still on.
    const fell = boxOf(tick().find((c) => c.endsWith('run function cubepals:parkour/fall')) ?? '')
    const zone = boxOf(tick().find((c) => c.startsWith('team join cubepals.parkour')) ?? '')
    expect(fell.to[1]).toBeLessThan(-61)
    expect(within(fell.from, zone) && within(fell.to, zone)).toBe(true)
  })

  test('finishing Ice starts Debris on the same clock; finishing Debris goes back to the platform with the time', () => {
    const finishing = tick().filter((c) => /run function cubepals:parkour\/(stage2|finish)$/.test(c))
    expect(finishing).toHaveLength(2)
    expect(boxOf(finishing[0] ?? '')).toEqual({ ...PARKOUR_FINISHES[0] } as {
      from: readonly number[]
      to: readonly number[]
    })
    expect(boxOf(finishing[1] ?? '')).toEqual({ ...PARKOUR_FINISHES[1] } as {
      from: readonly number[]
      to: readonly number[]
    })
    const stage = commands('parkour/stage2')
    // The run's checkpoint moves on before the player does, both as the player.
    expect(stage.at(-2)).toBe('scoreboard players set @s cubepals.pk.cp 4')
    expect(stage.at(-1)).toBe(
      `tp @s ${placed('debris', [1.5, 1, -1.5])
        .map((n) => n.toFixed(1))
        .join(' ')} 90 0`,
    )
    expect(commands('parkour/finish')).toContain(`tp @s ${PARKOUR_LOBBY}`)
  })

  test('a best time goes on the board and the sidebar', () => {
    const best = commands('parkour/best')
    expect(best).toContain('function cubepals:boards/submit {board:"pk"}')
    expect(best).toContain('function cubepals:boards/side with storage cubepals:work new')
    expect(commands('load')).toContain('scoreboard objectives setdisplay sidebar.team.aqua cubepals.pk.side')
    expect(commands('build')).toContain('function cubepals:boards/render {board:"pk"}')
    expect(commands('build').some((c) => c.includes('"cubepals.board.pk"'))).toBe(true)
    expect(JSON.parse(fileAt('data/cubepals/loot_table/head.json')).pools).toHaveLength(1)
  })

  test('the green square at the start goes back to the platform', () => {
    expect(commands('build')).toContain(`setblock ${START_EXIT.join(' ')} minecraft:lime_concrete`)
    const [x, y, z] = START_EXIT
    expect(tick()).toContain(
      `execute as @a[gamemode=!spectator] at @s if block ~ ~-1 ~ minecraft:lime_concrete if entity @s[x=${x},y=${y + 1},z=${z},dx=0,dy=0,dz=0] run function cubepals:parkour/back`,
    )
  })
})

describe('the pit', () => {
  test('it is built closed: glass over its pad and over the arena, and a sign by the pad that says why', () => {
    const build = commands('build')
    expect(build.at(build.indexOf('function cubepals:close'))).toBe('function cubepals:close')
    expect(commands('close')).toEqual([
      'fill 7 -60 -11 9 -60 -9 minecraft:white_stained_glass',
      'fill -7 -40 -51 23 -40 -21 minecraft:white_stained_glass',
      expect.stringContaining('"the pit is closed:","it opens when","two can fight"'),
    ])
    expect(build).toContain(
      `setblock ${PIT_SIGN.join(' ')} minecraft:oak_wall_sign[facing=south]{is_waxed:1b}`,
    )
    expect(onPlatform(PIT_PAD.from) || onPlatform(PIT_PAD.to)).toBe(false)
  })

  test('the lid opens when two outside a duel can fight, and closes under two only over an empty pit', () => {
    const tick = commands('tick')
    expect(tick).toContain(
      'execute as @a[gamemode=!spectator] unless items entity @s container.* minecraft:bow run scoreboard players add #waiting cubepals.waiting 1',
    )
    const counted = tick.indexOf('scoreboard players set #waiting cubepals.waiting 0')
    const opening = tick.find((command) => command.endsWith('run function cubepals:open')) ?? ''
    const closing = tick.find((command) => command.endsWith('run function cubepals:close')) ?? ''
    expect(counted).toBeGreaterThanOrEqual(0)
    expect(counted).toBeLessThan(tick.indexOf(opening))
    expect(opening).toContain('if score #waiting cubepals.waiting matches 2.. ')
    expect(closing).toContain('if score #waiting cubepals.waiting matches ..1 ')
    expect(closing).toContain(`unless entity @a[${IN_PIT}]`)
    expect(commands('open')).toEqual([
      'fill 7 -60 -11 9 -60 -9 minecraft:air replace minecraft:white_stained_glass',
      'fill -7 -40 -51 23 -40 -21 minecraft:barrier',
      expect.stringContaining('"the pit:","step on the pad","everyone fights","everyone"'),
    ])
  })

  test('its pad puts a player at one of the arena’s own spawn points with the kit; the green square lets them out without it', () => {
    const arrive = commands('pit/arrive')
    expect(arrive.filter((c) => c.includes(' run tp @s '))).toEqual([
      `execute if score #spawn cubepals.waiting matches 0 run tp @s ${placed('cramped', [0.5, 79, -12.5])
        .map((n) => n.toFixed(1))
        .join(' ')} 0 0`,
      `execute if score #spawn cubepals.waiting matches 1 run tp @s ${placed('cramped', [0.5, 79, 13.5])
        .map((n) => n.toFixed(1))
        .join(' ')} 180 0`,
    ])
    expect(arrive).toContain('function cubepals:pit/kit')
    const kit = commands('pit/kit')
    expect(kit[0]).toBe('clear @s')
    expect(kit).toContain('give @s minecraft:iron_sword')
    expect(kit.some((c) => c.includes('bow'))).toBe(false)
    expect(commands('build')).toContain(
      `fill ${PIT_EXIT.from.join(' ')} ${PIT_EXIT.to.join(' ')} minecraft:lime_concrete`,
    )
    expect(commands('pit/out')).toEqual(['function cubepals:pit/leave', `tp @s ${OUTSIDE}`])
    expect(commands('pit/leave')).toEqual(['clear @s', 'tag @s remove cubepals.pit'])
    // Leaving any other way leaves the kit, but a player who left for a duel keeps the duel's.
    expect(commands('tick')).toContain(
      `execute as @a[tag=cubepals.pit] unless entity @s[${IN_PIT}] unless items entity @s container.* minecraft:bow run function cubepals:pit/leave`,
    )
    expect(commands('tick')).toContain(`kill @e[type=minecraft:item,${IN_PIT}]`)
  })

  test('an open door over the way out stands on the arena’s wall beside it, once', () => {
    const room = markerRoom(EXIT_MARKER)
    // Over the way out, clear of a player standing or jumping on it, with the arena's wall,
    // a block outside its floor, behind it.
    for (const up of [1, 2, 3])
      expect(inRoom(room, [PIT_EXIT.to[0], PIT_EXIT.to[1] + up, PIT_EXIT.to[2]])).toBe(false)
    expect(inRoom(room, [PIT_EXIT.to[0], PIT_EXIT.to[1] + 4, PIT_EXIT.to[2]])).toBe(true)
    expect(EXIT_MARKER.at[0]).toBeCloseTo(PIT_EXIT.to[0] + 1, 1)
    const shows = commands('tick').filter((command) => command.includes('summon minecraft:item_display'))
    expect(shows).toHaveLength(1)
    expect(shows[0]).toContain('unless entity @e[type=minecraft:item_display,tag=cubepals.exit]')
  })
})

describe('the lobby', () => {
  test('a new player is told how to duel, and of the pads and credits only where they are', () => {
    const welcome = commands('tick').filter((command) => command.includes('tag=!cubepals.welcomed'))
    expect(welcome[0]).toContain('/duel join')
    expect(welcome[1]).toStartWith('execute if block -11 -61 7 minecraft:yellow_concrete run tellraw')
    expect(welcome[1]).toContain('yellow pad')
    expect(welcome.at(-1)).toBe('tag @a[tag=!cubepals.welcomed] add cubepals.welcomed')
  })

  test('outside the pit and duels it is peaceful: adventure mode, and no harm dealt or taken', () => {
    const calm = commands('calm')
    expect(calm).toContain('gamemode adventure @s[gamemode=survival]')
    expect(calm).toContain('effect give @s minecraft:weakness infinite 255 true')
    expect(calm).toContain('effect give @s minecraft:resistance infinite 4 true')
    const tick = commands('tick')
    expect(tick).toContain(
      'execute as @a[tag=cubepals.calm] if items entity @s container.* minecraft:bow run function cubepals:uncalm',
    )
    expect(tick).toContain(`execute as @a[tag=cubepals.calm,${IN_PIT}] run function cubepals:uncalm`)
    expect(commands('uncalm')).toContain('effect clear @s minecraft:weakness')
    // Death clears effects, so a player who died is calmed again.
    expect(tick).toContain('tag @a[scores={cubepals.died=1..}] remove cubepals.calm')
  })

  test('every place a player is put is on the platform or in a game with its own way back', () => {
    for (const place of DUELS_PLACES) {
      const at = numbers(place).slice(0, 3)
      const inGame = DUELS_MAPS.some((map) =>
        within(at, { from: placed(map.key, map.from), to: placed(map.key, map.to) }),
      )
      expect(`${place}: ${onPlatform(at) || inGame}`).toBe(`${place}: true`)
    }
  })

  test('a Cubepals sign stands at the start of each game, beside its pad, off the platform', () => {
    for (const sign of START_SIGNS) {
      const [from, to] = marqueeExtent(sign)
      for (const corner of [from, to]) expect(onPlatform(corner)).toBe(false)
    }
    // The parkour's beside its pad, the pit's beside its.
    expect(Math.abs((START_SIGNS[0]?.at[0] ?? 0) - PARKOUR_PAD.from[0])).toBeLessThanOrEqual(2)
    expect(Math.abs((START_SIGNS[1]?.at[2] ?? 0) - PIT_PAD.from[2])).toBeLessThanOrEqual(2)
  })
})
