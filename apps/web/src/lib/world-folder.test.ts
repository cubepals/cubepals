// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A world folder as the browser sends it, read back by GNU tar, as a server's would read it. */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookAt, lookInZip, type PickedFile, tarOf } from './world-folder'

const blob = (text: string) => new Blob([text])
const deep = `${'deep/'.repeat(30)}level.dat`

describe('a world folder sent as one file', () => {
  const files: PickedFile[] = [
    { path: 'My World 🌲/level.dat', file: blob('level') },
    { path: 'My World 🌲/region/r.0.0.mca', file: blob('x'.repeat(1300)) },
    { path: 'My World 🌲/empty.dat', file: blob('') },
    { path: deep, file: blob('far down') },
  ]

  test('GNU tar reads every file back, names and bytes as they were', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'world-folder-'))
    const tar = join(dir, 'world.tar')
    await Bun.write(tar, tarOf(files))
    const listed = Bun.spawnSync(['tar', '--quoting-style=literal', '-tf', tar])
      .stdout.toString()
      .trim()
      .split('\n')
    expect(listed).toEqual(files.map((file) => file.path))
    expect(Bun.spawnSync(['tar', '-xf', tar, '-C', dir]).exitCode).toBe(0)
    for (const { path, file } of files) expect(readFileSync(join(dir, path), 'utf8')).toBe(await file.text())
  })

  test('its size is known before it is read: headers, files padded to a block, and the end', () => {
    const plain = tarOf([{ path: 'level.dat', file: blob('level') }])
    expect(plain.size).toBe(512 + 512 + 1024)
  })
})

describe('a look at a folder before it is sent', () => {
  test('a Java world, a Bedrock one, and a folder with neither', () => {
    expect(lookAt([{ path: 'w/level.dat', file: blob('abc') }])).toEqual({ kind: 'world', sizeBytes: 3 })
    expect(
      lookAt([
        { path: 'w/levelname.txt', file: blob('w') },
        { path: 'w/db/CURRENT', file: blob('') },
      ]),
    ).toEqual({
      kind: 'bedrock',
    })
    expect(lookAt([{ path: 'mods/sodium.jar', file: blob('') }])).toEqual({ kind: 'nothing' })
    expect(lookAt([])).toEqual({ kind: 'empty' })
  })
})

describe('a look into a zip before it is sent', () => {
  test('what zip -r makes of a world folder and of a Bedrock one, from their central directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'world-zip-'))
    const make = async (files: Record<string, string>, name: string) => {
      for (const [path, text] of Object.entries(files)) await Bun.write(join(dir, name, path), text)
    }
    await make({ 'My World/level.dat': 'level', 'My World/region/r.0.0.mca': 'chunks' }, 'java')
    await make({ 'Bedrock/levelname.txt': 'w', 'Bedrock/db/CURRENT': 'x' }, 'bedrock')
    for (const name of ['java', 'bedrock'])
      expect(Bun.spawnSync(['zip', '-qr', `../${name}.zip`, '.'], { cwd: join(dir, name) }).exitCode).toBe(0)
    expect(await lookInZip(Bun.file(join(dir, 'java.zip')))).toEqual({ kind: 'world', sizeBytes: 11 })
    expect(await lookInZip(Bun.file(join(dir, 'bedrock.zip')))).toEqual({ kind: 'bedrock' })
    expect(await lookInZip(new Blob(['not a zip']))).toBeNull()
  })
})
