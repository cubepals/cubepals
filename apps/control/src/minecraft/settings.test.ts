import { describe, expect, test } from 'bun:test'
import { defaultSettings } from '../domain/revision/revision.ts'
import { liveCommands, refusedByGame, settingTakes } from './settings.ts'

describe('settings a running server takes', () => {
  const before = defaultSettings({ name: 'Home', gameMode: 'survival', maxPlayers: 10 })

  test('difficulty and game mode change as people play; what the game reads as it starts restarts it', () => {
    for (const version of ['1.20.1', '1.21.8', '26.3']) {
      expect(settingTakes('difficulty', version)).toBe('now')
      expect(settingTakes('defaultGameMode', version)).toBe('now')
      expect(settingTakes('motd', version)).toBe('next_start')
      for (const setting of [
        'viewDistance',
        'simulationDistance',
        'maxPlayers',
        'spawnProtection',
        'onlineMode',
      ] as const)
        expect(settingTakes(setting, version)).toBe('restart')
    }
  })

  test('PvP changes as people play from the release that made it a game rule', () => {
    expect(settingTakes('pvp', '1.21.8')).toBe('restart')
    expect(settingTakes('pvp', '1.21.9')).toBe('now')
    expect(settingTakes('pvp', '26.3')).toBe('now')
    expect(liveCommands(before, { ...before, pvp: false }, '26.3')).toEqual(['gamerule pvp false'])
    expect(liveCommands(before, { ...before, pvp: false }, '1.21.8')).toEqual([])
  })

  test('a new default game mode moves whoever is on to it', () => {
    expect(
      liveCommands(
        before,
        { ...before, defaultGameMode: 'creative', difficulty: 'hard', motd: 'Hi' },
        '26.3',
      ),
    ).toEqual(['difficulty hard', 'defaultgamemode creative', 'gamemode creative @a'])
    expect(liveCommands(before, before, '26.3')).toEqual([])
  })

  test('a command the game turned down is told from one it ran', () => {
    expect(refusedByGame('Unknown or incomplete command, see below for error')).toBe(true)
    expect(refusedByGame('Incorrect argument for command')).toBe(true)
    expect(refusedByGame('The difficulty has been set to Hard')).toBe(false)
    expect(refusedByGame('No player was found')).toBe(false)
  })
})
