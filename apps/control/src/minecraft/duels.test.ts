import { describe, expect, test } from 'bun:test'
import { nextLevelName } from '../domain/world/world.ts'
import { DUELS_FILES } from './duels.ts'

const fileAt = (path: string) => Bun.YAML.parse(DUELS_FILES.find((file) => file.path === path)?.content ?? '')

/** A place in the plugin's shape. */
interface Place {
  World: string
  X: number
  Y: number
  Z: number
}

describe('what Cubepals writes for Duels', () => {
  test('both fighters and the lobby stand on the void world’s platform, in the first world', () => {
    const { Arenas } = fileAt('plugins/Duels/config.yml') as { Arenas: Record<string, Record<string, Place>> }
    const arena = Arenas['1'] ?? {}
    for (const place of [arena['Spawn-One'], arena['Spawn-Two'], arena.Lobby]) {
      expect(place?.World).toBe(nextLevelName([]))
      // The platform is stone from x -8 to 24 and z -8 to 24, its top at y -61 (booted 2026-10-09).
      expect(place?.Y).toBe(-60)
      for (const along of [place?.X ?? -99, place?.Z ?? -99]) {
        expect(along).toBeGreaterThanOrEqual(-8)
        expect(along).toBeLessThan(25)
      }
    }
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
