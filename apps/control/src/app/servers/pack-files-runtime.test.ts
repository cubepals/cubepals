// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which of a pack's files are the pack's and which the owner's (`minecraft/pack-files.ts`), run in
 * a real shell against a folder standing in for the volume, starts after starts, with the image's
 * extraction of the pack's overrides played after each: every file, `server-overrides/` over
 * `overrides/`, but the ones the step left to the owner.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FROM_PACK, PACK_FILES_STEP } from '../../minecraft/pack-files.ts'

/** Where the step's own output ends and the list it left the image begins. */
const LIST = 'LEFT TO THE OWNER:'

/** Where the packs are made, once, for every test. */
const packs = mkdtempSync(join(tmpdir(), 'blockly-packs-'))
afterAll(() => rmSync(packs, { recursive: true, force: true }))

let root = ''
let data = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blockly-pack-files-'))
  data = join(root, 'data')
  mkdirSync(data, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A pack whose overrides hold `files`, and whose server overrides hold `server`, made with `zip`. */
function pack(files: Record<string, string>, server: Record<string, string> = {}): Uint8Array {
  const dir = mkdtempSync(join(packs, 'pack-'))
  writeFileSync(join(dir, 'modrinth.index.json'), '{"files":[]}')
  for (const [prefix, entries] of [
    ['overrides', files],
    ['server-overrides', server],
  ] as const)
    for (const [path, text] of Object.entries(entries)) {
      mkdirSync(dirname(join(dir, prefix, path)), { recursive: true })
      writeFileSync(join(dir, prefix, path), text)
    }
  const out = join(dir, 'pack.mrpack')
  Bun.spawnSync(['zip', '-qr', out, '.'], { cwd: dir })
  return readFileSync(out)
}

/**
 * One start of a server on `archive`, pinned as `id`: the step, then the image's extraction of
 * what the step didn't leave to the owner. What the step printed, and the list it left the image.
 */
function start(archive: Uint8Array, id: string, env: Record<string, string> = {}, placed = true) {
  // The pack is where the image fetches it from; the image keeps what it fetched (`PACK_STEP`).
  const link = join(root, `${id}.mrpack`)
  writeFileSync(link, archive)
  // As `PACK_STEP` does before it: the pack kept from before goes when another is pinned.
  const mark = join(data, '.blockly-pack')
  if (!existsSync(mark) || readFileSync(mark, 'utf8') !== id)
    rmSync(join(data, 'modpack.mrpack'), { force: true })
  writeFileSync(mark, id)
  const step = PACK_FILES_STEP.replaceAll('/tmp/blockly-pack-files', join(root, 'work')).replaceAll(
    '/data',
    data,
  )
  const result = Bun.spawnSync(
    ['/bin/sh', '-c', `${step} printf '${LIST}%s' "$MODRINTH_OVERRIDES_EXCLUSIONS"`],
    {
      env: { PATH: process.env.PATH ?? '', MODRINTH_MODPACK: `file://${link}`, BLOCKLY_PACK: id, ...env },
    },
  )
  const [said = '', left = ''] = result.stdout.toString().split(LIST)
  const excluded = left === '' ? [] : left.split('\n')
  if (placed) extract(readFileSync(join(data, 'modpack.mrpack')), new Set(excluded))
  return { said: said.trim(), excluded }
}

/** The image's extraction: every override, the server's over the rest, but those it is told to leave. */
function extract(archive: Uint8Array, leave: ReadonlySet<string>) {
  const dir = mkdtempSync(join(root, 'extract-'))
  writeFileSync(join(dir, 'pack.mrpack'), archive)
  Bun.spawnSync(['unzip', '-qq', 'pack.mrpack', '-d', 'out'], { cwd: dir })
  for (const prefix of ['overrides', 'server-overrides']) {
    const base = join(dir, 'out', prefix)
    if (!existsSync(base)) continue
    for (const path of readdirSync(base, { recursive: true, encoding: 'utf8' })) {
      if (leave.has(path) || !statSync(join(base, path)).isFile()) continue
      mkdirSync(dirname(join(data, path)), { recursive: true })
      writeFileSync(join(data, path), readFileSync(join(base, path)))
    }
  }
}

const read = (path: string) => readFileSync(join(data, path), 'utf8')

const v1 = pack({ 'config/a.toml': 'a = 1', 'config/b.toml': 'b = 1', 'options.txt': 'o = 1' })
const v2 = pack({ 'config/a.toml': 'a = 2', 'config/b.toml': 'b = 2', 'options.txt': 'o = 2' })

describe('a pack’s files', () => {
  test('are all the pack’s at the first start, and follow it while nobody changes them', () => {
    expect(start(v1, 'one').excluded).toEqual([])
    expect(read('config/a.toml')).toBe('a = 1')
    expect(start(v1, 'one').excluded).toEqual([])
    expect(start(v2, 'two').excluded).toEqual([])
    expect(read('config/a.toml')).toBe('a = 2')
    expect(existsSync(join(data, `config/a.toml${FROM_PACK}`))).toBe(false)
  })

  test('stay as the owner changed them, start after start, while the pack doesn’t change them', () => {
    start(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    for (let i = 0; i < 3; i++) {
      const { said, excluded } = start(v1, 'one')
      expect(excluded).toEqual(['config/a.toml'])
      expect(said).toBe('')
    }
    expect(read('config/a.toml')).toBe('a = mine')
    expect(read('config/b.toml')).toBe('b = 1')
  })

  test('stay the owner’s when a pack update changes them, with the pack’s new copy beside them, said once', () => {
    start(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    const update = start(v2, 'two')
    expect(update.excluded).toEqual(['config/a.toml'])
    expect(update.said).toContain(
      `Kept your own config/a.toml; the pack's new copy is beside it, as config/a.toml${FROM_PACK}`,
    )
    expect(read('config/a.toml')).toBe('a = mine')
    expect(read(`config/a.toml${FROM_PACK}`)).toBe('a = 2')
    // The rest of the pack moved on.
    expect(read('config/b.toml')).toBe('b = 2')
    // The next start says nothing more, and leaves the owner's file and the copy as they are.
    const after = start(v2, 'two')
    expect(after.said).toBe('')
    expect(after.excluded).toEqual(['config/a.toml'])
    expect(read('config/a.toml')).toBe('a = mine')
  })

  test('stay gone when the owner deleted one, with the pack’s new copy beside where it was', () => {
    start(v1, 'one')
    unlinkSync(join(data, 'options.txt'))
    expect(start(v1, 'one').excluded).toEqual(['options.txt'])
    expect(existsSync(join(data, 'options.txt'))).toBe(false)
    const update = start(v2, 'two')
    expect(update.excluded).toEqual(['options.txt'])
    expect(existsSync(join(data, 'options.txt'))).toBe(false)
    expect(read(`options.txt${FROM_PACK}`)).toBe('o = 2')
  })

  test('follow the pack again once the owner’s copy is the pack’s', () => {
    start(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    start(v2, 'two')
    writeFileSync(join(data, 'config/a.toml'), 'a = 2')
    expect(start(v2, 'two').excluded).toEqual([])
  })

  test('take the server’s override over the pack’s other one', () => {
    const both = pack({ 'server.properties': 'client' }, { 'server.properties': 'server' })
    start(both, 'one')
    expect(read('server.properties')).toBe('server')
    expect(start(both, 'one').excluded).toEqual([])
  })

  test('add to what the pack’s own settings already leave out', () => {
    start(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    expect(start(v1, 'one', { MODRINTH_OVERRIDES_EXCLUSIONS: 'kubejs/**' }).excluded).toEqual([
      'kubejs/**',
      'config/a.toml',
    ])
  })

  test('stay as the owner changed them right after the first start', () => {
    start(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    expect(start(v1, 'one').excluded).toEqual(['config/a.toml'])
    expect(read('config/a.toml')).toBe('a = mine')
  })

  test('are placed again, not taken for deleted, when a start ended before the image placed them', () => {
    start(v1, 'one', {}, false)
    expect(existsSync(join(data, 'config/a.toml'))).toBe(false)
    expect(start(v1, 'one').excluded).toEqual([])
    expect(read('config/a.toml')).toBe('a = 1')
  })

  test('are all the pack’s again, said so, where the owner changed more than the image’s list can hold', () => {
    const many = Object.fromEntries(
      Array.from({ length: 1500 }, (_, i) => [
        `config/a-mod-with-a-long-name/settings-${String(i).padStart(4, '0')}.toml`,
        'x',
      ]),
    )
    const big = pack(many)
    start(big, 'big')
    start(big, 'big')
    for (const path of Object.keys(many)) writeFileSync(join(data, path), 'mine')
    const after = start(big, 'big')
    expect(after.excluded).toEqual([])
    expect(after.said).toContain("Too many of the pack's files were changed to keep them all")
  })

  test('are left to the image, as before, where the pack can’t be fetched', () => {
    const step = PACK_FILES_STEP.replaceAll('/tmp/blockly-pack-files', join(root, 'work')).replaceAll(
      '/data',
      data,
    )
    const result = Bun.spawnSync(['/bin/sh', '-c', `${step} printf '%s' "$MODRINTH_OVERRIDES_EXCLUSIONS"`], {
      env: {
        PATH: process.env.PATH ?? '',
        MODRINTH_MODPACK: `file://${join(root, 'missing.mrpack')}`,
        BLOCKLY_PACK: 'x',
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
    expect(existsSync(join(data, '.blockly-pack-index'))).toBe(false)
  })
})
