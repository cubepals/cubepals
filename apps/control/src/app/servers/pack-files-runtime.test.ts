// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A pack's install keeping the owner's files (`minecraft/pack-files.ts`), run in a real shell
 * against a folder standing in for the volume, installs after installs, with a stand-in for the
 * image's helper that does what its install does to the pack's overrides: extracts every one,
 * `server-overrides/` over `overrides/`, over whatever is there.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FROM_PACK, HELPER, PACK_FILES_SCRIPT } from '../../minecraft/pack-files.ts'

/** Where the packs are made, once, for every test. */
const packs = mkdtempSync(join(tmpdir(), 'blockly-packs-'))
afterAll(() => rmSync(packs, { recursive: true, force: true }))

let root = ''
let data = ''
let script = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blockly-pf-'))
  data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  // The helper's install, as far as the overrides go; it fails, after extracting, when told to.
  const helper = join(root, 'helper')
  writeFileSync(
    helper,
    [
      '#!/bin/sh',
      `cd ${data} && rm -rf ${root}/x && unzip -qq -o modpack.mrpack -d ${root}/x`,
      // The image leaves the excluded overrides out (exact paths, at newlines or commas).
      `printf '%s\\n' "$MODRINTH_OVERRIDES_EXCLUSIONS" | tr , '\\n' | while read -r e; do [ -n "$e" ] && rm -f ${root}/x/overrides/$e ${root}/x/server-overrides/$e; done`,
      `for s in overrides server-overrides; do if [ -d ${root}/x/$s ]; then cp -R ${root}/x/$s/. ${data}/; fi; done`,
      // What a full volume does to a file being put back: in its place, something it can't replace.
      `if [ -n "$BLOCK" ]; then rm -f ${data}/$BLOCK && mkdir -p ${data}/$BLOCK/x; fi`,
      'echo "helper $1"',
      // An install cut short, as by a machine stopped mid-start: the script dies with the helper.
      'if [ -n "$KILL" ]; then kill -9 $PPID; fi',
      'exit "${FAIL:-0}"',
    ].join('\n'),
  )
  chmodSync(helper, 0o755)
  script = join(root, 'pack-files')
  writeFileSync(
    script,
    PACK_FILES_SCRIPT.replaceAll(HELPER, helper)
      .replaceAll('/tmp/blockly-pack-files', join(root, 'work'))
      .replaceAll('/data', data),
  )
  chmodSync(script, 0o755)
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
 * One install of `archive`, pinned as `id`: what the console says, and how the install ended.
 * As `PACK_STEP` does before the image, the pack kept from before goes when another is pinned.
 */
function install(archive: Uint8Array, id: string, env: Record<string, string> = {}) {
  const link = join(root, `${id}.mrpack`)
  writeFileSync(link, archive)
  const mark = join(data, '.blockly-pack')
  if (!existsSync(mark) || readFileSync(mark, 'utf8') !== id)
    rmSync(join(data, 'modpack.mrpack'), { force: true })
  writeFileSync(mark, id)
  const result = Bun.spawnSync([script, 'install-modrinth-modpack', '--output-directory=/data'], {
    env: { PATH: process.env.PATH ?? '', MODRINTH_MODPACK: `file://${link}`, ...env },
  })
  return {
    said: result.stdout
      .toString()
      .replace(/^helper .*\n?/m, '')
      .trim(),
    code: result.exitCode,
  }
}

const read = (path: string) => readFileSync(join(data, path), 'utf8')
const there = (path: string) => existsSync(join(data, path))
const record = () => readFileSync(join(data, '.blockly-pack-files'), 'utf8')

const v1 = pack({ 'config/a.toml': 'a = 1', 'config/b.toml': 'b = 1', 'options.txt': 'o = 1' })
const v2 = pack({ 'config/a.toml': 'a = 2', 'config/b.toml': 'b = 2', 'options.txt': 'o = 2' })

