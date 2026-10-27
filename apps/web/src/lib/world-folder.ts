// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world folder a player picks or drops, sent as one file (docs/world-import.md): its files
 * gathered from the picker or the drop, looked at before anything is sent, and laid end to end as
 * a tarball the browser never holds. The tarball is a `Blob` of the headers this writes and the
 * files' own `File`s, so its size is known before the upload starts and it goes up in one PUT with
 * progress. Why it is written here rather than taken from a library is in
 * docs/dependency-audit.md. The world inside is found by the control plane, not here.
 */

export interface PickedFile {
  /** Its path inside what was picked, with forward slashes: `My World/region/r.0.0.mca`. */
  path: string
  file: Blob
}

const BLOCK = 512
const encoder = new TextEncoder()

/** What a look at the names can already say about a folder, before it is sent. */
export type FolderLook =
  | { kind: 'world'; sizeBytes: number }
  | { kind: 'bedrock' }
  | { kind: 'nothing' }
  | { kind: 'empty' }

/** Whether a folder holds a Java world (a `level.dat`), a Bedrock one, or none, from its names. */
export function lookAt(files: ReadonlyArray<{ path: string; file: { size: number } }>): FolderLook {
  if (files.length === 0) return { kind: 'empty' }
  const names = files.map((file) => file.path)
  const bedrock =
    names.some((path) => /(^|\/)levelname\.txt$/.test(path)) && names.some((path) => /(^|\/)db\//.test(path))
  if (bedrock) return { kind: 'bedrock' }
  if (!names.some((path) => /(^|\/)level\.dat(_old)?$/.test(path))) return { kind: 'nothing' }
  return { kind: 'world', sizeBytes: files.reduce((sum, file) => sum + file.file.size, 0) }
}

/** The files a folder picker gave, by the paths it gives them (`webkitRelativePath`). */
export function pickedFrom(list: FileList | readonly File[]): PickedFile[] {
  return [...list].map((file) => ({ path: file.webkitRelativePath || file.name, file }))
}

/**
 * The files a drop holds, folders walked: a browser hands a dropped folder over as an entry to
 * read, a hundred names at a time, rather than as files.
 */
export async function droppedFrom(items: DataTransferItemList): Promise<PickedFile[]> {
  const entries = [...items]
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null)
  const files: PickedFile[] = []
  const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      )
      files.push({ path, file })
      return
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      )
      if (batch.length === 0) return
      for (const child of batch) await walk(child, `${path}/${child.name}`)
    }
  }
  for (const entry of entries) await walk(entry, entry.name)
  return files
}

/** The bytes of one header field: text, NUL-padded to its width. */
function field(block: Uint8Array, at: number, width: number, text: string): void {
  block.set(encoder.encode(text).subarray(0, width), at)
}

/** A number as a header writes one: octal, zero-padded, ending in a NUL. */
const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, '0')}\0`

/** One 512-byte ustar header, its checksum filled in. */
function header(name: string, size: number, type: '0' | 'x', mtime: number): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(BLOCK)
  field(block, 0, 100, name)
  field(block, 100, 8, octal(0o644, 8))
  field(block, 108, 8, octal(1000, 8))
  field(block, 116, 8, octal(1000, 8))
  field(block, 124, 12, octal(size, 12))
  field(block, 136, 12, octal(mtime, 12))
  field(block, 148, 8, '        ')
  field(block, 156, 1, type)
  field(block, 257, 6, 'ustar\0')
  field(block, 263, 2, '00')
  const sum = block.reduce((total, byte) => total + byte, 0)
  field(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return block
}

/** A POSIX extended header naming the file, for a path a ustar name can't hold: long, or not ASCII. */
function longName(path: string, mtime: number): Uint8Array<ArrayBuffer>[] {
  const body = (length: number) => `${length} path=${path}\n`
  let length = encoder.encode(body(0)).length
  while (encoder.encode(body(length)).length !== length) length = encoder.encode(body(length)).length
  const record = new Uint8Array(encoder.encode(body(length)))
  return [header('PaxHeader', record.length, 'x', mtime), record, padding(record.length)]
}

const padding = (size: number): Uint8Array<ArrayBuffer> => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK)

/**
 * The files as one tarball, in the order given: each file's header, then the file itself, padded
 * to a block, and two empty blocks at the end, as POSIX lays a tarball out.
 */
export function tarOf(files: readonly PickedFile[], now = Date.now()): Blob {
  const mtime = Math.floor(now / 1000)
  const parts: BlobPart[] = []
  for (const { path, file } of files) {
    const plain = /^[\x20-\x7e]*$/.test(path) && path.length <= 100
    if (!plain) parts.push(...longName(path, mtime))
    parts.push(header(plain ? path : path.slice(0, 100).replace(/[^\x20-\x7e]/g, '_'), file.size, '0', mtime))
    parts.push(file, padding(file.size))
  }
  parts.push(new Uint8Array(2 * BLOCK))
  return new Blob(parts, { type: 'application/x-tar' })
}

/**
 * A zip's names, from its central directory, read from the end of the file without reading the
 * rest: what `lookAt` says of the files it holds, sizes as they inflate. Null for a file zip.js
 * can't read as a zip; the control plane says what it is.
 */
export async function lookInZip(zip: Blob): Promise<FolderLook | null> {
  const { BlobReader, ZipReader } = await import('@zip.js/zip.js')
  const reader = new ZipReader(new BlobReader(zip), { useWebWorkers: false })
  try {
    const entries = await reader.getEntries()
    return lookAt(
      entries
        .filter((entry) => !entry.directory)
        .map((entry) => ({ path: entry.filename, file: { size: entry.uncompressedSize } })),
    )
  } catch {
    return null
  } finally {
    await reader.close().catch(() => undefined)
  }
}
