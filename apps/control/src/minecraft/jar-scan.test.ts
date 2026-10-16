// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Class files built in the test, read for their constant pools, and jars of them scanned: what a
 * list's signature detects, and what is only flagged for operators.
 */
import { describe, expect, test } from 'bun:test'
import { classFile } from '../testing/uploads.ts'
import { type ClassConstants, classConstants } from './class-constants.ts'
import { JarScan, type Signatures } from './jar-scan.ts'

const NONE: Signatures = { classes: new Map(), strings: new Map() }
const read = (spec: Parameters<typeof classFile>[0]): ClassConstants => {
  const constants = classConstants(classFile(spec))
  if (constants === null) throw new Error('Not a class file')
  return constants
}
const scanned = (classes: ReadonlyArray<Parameters<typeof classFile>[0]>, signatures = NONE) => {
  const scan = new JarScan(signatures)
  for (const spec of classes) scan.read(read(spec))
  return scan.result()
}

describe('a class file’s constant pool', () => {
  test('names the class, what it refers to, and its strings', () => {
    const constants = read({
      name: 'net/example/Mod',
      classes: ['java/lang/ProcessBuilder'],
      members: ['java/lang/Runtime.exec'],
      strings: ['hello', 'ünïcode'],
    })
    expect(constants.name).toBe('net/example/Mod')
    expect([...constants.classes].sort()).toEqual([
      'java/lang/Object',
      'java/lang/ProcessBuilder',
      'java/lang/Runtime',
      'net/example/Mod',
    ])
    expect([...constants.members]).toEqual(['java/lang/Runtime.exec'])
    expect([...constants.strings]).toEqual(['hello', 'ünïcode'])
  })

  test('is nothing for bytes that aren’t a whole class file', () => {
    const whole = classFile({ name: 'net/example/Mod', strings: ['hello'] })
    expect(classConstants(whole.subarray(0, 30))).toBeNull()
    expect(classConstants(new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65]))).toBeNull()
    expect(classConstants(new TextEncoder().encode('not a class at all'))).toBeNull()
  })
})

describe('a jar’s scan', () => {
  const signatures: Signatures = {
    classes: new Map([['me/example/Backdoor', { source: 'list', family: 'Example' }]]),
    strings: new Map([['==cmds1', { source: 'list', family: 'Other' }]]),
  }

  test('detects a class or a string a list names, exactly', () => {
    expect(scanned([{ name: 'me/example/Backdoor' }], signatures).detection).toEqual({
      match: 'me/example/Backdoor',
      source: 'list',
      family: 'Example',
    })
    expect(scanned([{ name: 'a/Mod', strings: ['==cmds1'] }], signatures).detection?.family).toBe('Other')
    expect(scanned([{ name: 'me/example/BackdoorX', strings: ['==cmds12'] }], signatures)).toEqual({
      detection: null,
      flags: [],
    })
  })

  test('flags what a mod rarely needs, and detects nothing for it', () => {
    expect(
      scanned([
        { name: 'a/Net', classes: ['java/net/URLClassLoader'] },
        { name: 'a/Exec', members: ['java/lang/Runtime.exec'] },
        { name: 'a/Unsafe', strings: ['theUnsafe'] },
        { name: 'a/Write', classes: ['java/io/FileOutputStream'], strings: ['/etc/cron.d/job'] },
      ]),
    ).toEqual({
      detection: null,
      flags: ['loads_code_from_network', 'runs_commands', 'uses_unsafe', 'writes_outside_server'],
    })
    // A path in the server's own folder, or one never written, is no flag.
    expect(
      scanned([
        { name: 'a/Config', classes: ['java/io/FileWriter'], strings: ['config/mod.toml'] },
        { name: 'a/Text', strings: ['/etc/passwd'] },
      ]).flags,
    ).toEqual([])
  })

  test('flags obfuscation: names taken away, or an obfuscator’s own mark', () => {
    const short = Array.from({ length: 12 }, (_, i) => ({ name: `a/${String.fromCharCode(97 + i)}` }))
    expect(scanned(short).flags).toEqual(['obfuscated'])
    expect(scanned([{ name: 'a/IlIlIl1I' }]).flags).toEqual(['obfuscated'])
    expect(scanned([{ name: 'a/Mod', strings: ['Obfuscated by Allatori'] }]).flags).toEqual(['obfuscated'])
    // A few short names in a small jar prove nothing.
    expect(scanned(short.slice(0, 3)).flags).toEqual([])
  })
})
