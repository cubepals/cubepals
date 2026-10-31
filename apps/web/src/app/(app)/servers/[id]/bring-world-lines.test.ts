// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What "Bring a world" says: the player's world by its name, and what playing it does. */

import { describe, expect, test } from 'bun:test'
import type { BroughtWorld, PlayedWith } from '@blockly/contracts'
import {
  ADD_INSTANCE_LINE,
  addedLine,
  againLine,
  comingName,
  instanceLine,
  KEPT_LINE,
  leftOutLines,
  modsLine,
  modsPlayOf,
  movesLine,
  noModsLine,
  notAddedLine,
  playedWithLine,
  playLabel,
  serverLine,
  titleOf,
} from './bring-world-lines.ts'

const maple: BroughtWorld = { name: 'Maple Hollow', gameVersion: '1.21.11', newer: null }

/** A world brought with the instance it was played in: two mods come, two are left out. */
const LIFE: PlayedWith = {
  moddedWith: ['fabric'],
  mods: {
    loader: 'fabric',
    mods: [
      { name: 'Tree Harvester', fileName: 'treeharvester-26.3.0-10.4.jar', from: 'modrinth' },
      { name: 'Vein Miner', fileName: 'veinminer-1.0.jar', from: 'own' },
    ],
    forPlayers: [{ name: 'Sodium', fileName: 'sodium-fabric-0.9.3.jar' }],
    leftOut: [{ name: 'Huge Mod', fileName: 'huge.jar', why: 'It is larger than the 128 MB a mod can be.' }],
  },
}
/** The same world brought on its own. */
const WITHOUT: PlayedWith = { moddedWith: ['fabric'], mods: null }

describe('the world by its name while it comes in', () => {
  test('is the name its player gave, else its name in Minecraft, else none', () => {
    expect(comingName('  Our Base ', 'Maple Hollow')).toBe('Our Base')
    expect(comingName('', 'Maple Hollow')).toBe('Maple Hollow')
    expect(comingName(' ', ' ')).toBeNull()
    expect(comingName('', null)).toBeNull()
  })

  test('the title says what is happening to it', () => {
    expect(titleOf('picked', 'Maple Hollow')).toBe('Bring a world')
    expect(titleOf('coming', 'Maple Hollow')).toBe('Bringing Maple Hollow to your server')
    expect(titleOf('coming', null)).toBe('Bringing your world to your server')
    expect(titleOf('ready', 'Maple Hollow')).toBe('Maple Hollow is ready')
    expect(titleOf('refused', null)).toBe('Your world couldn’t come in')
    // A server's world is often called "world": a title that starts with it starts with a capital.
    expect(titleOf('ready', 'world')).toBe('World is ready')
    expect(titleOf('coming', 'world')).toBe('Bringing world to your server')
  })

  test('no word of it is a backup or a restore', () => {
    const said = [
      ...(['picked', 'coming', 'ready', 'refused'] as const).map((stage) => titleOf(stage, 'Maple Hollow')),
      playLabel(maple),
      serverLine('Maple Hollow', 'running'),
      playedWithLine(['fabric']),
      ADD_INSTANCE_LINE,
      modsLine(LIFE, 'vanilla'),
      ...leftOutLines(LIFE),
      noModsLine(WITHOUT, 'Life'),
      againLine('Life'),
      playLabel(maple, 'without'),
    ]
    for (const line of said) expect(line).not.toMatch(/backup|restor/i)
  })
})

describe('playing it', () => {
  test('is pressed by its name, with the release where the server moves up to it', () => {
    expect(playLabel(maple)).toBe('Play Maple Hollow')
    expect(playLabel({ ...maple, newer: { gameVersion: '26.3', movesServer: true } })).toBe(
      'Play Maple Hollow on 26.3',
    )
    // A server with mods moves in its settings, not here.
    expect(playLabel({ ...maple, newer: { gameVersion: '26.3', movesServer: false } })).toBe(
      'Play Maple Hollow',
    )
  })

  test('says once that moving up is for good, and only where this press does it', () => {
    expect(movesLine({ ...maple, newer: { gameVersion: '26.3', movesServer: true } }, '1.21.11')).toBe(
      'Playing it moves this server from Minecraft 1.21.11 up to 26.3, for good: a world can’t go back to an older Minecraft.',
    )
    expect(movesLine(maple, '1.21.11')).toBeNull()
    expect(movesLine({ ...maple, newer: { gameVersion: '26.3', movesServer: false } }, '1.21.11')).toBeNull()
  })

  test('says what the server does, by what it is doing now', () => {
    expect(serverLine('Maple Hollow', 'running')).toBe(
      'The server restarts into Maple Hollow. Anyone online can join again once it’s up.',
    )
    expect(serverLine('Maple Hollow', 'stopped')).toBe(
      'The server is asleep, and wakes on Maple Hollow when someone joins.',
    )
    expect(serverLine('Maple Hollow', 'failed')).toBe('The server starts on Maple Hollow.')
  })

  test('says the world it has now is kept, and where the way back is', () => {
    expect(KEPT_LINE).toBe(
      'The world the server has now is kept, and you can switch back to it from Backups.',
    )
  })
})

