// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A launcher's instance, picked so a world's mods come with it: where it is, and what of it is sent. */
import { describe, expect, test } from 'bun:test'
import {
  instanceIn,
  instancePickOn,
  modsBeside,
  modsFolderOn,
  modsIn,
  modsSent,
  playedFrom,
  sentWith,
} from './instance-folders.ts'
import { LAUNCHERS } from './saves-folders.ts'

const launcher = (id: string) => {
  const found = LAUNCHERS.find((l) => l.id === id)
  if (found === undefined) throw new Error(`No launcher ${id}`)
  return found
}

describe('what to pick so a world’s mods come with it', () => {
  test('Prism keeps an instance in its instances folder, its mods in the game’s folder inside', () => {
    expect(instancePickOn(launcher('prism'), 'Windows')).toEqual({
      instances: '%APPDATA%\\PrismLauncher\\instances',
      mods: 'minecraft\\mods',
      saves: 'minecraft\\saves',
    })
    expect(instancePickOn(launcher('prism'), 'Linux')).toEqual({
      instances: '~/.local/share/PrismLauncher/instances',
      mods: 'minecraft/mods',
      saves: 'minecraft/saves',
    })
  })

  test('CurseForge and the Modrinth App keep mods at an instance’s top; the game’s own launcher has none', () => {
    expect(instancePickOn(launcher('curseforge'), 'macOS')?.mods).toBe('mods')
    expect(instancePickOn(launcher('modrinth'), 'Windows')?.mods).toBe('mods')
    expect(instancePickOn(launcher('minecraft'), 'Windows')).toBeNull()
  })
})

/** A Prism instance picked whole, as the browser lists it: every path starts with the folder picked. */
const PRISM = [
  'Fabric 26.3/instance.cfg',
  'Fabric 26.3/mmc-pack.json',
  'Fabric 26.3/minecraft/options.txt',
  'Fabric 26.3/minecraft/mods/treeharvester-26.3.0-10.4.jar',
  'Fabric 26.3/minecraft/mods/collective-26.3.0-8.71.jar',
  'Fabric 26.3/minecraft/mods/sodium-fabric-0.9.3-beta.1+mc26.3.jar.disabled',
  'Fabric 26.3/minecraft/mods/.index/tree-harvester.pw.toml',
  'Fabric 26.3/minecraft/mods/.connector/cache.bin',
  'Fabric 26.3/minecraft/saves/Life/level.dat',
  'Fabric 26.3/minecraft/saves/Life/region/r.0.0.mca',
  'Fabric 26.3/minecraft/saves/Creative/level.dat',
  'Fabric 26.3/minecraft/saves/Creative/region/r.0.0.mca',
  'Fabric 26.3/minecraft/shaderpacks/Complementary.zip',
  'Fabric 26.3/minecraft/screenshots/2026-10-30_21.14.03.png',
]

describe('an instance picked whole', () => {
  test('is known by its worlds in saves/ beside its mods/, its own files above the game’s folder', () => {
    expect(instanceIn(PRISM)).toEqual({
      root: 'Fabric 26.3/',
      game: 'Fabric 26.3/minecraft/',
      worlds: ['Fabric 26.3/minecraft/saves/Creative/', 'Fabric 26.3/minecraft/saves/Life/'],
    })
    // A CurseForge profile: its own folder is the game's.
    expect(instanceIn(['Pals/saves/Life/level.dat', 'Pals/mods/a.jar'])).toEqual({
      root: 'Pals/',
      game: 'Pals/',
      worlds: ['Pals/saves/Life/'],
    })
  })

  test('isn’t one without a mods folder: a saves folder, or a world on its own', () => {
    expect(instanceIn(['.minecraft/saves/Life/level.dat', '.minecraft/options.txt'])).toBeNull()
    expect(instanceIn(['Life/level.dat', 'Life/region/r.0.0.mca'])).toBeNull()
  })

  test('sends the world chosen, its mods and their sources, and what the instance runs on', () => {
    const instance = instanceIn(PRISM)
    if (instance === null) throw new Error('Not an instance')
    expect(sentWith(PRISM, instance, 'Fabric 26.3/minecraft/saves/Life/')).toEqual([
      'Fabric 26.3/instance.cfg',
      'Fabric 26.3/mmc-pack.json',
      'Fabric 26.3/minecraft/mods/treeharvester-26.3.0-10.4.jar',
      'Fabric 26.3/minecraft/mods/collective-26.3.0-8.71.jar',
      'Fabric 26.3/minecraft/mods/.index/tree-harvester.pw.toml',
      'Fabric 26.3/minecraft/saves/Life/level.dat',
      'Fabric 26.3/minecraft/saves/Life/region/r.0.0.mca',
    ])
  })
})

