/**
 * What Cubepals writes for Duels, read as the plugin reads it: the arena on the running world's
 * platform, the room built where a world has none, the kit, and who may play.
 */
import { describe, expect, test } from 'bun:test'
import { onLevel } from '../domain/revision/carried.ts'
import { ARENA_COMMANDS, DUELS_FILES } from './duels.ts'

/** A file as a server running `world-2` reads it. */
const fileAt = (path: string) => {
  const file = DUELS_FILES.find((carried) => carried.path === path)
  return Bun.YAML.parse(file === undefined ? '' : onLevel(file, 'world-2').content)
}

/** A place in the plugin's shape. */
interface Place {
  World: string
  X: number
  Y: number
  Z: number
}

describe('what Cubepals writes for Duels', () => {
  test('both fighters and the lobby stand on the void world’s platform, in the world the server runs', () => {
    const { Arenas } = fileAt('plugins/Duels/config.yml') as { Arenas: Record<string, Record<string, Place>> }
    const arena = Arenas['1'] ?? {}
    for (const place of [arena['Spawn-One'], arena['Spawn-Two'], arena.Lobby]) {
      expect(place?.World).toBe('world-2')
      // The platform is stone from x -8 to 24 and z -8 to 24, its top at y -61 (booted 2026-10-09).
      expect(place?.Y).toBe(-60)
      for (const along of [place?.X ?? -99, place?.Z ?? -99]) {
        expect(along).toBeGreaterThanOrEqual(-8)
        expect(along).toBeLessThan(25)
      }
    }
  })

  test('a world without the platform gets a room in its place, and the void world is left alone', () => {
    const [load, ...building] = ARENA_COMMANDS
    expect(load).toBe('forceload add -9 -9 25 25')
    // The platform's cobblestone, which the room's middle becomes, stops each one.
    for (const command of building)
      expect(command).toStartWith('execute unless block 8 -61 8 minecraft:cobblestone run ')
    expect(building.at(-1)).toEndWith('setblock 8 -61 8 minecraft:cobblestone')
    // The room's floor is the platform's, x and z -8 to 24 at y -61, inside walls one block out.
    expect(building[0]).toEndWith('fill -9 -61 -9 25 -48 25 minecraft:stone hollow')
  })

  test('the kit is in the item format the plugin reads on 1.21.11, so it never warns of an old one', () => {
    const { Kits } = fileAt('plugins/Duels/config.yml') as {
      Kits: Record<string, { Name: string; Inventory: string[] }>
    }
    expect(Kits['0']?.Name).toBe('Default')
    // KitChecker calls a kit old when an item says `Count`, the format before 1.20.5.
    for (const item of Kits['0']?.Inventory ?? []) expect(item).not.toContain('Count')
  })

  test('everyone may play, and only operators make arenas and kits', () => {
    const granted = Object.keys(fileAt('permissions.yml') as Record<string, unknown>)
    expect(granted).toContain('duels.join')
    expect(granted).toContain('duels.leave')
    for (const operators of ['duels.createarena', 'duels.kits.create', 'duels.kits.delete', 'duels.admin'])
      expect(granted).not.toContain(operators)
  })
})
