// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What an upload holds beside a world of what it was played with, by the shapes launchers keep. */
import { describe, expect, test } from 'bun:test'
import { INSTANCE_FILES, playedWithIn } from './instance-layout.ts'
import { detect } from './pack-layout.ts'
import { type FoundWorld, gameFolderOf, uploadHolds } from './world-layout.ts'

const worldIn = (paths: string[]): FoundWorld => {
  const holds = uploadHolds(paths)
  if (holds.kind !== 'java' || holds.worlds.length !== 1) throw new Error('Not one world')
  return holds.worlds[0] as FoundWorld
}

/** A Prism instance as the browser sends one: its files, its mods and one world. */
const PRISM = [
  'Fabric 26.3/instance.cfg',
  'Fabric 26.3/mmc-pack.json',
  'Fabric 26.3/minecraft/mods/treeharvester-26.3.0-10.4.jar',
  'Fabric 26.3/minecraft/mods/sodium.jar.disabled',
  'Fabric 26.3/minecraft/mods/.index/tree-harvester.pw.toml',
  'Fabric 26.3/minecraft/mods/.index/deeper/not-a-source.pw.toml',
  'Fabric 26.3/minecraft/mods/sub/nested.jar',
  'Fabric 26.3/minecraft/saves/Life/level.dat',
  'Fabric 26.3/minecraft/saves/Life/region/r.0.0.mca',
]

describe('what a world was played with, beside it', () => {
  test('a Prism instance: the jars of its game folder’s mods, their sources, and its components', () => {
    const world = worldIn(PRISM)
    expect(gameFolderOf(world)).toBe('Fabric 26.3/minecraft/')
    expect(playedWithIn(PRISM, world)).toEqual({
      jars: ['Fabric 26.3/minecraft/mods/treeharvester-26.3.0-10.4.jar'],
      sources: ['Fabric 26.3/minecraft/mods/.index/tree-harvester.pw.toml'],
      components: 'Fabric 26.3/mmc-pack.json',
      settings: 'Fabric 26.3/instance.cfg',
    })
    // The pack reader takes the same upload for the instance it is.
    expect(detect(PRISM)).toEqual({ format: 'instance', root: 'Fabric 26.3/', game: 'minecraft/' })
  })

  test('an older instance’s .minecraft, and a CurseForge profile whose saves are at its top', () => {
    const old = ['Old/mmc-pack.json', 'Old/.minecraft/mods/a.jar', 'Old/.minecraft/saves/W/level.dat']
    expect(playedWithIn(old, worldIn(old))).toMatchObject({
      jars: ['Old/.minecraft/mods/a.jar'],
      components: 'Old/mmc-pack.json',
    })
    const profile = ['Pals/minecraftinstance.json', 'Pals/mods/a.jar', 'Pals/saves/W/level.dat']
    expect(playedWithIn(profile, worldIn(profile))).toEqual({
      jars: ['Pals/mods/a.jar'],
      sources: [],
      components: null,
      settings: null,
    })
  })

  test('a world sent with its mods folder beside it, and a world alone', () => {
    const beside = ['Life/level.dat', 'mods/a.jar', 'mods/.index/a.pw.toml']
    expect(playedWithIn(beside, worldIn(beside))).toEqual({
      jars: ['mods/a.jar'],
      sources: ['mods/.index/a.pw.toml'],
      components: null,
      settings: null,
    })
    const alone = ['Life/level.dat', 'Life/region/r.0.0.mca']
    expect(playedWithIn(alone, worldIn(alone)).jars).toEqual([])
  })

  test('the small files read are kept wherever the instance is in the upload', () => {
    expect(PRISM.filter((path) => INSTANCE_FILES.test(path))).toEqual([
      'Fabric 26.3/instance.cfg',
      'Fabric 26.3/mmc-pack.json',
      'Fabric 26.3/minecraft/mods/.index/tree-harvester.pw.toml',
    ])
  })
})
