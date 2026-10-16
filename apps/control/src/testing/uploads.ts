// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { gzipSync } from 'node:zlib'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import nbt from 'prismarine-nbt'

/** A Fabric mod's jar, declaring itself as a real one does; `fields` overrides its fabric.mod.json. */
export const fabricJar = (id: string, fields: Record<string, unknown> = {}): Uint8Array =>
  zipSync({
    'fabric.mod.json': strToU8(
      JSON.stringify({
        schemaVersion: 1,
        id,
        name: `Mod ${id}`,
        version: '1.0.0',
        environment: '*',
        depends: { minecraft: '>=26' },
        ...fields,
      }),
    ),
    [`net/example/${id}/Mod.class`]: new Uint8Array([0xca, 0xfe, 0xba, 0xbe, ...strToU8(id)]),
  })

/**
 * A Paper plugin's jar whose plugin.yml names its main class, compiled for one Java release: the
 * class holds the magic and the version a compiler writes, as BentoBox 3.23.3's holds Java 25's.
 */
export const pluginJar = (name: string, java: number): Uint8Array =>
  zipSync({
    'plugin.yml': strToU8(`name: ${name}\nmain: net.example.${name}.Plugin\nversion: 1.0\n`),
    [`net/example/${name}/Plugin.class`]: new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, java + 44]),
  })

/**
 * A class file holding what a test needs in its constant pool: its own name, the classes and
 * members (`owner.name`) it refers to, and its string constants. It has no methods: what a check
 * reads is the pool.
 */
export function classFile(spec: {
  name: string
  classes?: readonly string[]
  members?: readonly string[]
  strings?: readonly string[]
}): Uint8Array {
  const pool: number[][] = []
  const add = (entry: number[]) => pool.push(entry)
  const utf8 = (text: string) => {
    const bytes = strToU8(text)
    add([1, bytes.length >> 8, bytes.length & 0xff, ...bytes])
    return pool.length
  }
  const u2 = (n: number) => [n >> 8, n & 0xff]
  const classOf = (name: string) => {
    const at = utf8(name)
    add([7, ...u2(at)])
    return pool.length
  }
  const self = classOf(spec.name)
  const object = classOf('java/lang/Object')
  for (const name of spec.classes ?? []) classOf(name)
  for (const text of spec.strings ?? []) add([8, ...u2(utf8(text))])
  for (const member of spec.members ?? []) {
    const [owner = '', name = ''] = member.split('.')
    const ownerAt = classOf(owner)
    const nameAt = utf8(name)
    const typeAt = utf8('()V')
    add([12, ...u2(nameAt), ...u2(typeAt)])
    add([10, ...u2(ownerAt), ...u2(pool.length)])
  }
  return new Uint8Array([
    0xca,
    0xfe,
    0xba,
    0xbe,
    0,
    0,
    0,
    65,
    ...u2(pool.length + 1),
    ...pool.flat(),
    ...u2(0x21),
    ...u2(self),
    ...u2(object),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ])
}

/** A zip holding the given text files: a jar with whatever metadata a test needs. */
export const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])))

/** A world's level.dat as the game writes it: gzipped NBT naming the version that saved it. */
export const levelDat = (version: string): Uint8Array =>
  gzipSync(
    nbt.writeUncompressed({
      type: 'compound',
      name: '',
      value: {
        Data: {
          type: 'compound',
          value: {
            DataVersion: { type: 'int', value: 5023 },
            Version: { type: 'compound', value: { Name: { type: 'string', value: version } } },
          },
        },
      },
    }),
  )

/** A zip of the given files, as a test uploads one: an app test never reaches for the zip library. */
export const zipBytes = (files: Record<string, Uint8Array>): Uint8Array => zipSync(files)

/** A zip's files by name, as a test reads what Blockly built. */
export const unzipBytes = (bytes: Uint8Array): Record<string, Uint8Array> => unzipSync(bytes)

export const utf8 = (text: string): Uint8Array => strToU8(text)
export const textOf = (bytes: Uint8Array): string => strFromU8(bytes)
