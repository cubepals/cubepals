// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { commonRoot, detect, onlyForPlayers, placeOf, worldFolders } from './pack-layout.ts'

describe('what an uploaded pack is, by its file names', () => {
  test('a Modrinth pack, a CurseForge export and a Packwiz pack by the file each is built around', () => {
    expect(detect(['modrinth.index.json', 'overrides/config/a.toml'])).toEqual({
      format: 'mrpack',
      root: '',
      game: '',
    })
    expect(detect(['manifest.json', 'modlist.html', 'overrides/mods/x.jar'])?.format).toBe('curseforge')
    expect(detect(['pack.toml', 'index.toml', 'mods/sodium.pw.toml'])?.format).toBe('packwiz')
  })

  test('a CurseForge export is known by its manifest at the top, never one inside its overrides', () => {
    // Real exports carry mods' own manifest.json files deep inside overrides.
    expect(detect(['overrides/config/manifest.json', 'mods/a.jar'])?.format).toBe('mods')
  })

  test('a Prism or MultiMC instance, with its game folder, and the CurseForge app’s own folder', () => {
    expect(detect(['instance.cfg', 'mmc-pack.json', '.minecraft/mods/a.jar'])).toEqual({
      format: 'instance',
      root: '',
      game: '.minecraft/',
    })
    expect(detect(['My Pack/instance.cfg', 'My Pack/mmc-pack.json', 'My Pack/minecraft/mods/a.jar'])).toEqual(
      {
        format: 'instance',
        root: 'My Pack/',
        game: 'minecraft/',
      },
    )
    expect(detect(['minecraftinstance.json', 'mods/a.jar', 'config/a.cfg'])?.format).toBe('instance')
  })

  test('a server pack by how it starts, even wrapped in a folder of its own', () => {
    const atm = [
      'ServerFiles-8.2/mods/allthemodium.jar',
      'ServerFiles-8.2/config/a.toml',
      'ServerFiles-8.2/startserver.sh',
      'ServerFiles-8.2/user_jvm_args.txt',
      'ServerFiles-8.2/neoforge-21.1.251-installer.jar',
    ]
    expect(detect(atm)).toEqual({ format: 'server', root: 'ServerFiles-8.2/', game: '' })
    expect(detect(['mods/a.jar', 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/x.jar'])?.format).toBe(
      'server',
    )
  })

  test('a plain folder of mods, zipped from outside or from inside', () => {
    expect(detect(['mods/a.jar', 'config/a.toml'])?.format).toBe('mods')
    expect(detect(['a.jar', 'b.jar'])).toEqual({ format: 'mods', root: '', game: '' })
    expect(detect(['.minecraft/mods/a.jar', '.minecraft/options.txt'])).toEqual({
      format: 'mods',
      root: '',
      game: '.minecraft/',
    })
  })

  test('nothing a server can be made of is nothing', () => {
    expect(detect(['README.md', 'photo.png'])).toBeNull()
    expect(detect([])).toBeNull()
  })

  test('the folder around a pack is its own, but never a folder of the game', () => {
    expect(commonRoot(['Pack/mods/a.jar', 'Pack/config/b'])).toBe('Pack/')
    expect(commonRoot(['a/b/mods/x.jar', 'a/b/config/y'])).toBe('a/b/')
    expect(commonRoot(['mods/a.jar', 'mods/b.jar'])).toBe('')
    expect(commonRoot(['Pack/mods/a.jar', 'other.txt'])).toBe('')
  })
})

describe('where each file of a pack goes', () => {
  test('mods, configs and what mods read are kept as they are', () => {
    for (const path of [
      'mods/create.jar',
      'config/create-common.toml',
      'defaultconfigs/ftbchunks-world.snbt',
      'kubejs/server_scripts/recipes.js',
      'scripts/crafttweaker.zs',
      'global_packs/required_data/pack.zip',
    ])
      expect(placeOf(path)).toEqual({ path })
  })

  test('what only players’ games read, what starts a server another way, programs and clutter stay out', () => {
    expect(placeOf('resourcepacks/faithful.zip')).toEqual({ leftOut: 'players' })
    expect(placeOf('shaderpacks/bsl.zip')).toEqual({ leftOut: 'players' })
    expect(placeOf('mods/journeymap.jar.disabled')).toEqual({ leftOut: 'players' })
    expect(placeOf('libraries/net/minecraftforge/x.jar')).toEqual({ leftOut: 'launcher' })
    expect(placeOf('startserver.sh')).toEqual({ leftOut: 'program' })
    expect(placeOf('user_jvm_args.txt')).toEqual({ leftOut: 'launcher' })
    expect(placeOf('server.properties')).toEqual({ leftOut: 'launcher' })
    expect(placeOf('config/helper.exe')).toEqual({ leftOut: 'program' })
    expect(placeOf('__MACOSX/mods/._a.jar')).toEqual({ leftOut: 'clutter' })
    expect(placeOf('config/.DS_Store')).toEqual({ leftOut: 'clutter' })
  })

  test('in a Modrinth pack, what only players’ games read is known wherever the pack puts it', () => {
    // Listed in its index, as Cobblemon's official pack lists its shader pack.
    expect(onlyForPlayers('shaderpacks/ComplementaryReimagined_r5.9.1.zip')).toBe(true)
    // Carried in its overrides, for every server or for servers alone.
    expect(onlyForPlayers('overrides/resourcepacks/Better-Leaves.zip')).toBe(true)
    expect(onlyForPlayers('server-overrides/shaderpacks/x.zip')).toBe(true)
    // What a server reads stays.
    expect(onlyForPlayers('mods/lithium.jar')).toBe(false)
    expect(onlyForPlayers('overrides/config/lithium.properties')).toBe(false)
    expect(onlyForPlayers('overrides/kubejs/server_scripts/a.js')).toBe(false)
  })

  test('worlds a pack carries are found by their level.dat', () => {
    expect(
      worldFolders(['world/level.dat', 'world/region/r.0.0.mca', 'saves/Test/level.dat', 'config/a']),
    ).toEqual(['world/', 'saves/Test/'])
  })
})
