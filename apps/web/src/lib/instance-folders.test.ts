// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A launcher's instance, picked so a world's mods come with it: where it is, and what of it is sent. */
import { describe, expect, test } from 'bun:test'
import { instanceIn, instancePickOn, sentWith } from './instance-folders.ts'
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
