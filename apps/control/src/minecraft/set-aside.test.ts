// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Which files a failure may have set aside: paths out of a log, checked as the untrusted text they are. */
import { describe, expect, test } from 'bun:test'
import { diagnose } from './diagnosis.ts'
import { asideOf, SET_ASIDE_VARIABLE, setAsideEnv } from './set-aside.ts'

describe('a path a log names', () => {
  test('a mod jar under mods/, however the loader prints it', () => {
    expect(asideOf('/data/mods/jei-1.jar', false)).toEqual({ path: 'mods/jei-1.jar', inWorld: false })
    expect(asideOf('jei-1.jar', false)).toEqual({ path: 'mods/jei-1.jar', inWorld: false })
    expect(asideOf('/data/mods/1.7.10/Baubles.jar', false)).toEqual({
      path: 'mods/1.7.10/Baubles.jar',
      inWorld: false,
    })
  })

  test('a datapack in the world’s datapacks/', () => {
    expect(asideOf('datapacks/far-end.zip', true)).toEqual({ path: 'datapacks/far-end.zip', inWorld: true })
    expect(asideOf('datapacks/far-end', true)).toEqual({ path: 'datapacks/far-end', inWorld: true })
  })

  test('nothing outside them, nothing hidden, never a way up', () => {
    for (const named of [
      '/data/mods/../server.properties',
      '/data/mods/..',
      '/etc/passwd',
      '/opt/mods/x.jar',
      '/data/server.jar',
      '/data/.blockly-set-aside/mods/x.jar',
      '/data/mods/.hidden.jar',
      'mods/x.txt',
      '/data/mods/x y.jar',
      '/data/mods/x;rm -rf.jar',
    ])
      expect(asideOf(named, false)).toBeNull()
    for (const named of [
      'datapacks/../level.dat',
      'datapacks/a/b.zip',
      'region/r.0.0.mca',
      'datapacks/.x',
      '../datapacks/x.zip',
    ])
      expect(asideOf(named, true)).toBeNull()
  })
})

describe('what a failure names', () => {
  test('a datapack that doesn’t parse', () => {
    expect(
      diagnose([
        'java.lang.IllegalStateException: Failed to parse minecraft:the_end from pack file/far-end-2.zip',
      ])?.files,
    ).toEqual([{ path: 'datapacks/far-end-2.zip', inWorld: true }])
    // A name a log could use to reach elsewhere names nothing to move.
    expect(
      diagnose([
        'java.lang.IllegalStateException: Failed to parse minecraft:the_end from pack file/../level.dat',
      ])?.files,
    ).toBeUndefined()
  })

  test('each copy of a mod found twice', () => {
    expect(
      diagnose([
        "net.fabricmc.loader.impl.discovery.ModResolutionException: Duplicate versions for mod ID 'jei': [19.21 at /data/mods/jei-19.21.jar, 19.19 at /data/mods/jei-19.19.jar]",
      ])?.files,
    ).toEqual([
      { path: 'mods/jei-19.21.jar', inWorld: false },
      { path: 'mods/jei-19.19.jar', inWorld: false },
    ])
    expect(
      diagnose(['\t- Mod jei is present in multiple files: jei-19.21.jar, jei-19.19.jar'])?.files?.map(
        (f) => f.path,
      ),
    ).toEqual(['mods/jei-19.21.jar', 'mods/jei-19.19.jar'])
  })
})

describe('what a start is told', () => {
  test('a line per file, and none for a path that isn’t one', () => {
    expect(
      setAsideEnv([
        { path: 'datapacks/far-end.zip', inWorld: true, back: false },
        { path: 'mods/jei.jar', inWorld: false, back: true },
        { path: 'mods/../server.properties', inWorld: false, back: false },
      ]),
    ).toEqual({ [SET_ASIDE_VARIABLE]: 'aside world datapacks/far-end.zip\nback server mods/jei.jar' })
    expect(setAsideEnv([])).toEqual({})
  })
})
