// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { isSafePath, playersNeedIt, readIndex, serverFiles } from './mrpack.ts'

const sha1 = 'a'.repeat(40)
const sha512 = 'b'.repeat(128)

const file = (path: string, env?: { client: string; server: string }) => ({
  path,
  hashes: { sha1, sha512 },
  downloads: [`https://cdn.example.test/${path}`],
  fileSize: 100,
  ...(env === undefined ? {} : { env }),
})

const index = (patch: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  game: 'minecraft',
  versionId: '1.8.0',
  name: 'Cobblemon',
  files: [file('mods/cobblemon.jar')],
  dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
  ...patch,
})

describe('a Modrinth pack index', () => {
  test('says what it runs on and what it installs', () => {
    const read = readIndex(index())
    if ('refused' in read) throw new Error(read.refused)
    expect(read).toMatchObject({
      name: 'Cobblemon',
      versionId: '1.8.0',
      gameVersion: '1.21.1',
      loader: 'fabric',
      loaderVersion: '0.16.14',
    })
    // No side said is both sides needed: the format's default.
    expect(read.files[0]?.env).toEqual({ client: 'required', server: 'required' })
  })

  test('each loader by the key the format gives it; Quilt when a pack names both it and Fabric', () => {
    const loaderOf = (dependencies: Record<string, string>) => {
      const read = readIndex(index({ dependencies: { minecraft: '1.20.1', ...dependencies } }))
      return 'refused' in read ? read.refused : `${read.loader} ${read.loaderVersion}`
    }
    expect(loaderOf({ neoforge: '21.1.72' })).toBe('neoforge 21.1.72')
    expect(loaderOf({ forge: '47.2.0' })).toBe('forge 47.2.0')
    expect(loaderOf({ 'quilt-loader': '0.26.0', 'fabric-loader': '0.16.0' })).toBe('quilt 0.26.0')
    expect(loaderOf({})).toBe('vanilla null')
    expect(loaderOf({ forge: '47.2.0', 'fabric-loader': '0.16.0' })).toContain('more than one mod loader')
  })

  test('a server installs what its side needs or can use, and players need only what they must have', () => {
    const read = readIndex(
      index({
        files: [
          file('mods/both.jar'),
          file('mods/sodium.jar', { client: 'required', server: 'unsupported' }),
          file('mods/lithium.jar', { client: 'optional', server: 'optional' }),
        ],
      }),
    )
    if ('refused' in read) throw new Error(read.refused)
    expect(serverFiles(read).map((f) => f.path)).toEqual(['mods/both.jar', 'mods/lithium.jar'])
    expect(playersNeedIt(read)).toBe(true)
    const serverOnly = readIndex(
      index({ files: [file('mods/x.jar', { client: 'optional', server: 'required' })] }),
    )
    if ('refused' in serverOnly) throw new Error(serverOnly.refused)
    expect(playersNeedIt(serverOnly)).toBe(false)
  })

  test('refuses, in words, a pack that would write outside the server or lists what it can’t check', () => {
    const refusal = (files: unknown[]) => {
      const read = readIndex(index({ files }))
      return 'refused' in read ? read.refused : null
    }
    expect(refusal([file('../../etc/passwd')])).toBe('This pack puts a file outside the server’s folder.')
    expect(refusal([file('/abs/mod.jar')])).not.toBeNull()
    expect(refusal([file('mods\\evil.jar')])).not.toBeNull()
    expect(refusal([{ ...file('mods/a.jar'), hashes: { sha1 } }])).toContain(
      'without a way to download and check it',
    )
    expect(refusal([{ ...file('mods/a.jar'), downloads: ['file:///etc/passwd'] }])).not.toBeNull()
    expect(refusal([file('mods/fine.jar')])).toBeNull()
  })

  test('refuses what isn’t a Minecraft pack, or doesn’t say which Minecraft', () => {
    expect(readIndex({ game: 'terraria', formatVersion: 1 })).toHaveProperty('refused')
    expect(readIndex(index({ formatVersion: 2 }))).toHaveProperty('refused')
    expect(readIndex(index({ dependencies: {} }))).toEqual({
      refused: 'This pack doesn’t say which Minecraft it runs on.',
    })
  })
})

describe('a path a pack may write', () => {
  test('plain relative names only', () => {
    for (const ok of ['mods/a.jar', 'config/x/y.toml', 'kubejs/server_scripts/a.js', '.minecraft-ish'])
      expect(isSafePath(ok)).toBe(true)
    for (const bad of ['', '/etc', 'a/../b', '..', './a', 'C:/x', 'a\\b', 'a//b', 'mods/\u0000.jar', 'a/'])
      expect(isSafePath(bad)).toBe(false)
  })
})
