// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How an archive Cubepals keeps (a backup, a world put to rest, a move's copy) is compressed,
 * told from its first bytes, and the stream that inflates it: gzip, as every archive so far, or
 * zstd, which inflates about twelve times as fast. Readers take both, so archives can move to zstd
 * once every reader does, blocklyd's included; until then every writer packs gzip.
 *
 * Not for what a player downloads, which is always a `.tar.gz` (`filterTarball`), nor for uploads;
 * the magic bytes are the runtime port's (`app/ports/runtime.ts`).
 */
import { PassThrough, type Readable } from 'node:stream'
import { createGunzip, createZstdDecompress } from 'node:zlib'
import { GZIP_MAGIC, ZSTD_MAGIC } from '../../app/ports/runtime.ts'


export type ArchiveCodec = 'gzip' | 'zstd'

/** The codec an archive starting with `head` is compressed with; null for neither. */
export function codecOf(head: Uint8Array): ArchiveCodec | null {
  const starts = (magic: readonly number[]) => magic.every((byte, at) => head[at] === byte)
  if (head.length >= GZIP_MAGIC.length && starts(GZIP_MAGIC)) return 'gzip'
  if (head.length >= ZSTD_MAGIC.length && starts(ZSTD_MAGIC)) return 'zstd'
  return null
}

/**
 * `input` inflated, by the codec its first bytes name, `chunkSize` bytes at a time. An archive in
 * neither fails the stream with `neither`'s error.
 */
export function inflating(input: Readable, chunkSize: number, neither: () => Error): Readable {
  const output = new PassThrough()
  let head = Buffer.alloc(0)
  const decide = () => {
    input.off('data', taken)
    input.off('end', decide)
    input.pause()
    const codec = codecOf(head)
    if (codec === null) {
      output.destroy(neither())
      return
    }
    const inflate = codec === 'gzip' ? createGunzip({ chunkSize }) : createZstdDecompress({ chunkSize })
    inflate.on('error', (error) => output.destroy(error))
    output.on('close', () => inflate.destroy())
    inflate.pipe(output)
    inflate.write(head)
    input.pipe(inflate)
  }
  const taken = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk])
    if (head.length >= ZSTD_MAGIC.length) decide()
  }
  input.on('data', taken)
  input.on('end', decide)
  return output
}
