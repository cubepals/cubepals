/**
 * Answers and files from real servers, captured on 2026-10-07 into `player-fixtures/`: vanilla
 * 1.20.1 joined by a mineflayer bot, and Fabric 26.3 (with ViaFabric, so the same bot could join)
 * — the oldest and newest releases Blockly offers. Each player was given items, sent to the
 * Nether, killed, and moved again, so where they are and where they died differ.
 */
import { describe, expect, test } from 'bun:test'
import { LibraryFileFormats } from '../infra/formats/file-formats.ts'
import {
  accepted,
  livePlayerQueries,
  parseLivePlayer,
  parsePlayerFiles,
  playerFromFile,
  readPlayerFiles,
  setGameMode,
  statsFromFile,
  teleportTo,
  teleportToSpawn,
  worldSpawn,
} from './players.ts'

const FIXTURES = `${import.meta.dir}/player-fixtures`
const formats = new LibraryFileFormats()
const bytes = async (path: string) => new Uint8Array(await Bun.file(`${FIXTURES}/${path}`).arrayBuffer())
const answersOf = async (version: string) =>
  ((await Bun.file(`${FIXTURES}/${version}/rcon.json`).json()) as { answers: Record<string, string> }).answers

describe('a player who is on, from the console', () => {
  test('1.20.1', async () => {
    const answers = await answersOf('1.20.1')
    const facts = parseLivePlayer(livePlayerQueries('Kai').map((q) => answers[q] ?? null))
    expect(facts?.position).toEqual({ dimension: 'minecraft:the_nether', x: 5.5, y: 70, z: -7.5 })
    expect(facts?.lastDeath).toEqual({ dimension: 'minecraft:overworld', x: 12, y: -60, z: 34 })
    expect(facts?.gameMode).toBe('creative')
    const inventory = facts?.inventory
    expect(inventory?.hotbar[0]).toEqual({
      id: 'minecraft:diamond_sword',
      count: 1,
      name: 'Ow',
      named: true,
      enchantments: ['Sharpness III'],
      potion: null,
      durability: { left: 1556, max: 1561 },
    })
    expect(inventory?.hotbar[1]?.potion).toBe('Swiftness')
    expect(inventory?.hotbar[2]).toMatchObject({ id: 'minecraft:oak_log', count: 32, name: 'Oak Log' })
    expect(inventory?.hotbar[8]).toMatchObject({ id: 'minecraft:stone', count: 64 })
    expect(inventory?.main[4]).toMatchObject({ id: 'minecraft:torch', count: 10 })
    expect(inventory?.armor.head?.id).toBe('minecraft:iron_helmet')
    expect(inventory?.offhand?.id).toBe('minecraft:shield')
    expect(inventory?.enderChest[0]).toMatchObject({ id: 'minecraft:diamond', count: 12 })
    expect(inventory?.enderChest[26]).toMatchObject({ id: 'minecraft:oak_planks', count: 3 })
  })

  test('26.3: items in components, armor and the offhand in `equipment`', async () => {
    const answers = await answersOf('26.3')
    const facts = parseLivePlayer(livePlayerQueries('Fern').map((q) => answers[q] ?? null))
    expect(facts?.position).toEqual({ dimension: 'minecraft:the_nether', x: 3.5, y: 80, z: -4.5 })
    expect(facts?.lastDeath).toEqual({ dimension: 'minecraft:the_nether', x: 12, y: 70, z: 34 })
    expect(facts?.gameMode).toBe('adventure')
    const inventory = facts?.inventory
    expect(inventory?.hotbar[0]).toMatchObject({
      name: 'Ow',
      named: true,
      enchantments: ['Sharpness III'],
      durability: { left: 1556, max: 1561 },
    })
    expect(inventory?.hotbar[1]).toMatchObject({ name: 'Potion', potion: 'Swiftness' })
    expect(inventory?.armor.head?.id).toBe('minecraft:iron_helmet')
    expect(inventory?.offhand?.id).toBe('minecraft:shield')
    expect(inventory?.enderChest[26]).toMatchObject({ id: 'minecraft:oak_planks', count: 3 })
  })

  test('nobody died yet: no death, the rest as it is', async () => {
    const answers = await answersOf('26.3')
    const queries = livePlayerQueries('Fern')
    const facts = parseLivePlayer(
      queries.map((q) =>
        q.endsWith('LastDeathLocation')
          ? 'Found no elements matching LastDeathLocation'
          : (answers[q] ?? null),
      ),
    )
    expect(facts?.lastDeath).toBeNull()
    expect(facts?.gameMode).toBe('adventure')
  })

  test('someone who left: not on', async () => {
    expect(parseLivePlayer(livePlayerQueries('Nobody').map(() => 'No entity was found'))).toBeNull()
    expect(parseLivePlayer(livePlayerQueries('Kai').map(() => null))).toBeNull()
  })
})

