// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { DEFAULT_LAUNCHER, inInstanceOn, LAUNCHERS, systemOf } from './saves-folders.ts'

describe('the system a browser runs on', () => {
  test('is Windows, macOS or Linux, and nothing for a phone or tablet', () => {
    expect(systemOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('Windows')
    expect(systemOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe('macOS')
    expect(systemOf('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('Linux')
    expect(systemOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15')).toBeNull()
    expect(systemOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36')).toBeNull()
  })
})

describe('the launchers', () => {
  test('start with the game’s own, the one taken until a player picks another', () => {
    expect(LAUNCHERS[0]?.id).toBe(DEFAULT_LAUNCHER)
    expect(new Set(LAUNCHERS.map((l) => l.id)).size).toBe(LAUNCHERS.length)
  })

  test('each name a folder on every system, written as that system writes paths', () => {
    for (const launcher of LAUNCHERS) {
      expect(launcher.folders.Windows).not.toContain('/')
      expect(launcher.folders.macOS).toStartWith('~/')
      expect(launcher.folders.Linux).toStartWith('~/')
    }
  })

  test('a launcher with instances says where an instance keeps its worlds', () => {
    const prism = LAUNCHERS.find((l) => l.id === 'prism')
    if (prism === undefined) throw new Error('No Prism Launcher')
    expect(inInstanceOn(prism, 'Windows')).toBe('minecraft\\saves')
    expect(inInstanceOn(prism, 'Linux')).toBe('minecraft/saves')
    const game = LAUNCHERS.find((l) => l.id === DEFAULT_LAUNCHER)
    if (game === undefined) throw new Error('No Minecraft Launcher')
    expect(inInstanceOn(game, 'macOS')).toBeNull()
  })
})
