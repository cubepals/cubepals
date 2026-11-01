// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import nbt from 'prismarine-nbt'
import { networkNbt } from './nbt.ts'

/** What PrismarineJS' NBT reader, as mineflayer reads a packet's NBT, makes of `bytes`. */
const read = (bytes: number[]) => {
  const parsed = nbt.protos.big.parsePacketBuffer('anonymousNbt', Buffer.from(bytes))
  expect(parsed.metadata.size).toBe(bytes.length)
  return nbt.simplify(parsed.data)
}

test('a compound of strings, booleans, lists and compounds reads back as written', () => {
  const value = {
    type: 'minecraft:notice',
    title: 'Maple Hollow · waking',
    body: [{ type: 'minecraft:plain_message', contents: 'Waking your world · about 30 seconds' }],
    none: [],
    inner: { yes: true, no: false },
  }
  expect(read(networkNbt(value))).toEqual({ ...value, inner: { yes: 1, no: 0 } })
})

test('a root string is a string tag with no name', () => {
  expect(networkNbt('hi')).toEqual([8, 0, 2, 0x68, 0x69])
  expect(read(networkNbt('hi'))).toBe('hi')
})

test('strings are Java’s modified UTF-8: NUL in two bytes, a character past U+FFFF as two halves', () => {
  expect(networkNbt('\0')).toEqual([8, 0, 2, 0xc0, 0x80])
  expect(networkNbt('é')).toEqual([8, 0, 2, 0xc3, 0xa9])
  expect(networkNbt('·')).toEqual([8, 0, 2, 0xc2, 0xb7])
  expect(networkNbt('€')).toEqual([8, 0, 3, 0xe2, 0x82, 0xac])
  expect(networkNbt('𝄞')).toEqual([8, 0, 6, 0xed, 0xa0, 0xb4, 0xed, 0xb4, 0x9e])
  expect(networkNbt('\x7f')).toEqual([8, 0, 1, 0x7f])
  expect(networkNbt('\x80')).toEqual([8, 0, 2, 0xc2, 0x80])
  expect(networkNbt('߿')).toEqual([8, 0, 2, 0xdf, 0xbf])
  expect(networkNbt('ࠀ')).toEqual([8, 0, 3, 0xe0, 0xa0, 0x80])
})

test('a list says its type, compound, and how many, in four bytes; an empty one says none', () => {
  expect(networkNbt({ l: [{}] })).toEqual([10, 9, 0, 1, 0x6c, 10, 0, 0, 0, 1, 0, 0])
  expect(networkNbt({ l: [] })).toEqual([10, 9, 0, 1, 0x6c, 0, 0, 0, 0, 0, 0])
  const many = Array.from({ length: 0x1_02_03 }, () => ({}))
  expect(networkNbt({ l: many }).slice(5, 10)).toEqual([10, 0, 0x01, 0x02, 0x03])
})

test('a string longer than NBT holds is refused, and the longest one is taken', () => {
  expect(() => networkNbt('a'.repeat(0x10000))).toThrow('at most 65535 bytes')
  expect(networkNbt('a'.repeat(0xffff)).slice(0, 3)).toEqual([8, 0xff, 0xff])
})
