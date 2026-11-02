// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seek over the opaque file bodies of an uncompressed tar instead of reading gigabytes twice.
 * node-tar decodes every header. Extended/GNU metadata falls back to its streaming parser;
 * the caller applies the same path, duplicate and size checks to the resulting entries.
 */
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { Header } from 'tar'

/** POSIX tar headers and padding use 512-byte blocks (IEEE Std 1003.1, ustar interchange format). */
const BLOCK_BYTES = 512
const FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile'])

export interface IndexedTarEntry {
  header: Header
  offset: number
}

/** Null asks the full parser to handle a format extension or malformed header. */
export async function indexTar(path: string, maxFiles: number): Promise<IndexedTarEntry[] | null> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const entries: IndexedTarEntry[] = []
    const block = Buffer.alloc(BLOCK_BYTES)
    let offset = 0
    let empty = false
    while (offset + BLOCK_BYTES <= size) {
      const read = await file.read(block, 0, BLOCK_BYTES, offset)
      if (read.bytesRead !== BLOCK_BYTES) return null
      const header = decodedHeader(block)
      if (header === null) return null
      offset += BLOCK_BYTES
      if (header.nullBlock) {
        if (empty) return entries
        empty = true
        continue
      }
      empty = false
      const end = bodyEnd(header, offset, size)
      if (end === null) return null
      entries.push({ header, offset })
      // Bound the preliminary index too. The full parser reports the actual entry limit.
      if (entries.length > maxFiles) return null
      offset = end
    }
    return null
  } finally {
    await file.close()
  }
}

/** node-tar owns number decoding and checksum validation, including malformed numeric fields. */
function decodedHeader(block: Buffer): Header | null {
  try {
    return new Header(block)
  } catch {
    return null
  }
}

/** Only ordinary files and empty directories can be indexed without interpreting extensions. */
function bodyEnd(header: Header, offset: number, size: number): number | null {
  const length = header.size ?? 0
  if (!header.cksumValid || !header.path || header.linkpath || !Number.isSafeInteger(length) || length < 0)
    return null
  if (!FILE_TYPES.has(header.type) && header.type !== 'Directory') return null
  if (header.type === 'Directory' && length !== 0) return null
  const end = offset + Math.ceil(length / BLOCK_BYTES) * BLOCK_BYTES
  return Number.isSafeInteger(end) && end <= size ? end : null
}

/** Only an entry actually consumed opens a file; cancellation closes it without draining its body. */
export function indexedBody(path: string, entry: IndexedTarEntry): ReadableStream<Uint8Array> {
  const size = entry.header.size ?? 0
  if (size === 0) return new ReadableStream({ start: (controller) => controller.close() })
  return Readable.toWeb(
    createReadStream(path, { start: entry.offset, end: entry.offset + size - 1 }),
  ) as ReadableStream<Uint8Array>
}