describe('a player who is off, from their files', () => {
  for (const [version, mode] of [
    ['1.20.1', 'creative'],
    ['26.3', 'adventure'],
  ] as const)
    test(version, async () => {
      const facts = playerFromFile(await formats.decodeNbt(await bytes(`${version}/player.dat`)))
      expect(facts.gameMode).toBe(mode)
      expect(facts.lastDeath?.y).toBe(version === '26.3' ? 70 : -60)
      expect(facts.position).not.toBeNull()
      expect(facts.inventory.hotbar[0]).toMatchObject({ name: 'Ow', enchantments: ['Sharpness III'] })
      expect(facts.inventory.armor.head?.id).toBe('minecraft:iron_helmet')
      expect(facts.inventory.enderChest[0]).toMatchObject({ id: 'minecraft:diamond', count: 12 })
    })

  test('their stats: time played and deaths', async () => {
    expect(statsFromFile(await Bun.file(`${FIXTURES}/1.20.1/stats.json`).json())).toEqual({
      playMinutes: 0,
      deaths: 2,
    })
    expect(statsFromFile({ stats: { 'minecraft:custom': { 'minecraft:play_time': 20 * 60 * 95 } } })).toEqual(
      {
        playMinutes: 95,
        deaths: 0,
      },
    )
    // Before 1.17 the same count had another name; a world can come from then.
    expect(
      statsFromFile({ stats: { 'minecraft:custom': { 'minecraft:play_one_minute': 1200 } } }).playMinutes,
    ).toBe(1)
  })

  test("the world's spawn: SpawnX… in 1.20.1, `spawn` in 26.3", async () => {
    expect(worldSpawn(await formats.decodeNbt(await bytes('1.20.1/level.dat')))).toEqual({
      dimension: 'minecraft:overworld',
      x: 0,
      y: -60,
      z: 0,
    })
    expect(worldSpawn(await formats.decodeNbt(await bytes('26.3/level.dat')))).toEqual({
      dimension: 'minecraft:overworld',
      x: 0,
      y: -60,
      z: 0,
    })
  })

  test('the exec that reads them, and what it prints', async () => {
    const [, , script] = readPlayerFiles(['448a9b5a-70a4-3580-8434-cb045d45ca1f'])
    expect(script).toContain('players/data')
    expect(script).toContain('playerdata')
    expect(() => readPlayerFiles(['../../etc/passwd'])).toThrow()
    const data = await bytes('26.3/player.dat')
    const stdout = [
      '@@level@@',
      '',
      '@@data 448a9b5a-70a4-3580-8434-cb045d45ca1f@@',
      Buffer.from(data).toString('base64'),
      '@@stats 448a9b5a-70a4-3580-8434-cb045d45ca1f@@',
      '{"stats":{}}',
      '',
    ].join('\n')
    const files = parsePlayerFiles(stdout)
    expect(files.level).toBeNull()
    expect(files.players.get('448a9b5a-70a4-3580-8434-cb045d45ca1f')).toEqual({ data, stats: '{"stats":{}}' })
  })
})

describe('what the page asks of the console', () => {
  test('the commands, and the answers that mean it worked', async () => {
    const place = { dimension: 'minecraft:overworld', x: 12, y: -60, z: 34 }
    expect(teleportTo('Kai', place)).toEqual(['execute in minecraft:overworld run tp Kai 12.5 -60 34.5'])
    expect(teleportToSpawn('Kai', { ...place, x: 0, z: 0 })[0]).toBe(
      'execute in minecraft:overworld run spreadplayers 0.5 0.5 0 1 false Kai',
    )
    expect(setGameMode('Kai', 'creative')).toEqual(['gamemode creative Kai'])
    expect(() => setGameMode('Kai; stop', 'creative')).toThrow()
    for (const version of ['1.20.1', '26.3']) {
      const answers = await answersOf(version)
      const name = version === '26.3' ? 'Fern' : 'Kai'
      for (const [command, answer] of Object.entries(answers)) {
        if (/^(execute .* run (tp|spreadplayers)|gamemode)/.test(command))
          expect([command, accepted(answer)]).toEqual([command, !command.includes('Nobody')])
      }
      expect(accepted(answers[`gamemode adventure ${name}`] ?? '')).toBe(true)
    }
    expect(accepted('Could not spread 1 entity around 0.5, 0.5 (too many entities for space)')).toBe(false)
  })
})
