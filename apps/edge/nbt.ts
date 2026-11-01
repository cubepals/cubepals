// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minecraft's NBT, written as the network sends it since 1.20.2: a root tag's type, then its
 * payload, with no name. Only what the edge's dialog hold writes (`dialog-hold.ts`): strings,
 * booleans as bytes, compounds, and lists of compounds. Not for reading NBT.
 */

/** The tag types, by the numbers of Minecraft's NBT format (minecraft.wiki/w/NBT_format). */
const TAG = { end: 0, byte: 1, list: 9, compound: 10, string: 8 } as const

export type Nbt = string | boolean | readonly NbtCompound[] | NbtCompound
interface NbtCompound {
  readonly [key: string]: Nbt
}

/** A string as NBT writes it: Java's modified UTF-8, after its length in two bytes. */
function utf(text: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    // UTF-16 code units, each on its own: a pair is two three-byte sequences, and NUL takes two bytes.
    const unit = text.charCodeAt(i)
    if (unit >= 0x01 && unit <= 0x7f) bytes.push(unit)
    else if (unit <= 0x7ff) bytes.push(0xc0 | (unit >> 6), 0x80 | (unit & 0x3f))
    else bytes.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f))
  }
  if (bytes.length > 0xffff) throw new Error('an NBT string holds at most 65535 bytes')
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes]
}

function typeOf(value: Nbt): number {
  if (typeof value === 'string') return TAG.string
  if (typeof value === 'boolean') return TAG.byte
  return Array.isArray(value) ? TAG.list : TAG.compound
}

function payload(value: Nbt): number[] {
  if (typeof value === 'string') return utf(value)
  if (typeof value === 'boolean') return [value ? 1 : 0]
  if (Array.isArray(value)) {
    const items = value as readonly NbtCompound[]
    const count = items.length
    return [
      items.length === 0 ? TAG.end : TAG.compound,
      (count >>> 24) & 0xff,
      (count >>> 16) & 0xff,
      (count >>> 8) & 0xff,
      count & 0xff,
      ...items.flatMap(payload),
    ]
  }
  const entries = Object.entries(value as NbtCompound)
  return [...entries.flatMap(([key, item]) => [typeOf(item), ...utf(key), ...payload(item)]), TAG.end]
}

/** `value` as a nameless root tag, as a packet carries it. */
export function networkNbt(value: Nbt): number[] {
  return [typeOf(value), ...payload(value)]
}
