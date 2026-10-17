// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's datapack, read the way Minecraft reads it: where it goes, which releases load it,
 * that every function it calls is one it has, that it builds only where its chunks are loaded and
 * each game in its own place, that the parkour's stages run in order, what it tells a new player,
 * and that the credits name every map.
 */
import { describe, expect, test } from 'bun:test'
import { onLevel, RUNNING_LEVEL } from '../domain/revision/carried.ts'
import { HINT, PADS, PASSAGE } from './arcade/hub.ts'
import { ARCADE_MAPS } from './arcade/maps.ts'
import { ARCADE_FILES } from './arcade.ts'
import { placeablePath } from './carried.ts'

const PACK = 'world-2/datapacks/cubepals-arcade'

/**
 * The most blocks one `fill` may change: the game rule `max_block_modifications`, 32768 by default
 * (Minecraft 26.2, `gamerule max_block_modifications` on a new world).
 */
const MAX_BLOCK_CHANGES = 32768
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
  commands('play')
    .filter((command) => command.startsWith('team join '))
    .map((command) => [command.split(' ')[2] ?? '', boxOf(command)]),
)

describe('the Arcade datapack as Minecraft loads it', () => {
  test('it goes in the world the server runs, at paths Cubepals may write, and runs as the world loads', () => {
    for (const file of files) {
      expect(
        file.path.startsWith(`${PACK}/`) || /^world-2\/data\/minecraft\/maps\/92\d\d\.dat$/.test(file.path),
      ).toBe(true)
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
    expect(commands('build').slice(0, 2)).toEqual([
      'execute unless block 175 78 1438 minecraft:black_concrete run return run scoreboard players set #build arcade.tmp -2',
      'function arcade:rules',
    ])
    expect(everyCommand.filter((command) => command.startsWith('gamerule '))).toEqual(
      commands('rules').filter((command) => command.startsWith('gamerule ')),
    )
  })

  test('it builds a moment after the world loads, and only in chunks the load forces', () => {
    expect(commands('load').at(-1)).toBe('scoreboard players set #build arcade.tmp 40')
    expect(commands('tick')).toEqual([
      'execute if score #build arcade.tmp matches 1.. run scoreboard players remove #build arcade.tmp 1',
      'execute if score #build arcade.tmp matches 0 run function arcade:build',
      'execute if score #build arcade.tmp matches -1 run function arcade:play',
    ])
    const forced = commands('load')
      .filter((command) => command.startsWith('forceload add '))
      .map((command) => {
        const [x1 = 0, z1 = 0, x2 = 0, z2 = 0] = (command.match(/-?\d+/g) ?? []).map(Number)
        return { x: [x1, x2], y: [-64, 320], z: [z1, z2] } as Box
      })
    const building = commands('build').filter((command) => /^(fill|setblock|summon) /.test(command))
    expect(building.length).toBeGreaterThan(20)
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
  test('no fill or clone changes more blocks than one command may, as max_block_modifications allows', () => {
    for (const command of everyCommand.filter((line) => /^(fill|clone) /.test(line))) {
      const [x1 = 0, y1 = 0, z1 = 0, x2 = 0, y2 = 0, z2 = 0] = (command.match(/-?\d+/g) ?? []).map(Number)
      const blocks = (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1) * (Math.abs(z2 - z1) + 1)
      expect(`${command}: ${blocks <= MAX_BLOCK_CHANGES}`).toBe(`${command}: true`)
    }
  })

  test('each game has its place, apart from the hub and from each other', () => {
    expect([...zones.keys()].sort()).toEqual(['arcade.floor', 'arcade.hub', 'arcade.parkour', 'arcade.pit'])
    const all = [...zones.values()]
    for (const [i, a] of all.entries()) for (const b of all.slice(i + 1)) expect(overlaps(a, b)).toBe(false)
  })

  test('the hub sends a player to each game, into its place and off every pad', () => {
    const pads = PADS.map(({ middle: [x, y, z] }) => boxOf(`x=${x - 1},y=${y + 1},z=${z - 1},dx=2,dy=1,dz=2`))
    // Every teleport a command makes, through the functions it runs.
    const places = (command: string): string[] => {
      const called = command.match(/(?:^| run )function arcade:([a-z/_]+)$/)?.[1]
      if (called !== undefined) return commands(called).flatMap(places)
      return /(?:^| run )tp @s /.test(command) ? [command] : []
    }
    for (const pad of PADS) {
      const arrivals = places(pad.sends)
      expect(arrivals.length).toBeGreaterThan(0)
      for (const tp of arrivals) {
        const [x = 0, y = 0, z = 0] = (tp.split('tp @s ')[1] ?? '').split(' ').map(Number)
        const arrival = [Math.floor(x), Math.floor(y), Math.floor(z)]
        const team = [...zones].find(([, zone]) => inside(zone, arrival))?.[0]
        expect(team).toBeDefined()
        expect(team).not.toBe('arcade.hub')
        for (const other of pads) expect(inside(other, arrival)).toBe(false)
      }
    }
  })

  test('walking on through either doorway between the house and the hall arrives past the other, in the hub', () => {
    const arrivals = [PASSAGE.house.arrive, PASSAGE.hall.arrive]
    const ways = commands('play').filter((command) => arrivals.some((at) => command.endsWith(`tp @s ${at}`)))
    expect(ways).toHaveLength(2)
    const boxes = ways.map((command) => boxOf(command))
    for (const way of ways) {
      const [x = 0, y = 0, z = 0] = (way.split('tp @s ')[1] ?? '').split(' ').map(Number)
      const arrival = [Math.floor(x), Math.floor(y), Math.floor(z)]
      expect(inside(zones.get('arcade.hub') ?? boxOf(''), arrival)).toBe(true)
      for (const through of boxes) expect(inside(through, arrival)).toBe(false)
    }
  })

  test("the parkour's checkpoints and stages are reached in order, and the finish only after all", () => {
    const steps = commands('play')
      .map((command) => command.match(/scores=\{arcade\.pk\.cp=(\d+)\}.* arcade\.pk\.cp (\d+)$/))
      .filter((match) => match !== null)
      .map((match) => [Number(match[1]), Number(match[2])])
    expect(steps.length).toBeGreaterThan(4)
    for (const [from = 0, to = 0] of steps) expect(to).toBe(from + 1)
    const last = Math.max(...steps.map(([, to = 0]) => to))
    const finishing = commands('play').filter((command) =>
      command.endsWith('run function arcade:parkour/finish'),
    )
    expect(finishing).toHaveLength(1)
    expect(finishing[0]).toContain(`scores={arcade.pk.cp=${last}}`)
  })

  test('a new player is put at the hub and told in one sentence what to do, and whose maps these are, once', () => {
    const welcome = commands('play').filter((command) => command.includes('tag=!arcade.welcomed'))
    expect(welcome).toHaveLength(4)
    expect(welcome[0]).toBe('execute as @a[tag=!arcade.welcomed] run function arcade:hub/back')
    expect(welcome[1]).toContain('See if you can get your name on the boards.')
    // How to start a game, as they arrive and on each return: once, not every tick.
    expect(commands('hub/back')).toContain(`tellraw @s {text:"${HINT}",color:"gray"}`)
    expect(commands('play').filter((command) => command.includes(HINT))).toEqual([])
    expect(welcome[2]).toContain('Made of maps by NetherGames and the Overcast community.')
    expect(welcome[2]).toContain('Type /trigger credits')
    expect(welcome[3]).toBe('tag @a[tag=!arcade.welcomed] add arcade.welcomed')
  })

  test('a player back from dying is put at the hub, since a spawn under a roof moves onto it', () => {
    expect(commands('play')).toContain(
      'execute as @e[type=minecraft:player,scores={arcade.died=1..}] run function arcade:hub/back',
    )
    expect(commands('hub/back')).toContain('scoreboard players reset @s arcade.died')
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

describe('the Arcade’s credits and its Cubepals signs', () => {
  test('the credits name every map, who built it, its licence and source as links, and what changed', () => {
    const lines = commands('hub/credits').filter((line) => line.startsWith('tellraw '))
    for (const map of ARCADE_MAPS) {
      const line = lines.find((candidate) => candidate.includes(`text:"${map.title}"`)) ?? ''
      for (const builder of map.builders) expect(line).toContain(builder)
      expect(line).toContain(map.licence)
      const links = [...line.matchAll(/open_url",url:"([^"]+)"/g)].map((link) => link[1])
      expect(links).toEqual([
        `https://creativecommons.org/licenses/${map.licence === 'CC BY 4.0' ? 'by' : 'by-sa'}/4.0/`,
        expect.stringMatching(/^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[0-9a-f]{40}\//),
      ])
      expect(map.changes.length).toBeGreaterThan(0)
      for (const change of map.changes) expect(line).toContain(change)
    }
    expect(lines.join('\n')).toContain('CC BY-SA 4.0 too')
  })

  test("each game's Cubepals sign names its map and who built it, in one line under it", () => {
    // The parkour has none: its sign stood over the first course's stairs, and is taken down.
    const lines = everyCommand.filter(
      (c) => c.startsWith('summon minecraft:text_display') && c.includes(', by '),
    )
    expect(lines.map((c) => c.match(/text:\["",\{text:"([^"]+)"/)?.[1])).toEqual([
      'Meltdown, by NetherGames',
      'Frozen Market, by _3Each',
    ])
  })

  test('each sign’s mark is map art, a map to a block of its square, every map one the datapack carries', () => {
    const frames = everyCommand.filter((c) => c.startsWith('summon minecraft:glow_item_frame'))
    // Six blocks square over the hub, four at the floor, and four twice back to back at the pit.
    expect(frames).toHaveLength(6 * 6 + 4 * 4 + 2 * 5 * 5)
    const carried = new Set(
      ARCADE_FILES.filter((file) => file.encoding === 'base64').map((file) => file.path),
    )
    for (const frame of frames) {
      expect(frame).toContain('Fixed:1b,Invisible:1b')
      const id = frame.match(/"minecraft:map_id":(\d+)/)?.[1]
      expect(carried.has(`${RUNNING_LEVEL}/data/minecraft/maps/${id}.dat`)).toBe(true)
    }
    // Nothing of the mark is a block or a patch of colour.
    expect(everyCommand.filter((c) => c.startsWith('summon minecraft:block_display'))).toEqual([])
    expect(everyCommand.filter((c) => c.includes(`background:${0xff000000 | 0xf8f7f5}`))).toEqual([])
  })
})

describe('the Arcade’s signs out of play', () => {
  test('a sign that stood where players play is taken down as the datapack builds, before any sign goes up', () => {
    const build = commands('build')
    // Over the parkour's first stairs, and the pit's two, over the long hall's north gable, where
    // they first stood and where they were raised to: taken down before the new ones, in the
    // market's spruce, go up on the hall's ridge.
    expect(build).toContain('fill 993 68 -2 995 73 3 minecraft:air')
    const pitSign = build.findIndex((command) => command.endsWith('minecraft:spruce_planks'))
    for (const taken of [
      'fill -1048 88 0 -1043 93 1 minecraft:air',
      'fill -1048 88 1 -1043 93 2 minecraft:air',
      'fill -1048 92 0 -1043 97 1 minecraft:air',
      'fill -1048 92 1 -1043 97 2 minecraft:air',
    ]) {
      expect(build).toContain(taken)
      expect(build.indexOf(taken)).toBeLessThan(pitSign)
    }
  })
})