describe('a folder picked for the mods of a world picked from somewhere else', () => {
  test('the game’s own launcher keeps them beside its saves; one with instances, in each instance', () => {
    expect(modsFolderOn(launcher('minecraft'), 'Windows')).toBe('%APPDATA%\\.minecraft\\mods')
    expect(modsFolderOn(launcher('minecraft'), 'Linux')).toBe('~/.minecraft/mods')
    expect(modsFolderOn(launcher('prism'), 'Windows')).toBeNull()
  })

  test('finds the mods of an instance, of its game folder, or a mods folder on its own', () => {
    expect(modsIn(PRISM)).toEqual({ mods: 'Fabric 26.3/minecraft/mods/', root: 'Fabric 26.3/' })
    // An instance with no world left in it, picked whole: its game folder's mods, its own files above.
    expect(modsIn(['Inst/mmc-pack.json', 'Inst/minecraft/mods/a.jar'])).toEqual({
      mods: 'Inst/minecraft/mods/',
      root: 'Inst/',
    })
    expect(modsIn(['mods/a.jar', 'mods/.index/a.pw.toml'])).toEqual({ mods: 'mods/', root: '' })
    // A folder of jars named otherwise is a mods folder all the same.
    expect(modsIn(['My mods/a.jar'])).toEqual({ mods: 'My mods/', root: null })
    expect(modsIn(['Life/level.dat', 'Life/datapacks/a.zip'])).toBeNull()
    expect(modsIn(['mods/a.jar.disabled'])).toBeNull()
  })

  test('sends them in mods/ beside the world, with what the instance runs on', () => {
    const folder = modsIn(PRISM)
    if (folder === null) throw new Error('No mods')
    expect(modsSent(PRISM, folder, '')).toEqual([
      { path: 'Fabric 26.3/instance.cfg', at: 'instance.cfg' },
      { path: 'Fabric 26.3/mmc-pack.json', at: 'mmc-pack.json' },
      {
        path: 'Fabric 26.3/minecraft/mods/treeharvester-26.3.0-10.4.jar',
        at: 'mods/treeharvester-26.3.0-10.4.jar',
      },
      {
        path: 'Fabric 26.3/minecraft/mods/collective-26.3.0-8.71.jar',
        at: 'mods/collective-26.3.0-8.71.jar',
      },
      {
        path: 'Fabric 26.3/minecraft/mods/.index/tree-harvester.pw.toml',
        at: 'mods/.index/tree-harvester.pw.toml',
      },
    ])
    expect(modsSent(['mods/a.jar'], { mods: 'mods/', root: '' }, 'srv/')).toEqual([
      { path: 'mods/a.jar', at: 'srv/mods/a.jar' },
    ])
  })

  test('a world is played from the folder above its saves, else the one it sits in, as the control plane reads it', () => {
    expect(playedFrom(['Life/level.dat', 'Life/region/r.0.0.mca'])).toBe('')
    expect(playedFrom(['srv/world/level.dat', 'srv/world/DIM-1/level.dat', 'srv/server.properties'])).toBe(
      'srv/',
    )
    expect(playedFrom(['.minecraft/saves/Life/level.dat'])).toBe('.minecraft/')
    expect(modsBeside(['srv/world/level.dat', 'srv/mods/a.jar', 'srv/mods/b.jar.disabled'])).toEqual([
      'srv/mods/a.jar',
    ])
    expect(modsBeside(['Life/level.dat', 'Life/mods/a.jar'])).toEqual([])
  })
})
