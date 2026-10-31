// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What is sent of a world brought to a server, with the mods of the instance it was played in. */
import { describe, expect, test } from 'bun:test'
import {
  type Brought,
  broughtFrom,
  modsGoing,
  sendingOf,
  uploadOf,
  withPicked,
  worldOf,
} from './brought-files.ts'
import type { PickedFile } from './world-folder.ts'

const picked = (...paths: string[]): PickedFile[] => paths.map((path) => ({ path, file: new Blob([path]) }))

/** The paths a tarball holds, in order: every path here fits a ustar header's name. */
async function namesIn(tar: Blob | null): Promise<string[]> {
  if (tar === null) throw new Error('Nothing sent')
  const bytes = new Uint8Array(await tar.arrayBuffer())
  const text = (from: number, to: number) =>
    new TextDecoder().decode(bytes.subarray(from, to)).replace(/\0.*$/s, '')
  const names: string[] = []
  for (let at = 0; at + 512 <= bytes.length; ) {
    const name = text(at, at + 100)
    if (name === '') break
    names.push(name)
    at += 512 + Math.ceil(Number.parseInt(text(at + 124, at + 136).trim(), 8) / 512) * 512
  }
  return names
}

/** A Prism instance picked whole, as the browser lists it. */
const PRISM = picked(
  'Fabric 26.3/instance.cfg',
  'Fabric 26.3/mmc-pack.json',
  'Fabric 26.3/minecraft/saves/Life/level.dat',
  'Fabric 26.3/minecraft/saves/Life/region/r.0.0.mca',
  'Fabric 26.3/minecraft/mods/treeharvester-26.3.0-10.4.jar',
  'Fabric 26.3/minecraft/mods/veinminer-1.0.jar',
  'Fabric 26.3/minecraft/mods/.index/tree-harvester.pw.toml',
  'Fabric 26.3/minecraft/saves/Creative/level.dat',
  'Fabric 26.3/minecraft/screenshots/a.png',
)
/** The same world picked from its saves folder on its own. */
const LIFE = picked('Life/level.dat', 'Life/region/r.0.0.mca')

describe('a world brought as a folder', () => {
  test('is an instance where it holds worlds in saves/ beside mods/, else a world’s own folder', () => {
    expect(broughtFrom(PRISM).kind).toBe('instance')
    expect(broughtFrom(LIFE).kind).toBe('folder')
  })

  test('of an instance, the world named as in Minecraft is chosen, else its only one, else none until asked', async () => {
    const instance = broughtFrom(PRISM)
    expect(sendingOf(instance).world).toBeNull()
    expect(uploadOf(sendingOf(instance))).toBeNull()
    expect(worldOf(sendingOf(instance))).toBeNull()
    expect(sendingOf(instance, 'Life').world).toBe('Fabric 26.3/minecraft/saves/Life/')
    const one = broughtFrom(PRISM.filter((file) => !file.path.includes('Creative')))
    expect(sendingOf(one).world).toBe('Fabric 26.3/minecraft/saves/Life/')
  })

  test('of an instance, sends what it runs on and its mods first, then the world chosen, and nothing else', async () => {
    const sent = uploadOf(sendingOf(broughtFrom(PRISM), 'Life'))
    expect(sent?.name).toBe('Life.tar')
    expect(await namesIn(sent)).toEqual([
      'Fabric 26.3/instance.cfg',
      'Fabric 26.3/mmc-pack.json',
      'Fabric 26.3/minecraft/mods/treeharvester-26.3.0-10.4.jar',
      'Fabric 26.3/minecraft/mods/veinminer-1.0.jar',
      'Fabric 26.3/minecraft/mods/.index/tree-harvester.pw.toml',
      'Fabric 26.3/minecraft/saves/Life/level.dat',
      'Fabric 26.3/minecraft/saves/Life/region/r.0.0.mca',
    ])
    expect(modsGoing(sendingOf(broughtFrom(PRISM)), null)).toBe(2)
  })
})

describe('the mods of a world that came without them', () => {
  test('come from its instance, beside the world, in one upload', async () => {
    const sending = withPicked(sendingOf(broughtFrom(LIFE)), PRISM, 'Life')
    if ('notAdded' in sending) throw new Error(sending.notAdded)
    expect(sending.mods).toMatchObject({ count: 2, from: 'Fabric 26.3' })
    expect(modsGoing(sending, null)).toBe(2)
    const sent = uploadOf(sending)
    expect(sent?.name).toBe('Life.tar')
    expect(await namesIn(sent)).toEqual([
      'instance.cfg',
      'mmc-pack.json',
      'mods/treeharvester-26.3.0-10.4.jar',
      'mods/veinminer-1.0.jar',
      'mods/.index/tree-harvester.pw.toml',
      'Life/level.dat',
      'Life/region/r.0.0.mca',
    ])
    // The world read in the browser is the world alone.
    expect(await namesIn(worldOf(sending))).toEqual(['Life/level.dat', 'Life/region/r.0.0.mca'])
  })

  test('come from a mods folder on its own, or are said not to be in a folder without any', () => {
    const sending = withPicked(
      sendingOf(broughtFrom(LIFE)),
      picked('mods/a.jar', 'mods/b.jar.disabled'),
      null,
    )
    expect(sending).toMatchObject({ mods: { count: 1, from: null } })
    expect(withPicked(sendingOf(broughtFrom(LIFE)), picked('Pictures/a.png'), null)).toEqual({
      notAdded: 'no-mods',
    })
  })

  test('for a world that came as a zip, take the world from the instance, as it is named in Minecraft', () => {
    const zip: Brought = { kind: 'file', file: new File(['zip'], 'Life.zip') }
    expect(withPicked(sendingOf(zip), picked('mods/a.jar'), 'Life')).toEqual({ notAdded: 'needs-instance' })
    const sending = withPicked(sendingOf(zip), PRISM, 'Life')
    if ('notAdded' in sending) throw new Error(sending.notAdded)
    expect(sending.brought.kind).toBe('instance')
    expect(sending.world).toBe('Fabric 26.3/minecraft/saves/Life/')
  })

  test('are counted from a zip’s names where it can be read, and not at all where it can’t', () => {
    const zip = sendingOf({ kind: 'file', file: new File(['zip'], 'srv.zip') })
    expect(modsGoing(zip, ['srv/world/level.dat', 'srv/mods/a.jar'])).toBe(1)
    expect(modsGoing(zip, ['Life/level.dat'])).toBe(0)
    expect(modsGoing(zip, null)).toBeNull()
  })
})
