// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a class file names in its constant pool (JVMS §4.4): the class it is, the classes and
 * members it uses, and the strings it holds. That is what a class can reach at run time without
 * building a name out of pieces, so it is what a malware check reads (`jar-scan.ts`). The Java a
 * class needs is `class-files.ts`'s; this reads past the version to the pool.
 */

/** A class file's own name and what its constant pool refers to; null for bytes that aren't one. */
export interface ClassConstants {
  /** Its own name, in the internal form: `net/example/Mod`. */
  name: string
  /** Every class it refers to, its own included. */
  classes: Set<string>
  /** Fields and methods it uses, as `owner.name`: `java/lang/Runtime.exec`. */
  members: Set<string>
  /** Its string constants: what `ldc` can push. */
  strings: Set<string>
}

/** Constant pool tags (JVMS table 4.4-B) and the bytes each entry after its tag takes. */
const UTF8 = 1
const CLASS = 7
const STRING = 8
const FIELD = 9
const METHOD = 10
const INTERFACE_METHOD = 11
const NAME_AND_TYPE = 12
const FIXED: Readonly<Record<number, number>> = {
  3: 4,
  4: 4,
  5: 8,
  6: 8,
  [CLASS]: 2,
  [STRING]: 2,
  [FIELD]: 4,
  [METHOD]: 4,
  [INTERFACE_METHOD]: 4,
  [NAME_AND_TYPE]: 4,
  15: 3,
  16: 2,
  17: 4,
  18: 4,
  19: 2,
  20: 2,
}
/** Longs and doubles take two entries of the pool (JVMS §4.4.5). */
const WIDE = new Set([5, 6])

const decoder = new TextDecoder('utf-8', { fatal: false })

export function classConstants(bytes: Uint8Array): ClassConstants | null {
  if (bytes.length < 10 || bytes[0] !== 0xca || bytes[1] !== 0xfe || bytes[2] !== 0xba || bytes[3] !== 0xbe)
    return null
  const pool = readPool(bytes)
  if (pool === null) return null
  const constants: ClassConstants = { name: '', classes: new Set(), members: new Set(), strings: new Set() }
  for (let i = 1; i < pool.tags.length; i++) collect(pool, i, constants)
  // After the pool: access flags, then the class's own entry.
  const self = pool.end + 4 <= bytes.length ? pool.classAt(pool.view.getUint16(pool.end + 2)) : undefined
  return self === undefined ? null : { ...constants, name: self }
}

/** A constant pool, read: each entry's tag and where its body starts, the texts, and where it ends. */
interface Pool {
  view: DataView
  tags: Uint8Array
  utf8: Map<number, string>
  end: number
  /** The two bytes at an entry's body, `plus` bytes in; 0 past the end. */
  u2(index: number, plus?: number): number
  classAt(index: number): string | undefined
}

function readPool(bytes: Uint8Array): Pool | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint16(8)
  const tags = new Uint8Array(count)
  const at = new Uint32Array(count)
  const utf8 = new Map<number, string>()
  let offset = 10
  for (let i = 1; i < count; i++) {
    const tag = bytes[offset]
    if (tag === undefined) return null
    tags[i] = tag
    at[i] = offset + 1
    const next = tag === UTF8 ? textEnd(bytes, view, offset) : offset + 1 + (FIXED[tag] ?? Number.NaN)
    if (Number.isNaN(next) || next > bytes.length) return null
    // Modified UTF-8 differs only in NUL and characters outside the BMP, which no name here needs.
    if (tag === UTF8) utf8.set(i, decoder.decode(bytes.subarray(offset + 3, next)))
    offset = next
    if (WIDE.has(tag)) i++
  }
  const u2 = (index: number, plus = 0) => {
    const from = (at[index] ?? bytes.length) + plus
    return from + 2 <= bytes.length ? view.getUint16(from) : 0
  }
  const classAt = (index: number) => (tags[index] === CLASS ? utf8.get(u2(index)) : undefined)
  return { view, tags, utf8, end: offset, u2, classAt }
}

/** Where a Utf8 entry starting at `offset` ends; NaN where its length can't be read. */
function textEnd(bytes: Uint8Array, view: DataView, offset: number): number {
  return offset + 3 > bytes.length ? Number.NaN : offset + 3 + view.getUint16(offset + 1)
}

/** What one entry of the pool names, added to what the class refers to. */
function collect(pool: Pool, i: number, into: ClassConstants): void {
  const tag = pool.tags[i]
  const text = pool.utf8.get(pool.u2(i))
  if (tag === CLASS && text !== undefined) into.classes.add(text)
  else if (tag === STRING && text !== undefined) into.strings.add(text)
  else if (tag === FIELD || tag === METHOD || tag === INTERFACE_METHOD) {
    const owner = pool.classAt(pool.u2(i))
    const nameAndType = pool.u2(i, 2)
    const member = pool.tags[nameAndType] === NAME_AND_TYPE ? pool.utf8.get(pool.u2(nameAndType)) : undefined
    if (owner !== undefined && member !== undefined) into.members.add(`${owner}.${member}`)
  }
}