describe('a pack’s files', () => {
  test('are all the pack’s on a new server, and follow it while nobody changes them', () => {
    expect(install(v1, 'one')).toEqual({ said: '', code: 0 })
    expect(read('config/a.toml')).toBe('a = 1')
    expect(record().trimEnd().endsWith('# end')).toBe(true)
    expect(install(v2, 'two')).toEqual({ said: '', code: 0 })
    expect(read('config/a.toml')).toBe('a = 2')
    expect(there(`config/a.toml${FROM_PACK}`)).toBe(false)
  })

  test('stay as the owner changed them, install after install, while the pack doesn’t change them', () => {
    install(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    for (let i = 0; i < 3; i++) expect(install(v1, 'one')).toEqual({ said: '', code: 0 })
    expect(read('config/a.toml')).toBe('a = mine')
    expect(read('config/b.toml')).toBe('b = 1')
  })

  test('stay the owner’s when a pack update changes them, with the pack’s new copy beside them, said once', () => {
    install(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    expect(install(v2, 'two').said).toBe(
      `[init] Kept your own config/a.toml; the pack's new copy is beside it, as config/a.toml${FROM_PACK}`,
    )
    expect(read('config/a.toml')).toBe('a = mine')
    expect(read(`config/a.toml${FROM_PACK}`)).toBe('a = 2')
    expect(read('config/b.toml')).toBe('b = 2')
    expect(install(v2, 'two').said).toBe('')
    expect(read('config/a.toml')).toBe('a = mine')
  })

  test('stay gone when the owner deleted one, with the pack’s new copy beside where it was', () => {
    install(v1, 'one')
    unlinkSync(join(data, 'options.txt'))
    install(v1, 'one')
    expect(there('options.txt')).toBe(false)
    install(v2, 'two')
    expect(there('options.txt')).toBe(false)
    expect(read(`options.txt${FROM_PACK}`)).toBe('o = 2')
  })

  test('follow the pack again once the owner’s copy is the pack’s', () => {
    install(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    install(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = 1')
    install(v2, 'two')
    expect(read('config/a.toml')).toBe('a = 2')
  })

  test('are all the owner’s where the record of what the pack placed is missing', () => {
    install(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    rmSync(join(data, '.blockly-pack-files'))
    install(v2, 'two')
    // Every file there stays as it was, the pack's new copy beside it; none is overwritten.
    expect(read('config/a.toml')).toBe('a = mine')
    expect(read('config/b.toml')).toBe('b = 1')
    expect(read(`config/b.toml${FROM_PACK}`)).toBe('b = 2')
  })

  test('are all the owner’s where that record was cut short', () => {
    install(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    const whole = record()
    writeFileSync(join(data, '.blockly-pack-files'), whole.slice(0, whole.indexOf('\n') + 1))
    install(v2, 'two')
    expect(read('config/a.toml')).toBe('a = mine')
    expect(read('config/b.toml')).toBe('b = 1')
    expect(read('options.txt')).toBe('o = 1')
  })

  test('stay the owner’s, every one, however many the owner changed', () => {
    const many = Object.fromEntries(
      Array.from({ length: 1500 }, (_, i) => [
        `config/a-mod-with-a-long-name/settings-${String(i).padStart(4, '0')}.toml`,
        'pack',
      ]),
    )
    const big = pack(many)
    install(big, 'big')
    for (const path of Object.keys(many)) writeFileSync(join(data, path), 'mine')
    expect(install(big, 'big').code).toBe(0)
    expect(Object.keys(many).every((path) => read(path) === 'mine')).toBe(true)
  })

  test('aren’t the pack’s where the install leaves them out, and stay the owner’s after', () => {
    writeFileSync(join(data, 'options.txt'), 'o = mine')
    expect(install(v1, 'one', { MODRINTH_OVERRIDES_EXCLUSIONS: 'options.txt' }).code).toBe(0)
    expect(read('options.txt')).toBe('o = mine')
    expect(record()).not.toContain('options.txt')
    install(v1, 'one')
    expect(read('options.txt')).toBe('o = mine')
    expect(read(`options.txt${FROM_PACK}`)).toBe('o = 1')
  })

  test('stay deleted when an install in between leaves them out', () => {
    install(v1, 'one')
    unlinkSync(join(data, 'options.txt'))
    install(v1, 'one', { MODRINTH_OVERRIDES_EXCLUSIONS: 'options.txt' })
    install(v1, 'one')
    expect(there('options.txt')).toBe(false)
  })

  test('take the server’s override over the pack’s other one', () => {
    install(pack({ 'server.properties': 'client' }, { 'server.properties': 'server' }), 'one')
    expect(read('server.properties')).toBe('server')
  })

  test('go to the helper as they always did where the pack can’t be fetched, or isn’t a link', () => {
    const missing = Bun.spawnSync([script, 'install-modrinth-modpack'], {
      env: {
        PATH: process.env.PATH ?? '',
        MODRINTH_MODPACK: `file://${join(root, 'missing.mrpack')}`,
        FAIL: '3',
      },
    })
    expect(missing.exitCode).toBe(3)
    const slug = Bun.spawnSync([script, 'install-modrinth-modpack'], {
      env: { PATH: process.env.PATH ?? '', MODRINTH_MODPACK: 'some-project', FAIL: '4' },
    })
    expect(slug.exitCode).toBe(4)
    expect(there('.blockly-pack-files')).toBe(false)
  })
})

describe('a pack’s install, as root', () => {
  test('writes inside the volume, never through a link left on it', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'kept.txt'), 'outside')
    install(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    symlinkSync(join(outside, 'kept.txt'), join(data, `config/a.toml${FROM_PACK}`))
    install(v2, 'two')
    expect(readFileSync(join(outside, 'kept.txt'), 'utf8')).toBe('outside')
    expect(lstatSync(join(data, `config/a.toml${FROM_PACK}`)).isSymbolicLink()).toBe(false)
    expect(read(`config/a.toml${FROM_PACK}`)).toBe('a = 2')
    // A folder on the way is a link: what the pack places there stays on the volume.
    symlinkSync(outside, join(data, 'extra'))
    install(pack({ 'extra/kept.txt': 'pack' }), 'three')
    expect(readFileSync(join(outside, 'kept.txt'), 'utf8')).toBe('outside')
    expect(read('extra/kept.txt')).toBe('pack')
  })
})

describe('a pack’s install that doesn’t finish', () => {
  test('keeps the owner’s files set aside while they can’t be put back, and puts them back later', () => {
    install(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    const before = record()
    expect(install(v2, 'two', { BLOCK: 'config/a.toml' }).code).not.toBe(0)
    expect(record()).toBe(before)
    expect(readFileSync(join(data, '.blockly-pack-kept/files/config/a.toml'), 'utf8')).toBe('a = mine')
    // Still in the way at the next start: nothing is installed, and the copy stays.
    expect(install(v2, 'two').code).not.toBe(0)
    expect(there('.blockly-pack-kept/files/config/a.toml')).toBe(true)
    rmSync(join(data, 'config/a.toml'), { recursive: true })
    expect(install(v2, 'two').code).toBe(0)
    expect(read('config/a.toml')).toBe('a = mine')
  })

  test('never takes a path outside the volume from what it set aside', () => {
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'outside')
    install(v1, 'one')
    // A plugin could leave this on the volume between starts.
    mkdirSync(join(data, '.blockly-pack-kept', 'files'), { recursive: true })
    writeFileSync(join(data, '.blockly-pack-kept', 'gone'), '../outside.txt\n/etc/hostname\n')
    install(v1, 'one')
    expect(readFileSync(outside, 'utf8')).toBe('outside')
  })

  test('leaves the owner’s files as they are when setting them aside was cut short', () => {
    install(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    // What a copy stopped halfway leaves: a part of the owner's file, never moved into place.
    mkdirSync(join(data, '.blockly-pack-kept.new', 'files', 'config'), { recursive: true })
    writeFileSync(join(data, '.blockly-pack-kept.new', 'files', 'config/a.toml'), 'a = mi')
    install(v1, 'one')
    expect(read('config/a.toml')).toBe('a = mine')
    expect(there('.blockly-pack-kept.new')).toBe(false)
  })

  test('puts the owner’s files back at the next install, when one is cut short', () => {
    install(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    unlinkSync(join(data, 'options.txt'))
    install(v1, 'one')
    expect(install(v2, 'two', { KILL: '1' }).code).not.toBe(0)
    expect(read('config/a.toml')).toBe('a = 2')
    const next = install(v2, 'two')
    expect(next.said).toContain("[init] Put back your own files from a pack install that didn't finish")
    expect(read('config/a.toml')).toBe('a = mine')
    expect(there('options.txt')).toBe(false)
    expect(there('.blockly-pack-kept')).toBe(false)
  })

  test('puts the owner’s files back when it fails, and the record waits', () => {
    install(v1, 'one')
    writeFileSync(join(data, 'config/a.toml'), 'a = mine')
    const before = record()
    expect(install(v2, 'two', { FAIL: '1' }).code).toBe(1)
    expect(read('config/a.toml')).toBe('a = mine')
    expect(record()).toBe(before)
  })
})