describe('the mods it was played with', () => {
  test('are asked for before it is sent, by what its level.dat says', () => {
    expect(playedWithLine(['fabric'])).toBe('This world was played with Fabric mods.')
    expect(playedWithLine(['fabric', 'quilt'])).toBe('This world was played with Fabric and Quilt mods.')
    expect(addedLine({ count: 2, from: 'Fabric 26.3' })).toBe('2 mods from Fabric 26.3 go up with it.')
    expect(addedLine({ count: 1, from: null })).toBe('A mod goes up with it.')
    expect(instanceLine('Fabric 26.3', 3)).toBe(
      'Fabric 26.3 is a launcher’s instance. Cubepals sends the world you choose with its 3 mods, and leaves the rest of it on your computer.',
    )
    expect(notAddedLine('no-mods')).toBe(
      'There are no mods in this folder. Choose the instance you played the world in, or its mods folder.',
    )
  })

  test('once it is read, come and move the server to their loader, and those left out are named', () => {
    expect(modsLine(LIFE, 'vanilla')).toBe(
      'Played with Fabric and 2 mods: Tree Harvester, Vein Miner. Your server moves to Fabric with them.',
    )
    expect(modsLine(LIFE, 'fabric')).toBe(
      'Played with Fabric and 2 mods: Tree Harvester, Vein Miner. Your server gets them too.',
    )
    expect(leftOutLines(LIFE)).toEqual([
      'Left out Sodium: only players’ games run it.',
      'Left out Huge Mod: It is larger than the 128 MB a mod can be.',
    ])
    const many = Array.from({ length: 8 }, (_, at) => ({
      name: `Mod ${at + 1}`,
      fileName: `${at}.jar`,
      from: 'modrinth' as const,
    }))
    const pack = {
      moddedWith: [],
      mods: { loader: 'fabric' as const, mods: many, forPlayers: [], leftOut: [] },
    }
    expect(modsLine(pack, 'vanilla')).toBe(
      'Played with Fabric and 8 mods: Mod 1, Mod 2, Mod 3, Mod 4, Mod 5, Mod 6 and 2 more. Your server moves to Fabric with them.',
    )
    expect(modsLine(WITHOUT, 'vanilla')).toBeNull()
    expect(modsLine(null, 'vanilla')).toBeNull()
  })

  test('only players’ mods come to nothing on the server', () => {
    const players: PlayedWith = {
      moddedWith: ['fabric'],
      mods: {
        loader: 'fabric',
        mods: [],
        forPlayers: [{ name: 'Sodium', fileName: 'sodium.jar' }],
        leftOut: [],
      },
    }
    expect(modsLine(players, 'vanilla')).toBe(
      'Played with Fabric. None of its mods run on a server, so your server stays as it is.',
    )
    expect(modsPlayOf(players)).toBe('none')
  })

  test('where they didn’t come, it says so, plays without them, and asks for the instance again', () => {
    expect(noModsLine(WITHOUT, 'life')).toBe(
      'Life was played with Fabric mods, which didn’t come with it. Without them, the blocks and items they add are gone.',
    )
    expect(againLine('Life')).toBe(
      'Add the instance you played it in, and Cubepals brings Life again with them.',
    )
    expect(noModsLine(LIFE, 'Life')).toBeNull()
    expect(modsPlayOf(WITHOUT)).toBe('without')
    expect(playLabel(maple, 'without')).toBe('Play Maple Hollow without its mods')
  })

  test('that come move a server with mods up to a newer world with them, in the same press', () => {
    const newer: BroughtWorld = { ...maple, newer: { gameVersion: '26.3', movesServer: false } }
    expect(modsPlayOf(LIFE)).toBe('with')
    expect(playLabel(newer, 'with')).toBe('Play Maple Hollow on 26.3')
    expect(movesLine(newer, '1.21.11', 'with')).toBe(
      'Playing it moves this server from Minecraft 1.21.11 up to 26.3, for good: a world can’t go back to an older Minecraft.',
    )
    expect(playLabel(newer, 'without')).toBe('Play Maple Hollow without its mods')
  })
})
