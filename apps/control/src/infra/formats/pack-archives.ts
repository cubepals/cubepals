// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { type FileHandle, open, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  type Entry,
  ERR_AMBIGUOUS_ARCHIVE,
  ERR_BAD_FORMAT,
  ERR_CENTRAL_DIRECTORY_NOT_FOUND,
  ERR_CODEC_OUT_OF_MEMORY,
  ERR_ENCRYPTED,
  ERR_ENCRYPTED_CENTRAL_DIRECTORY,
  ERR_ENTRY_DATA_OUT_OF_BOUNDS,
  ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND,
  ERR_EOCDR_NOT_FOUND,
  ERR_EXTRAFIELD_ZIP64_NOT_FOUND,
  ERR_INVALID_COMPRESSED_DATA,
  ERR_INVALID_CRC32,
  ERR_INVALID_UNCOMPRESSED_SIZE,
  ERR_LOCAL_FILE_HEADER_NOT_FOUND,
  ERR_OVERLAPPING_ENTRY,
  ERR_SPLIT_ZIP_FILE,
  ERR_UNSAFE_FILENAME,
  ERR_UNSUPPORTED_COMPRESSION,
  ERR_UNSUPPORTED_ENCRYPTION,
  ERR_UNSUPPORTED_UINT64,
  type FileEntry,
  Reader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  WARNING_DUPLICATE_FILENAME,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js'
import {
  type ArchiveLimits,
  DownloadRefused,
  HostileArchive,
  type PackArchive,
  type PackArchives,
  UnreadableFile,
} from '../../app/ports/formats.ts'

/**
 * Packs through zip.js in its strictest reading (docs/dependency-audit.md), with Blockly's own
 * checks on top for what zip.js leaves to the caller: names that collide ignoring case, links,
 * sizes and ratios, and entries that overlap.
 */
export class LibraryPackArchives implements PackArchives {
  async open(path: string, limits: ArchiveLimits): Promise<PackArchive> {
    const file = new FileReader(path)
    const zip = new ZipReader(file, {
      strictness: 'strict',
      checkOverlappingEntry: true,
      checkCrc32: true,
      useWebWorkers: false,
    })
    try {
      const files = await checkedFiles(zip, limits)
      return new OpenPackArchive(file, files)
    } catch (error) {
      await file.close()
      throw archiveError(error)
    }
  }

  async write(
    path: string,
    entries: AsyncIterable<{ name: string; data: Uint8Array | ReadableStream<Uint8Array> }>,
  ): Promise<{ sizeBytes: number; sha512: string }> {
    const out = createWriteStream(path)
    try {
      // The same entries always make the same bytes: no clock in any header, so a pack written
      // again, anywhere, has the sha512 it had (a curated copy is checked by it).
      const zip = new ZipWriter(Writable.toWeb(out), {
        level: 6,
        useWebWorkers: false,
        lastModDate: writtenAt(),
        extendedTimestamp: false,
      })
      for await (const { name, data } of entries)
        await zip.add(name, data instanceof Uint8Array ? new Uint8ArrayReader(data) : data)
      await zip.close()
      await finished(out)
    } catch (error) {
      out.destroy()
      await rm(path, { force: true })
      throw error
    }
    return digestOf(path)
  }

  /**
   * Past `maxBytes` the request itself is aborted, not only the reading of it: a body left
   * uncancelled keeps arriving and is held in memory by the runtime (Bun buffered an endless test
   * body to 15 GB, 2026-09-26), so the connection is cut and every chunk is written as it comes.
   */
  async fetchTo(
    url: string,
    path: string,
    maxBytes: number,
    options: { allowed?(url: string): boolean } = {},
  ): Promise<{ sizeBytes: number; sha512: string }> {
    const abort = new AbortController()
    const response = await follow(url, abort.signal, options.allowed)
    const tooLarge = () => new HostileArchive('too_large', `${url} is more than ${maxBytes} bytes`)
    if (!response.ok || response.body === null) {
      abort.abort()
      throw new Error(`Fetching ${url} answered ${response.status}`)
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      abort.abort()
      throw tooLarge()
    }
    const hash = createHash('sha512')
    const out = createWriteStream(path)
    const reader = response.body.getReader()
    let size = 0
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        size += next.value.byteLength
        if (size > maxBytes) throw tooLarge()
        hash.update(next.value)
        if (!out.write(next.value)) await once(out, 'drain')
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve())),
      )
    } catch (error) {
      abort.abort()
      await reader.cancel().catch(() => undefined)
      // The file is removed once the stream has let go of it: removed any sooner, a stream still
      // opening creates it again, and a refused download is left on disk.
      if (!out.closed) {
        const closed = once(out, 'close').catch(() => undefined)
        out.destroy()
        await closed
      }
      await rm(path, { force: true })
      throw error
    }
    return { sizeBytes: size, sha512: hash.digest('hex') }
  }
}

/**
 * The one time every entry Blockly writes carries: the earliest a zip can say. A zip keeps local
 * time, so it is made from local fields as each write starts: the same bytes in every time zone.
 */
const writtenAt = () => new Date(1980, 0, 1)

/** How many redirects a held download follows before it gives up. */
const MAX_REDIRECTS = 5
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/**
 * The response at `url`. Held to `allowed` when given: redirects are followed by hand, and each
 * address is checked before it is asked, so an allowed host can never send a download on to one
 * that isn't, such as an address on the control plane's own network.
 */
async function follow(
  url: string,
  signal: AbortSignal,
  allowed?: (url: string) => boolean,
): Promise<Response> {
  if (allowed === undefined) return fetch(url, { signal })
  let at = url
  for (let hop = 0; ; hop++) {
    if (!allowed(at)) throw new DownloadRefused(`${at} is not an address this download may use`)
    const response = await fetch(at, { signal, redirect: 'manual' })
    if (!REDIRECTS.has(response.status)) return response
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (location === null) throw new DownloadRefused(`${at} redirected nowhere`)
    if (hop >= MAX_REDIRECTS) throw new DownloadRefused(`${url} redirected more than ${MAX_REDIRECTS} times`)
    at = new URL(location, at).toString()
  }
}

/** One opened pack: its checked files, read from the file on disk only when asked for. */
class OpenPackArchive implements PackArchive {
  readonly files: ReadonlyArray<{ name: string; sizeBytes: number }>
  #file: FileReader
  #entries: ReadonlyMap<string, FileEntry>

  constructor(file: FileReader, entries: ReadonlyMap<string, FileEntry>) {
    this.#file = file
    this.#entries = entries
    this.files = [...entries].map(([name, entry]) => ({ name, sizeBytes: entry.uncompressedSize }))
  }

  async read(name: string, maxBytes: number): Promise<Uint8Array> {
    const declared = this.#entry(name).uncompressedSize
    if (declared > maxBytes)
      throw new HostileArchive('too_large', `${name} is ${declared} bytes, more than ${maxBytes}`)
    const bytes = new Uint8Array(declared)
    const reader = this.stream(name).getReader()
    // stream() errors before a byte past the declared size, so the bytes always fit.
    for (let filled = 0, next = await reader.read(); !next.done; next = await reader.read()) {
      bytes.set(next.value, filled)
      filled += next.value.byteLength
    }
    return bytes
  }

  /**
   * zip.js stops at the first byte past the declared size; the count here holds that line again,
   * and aborts the inflate, whatever the library does.
   */
  stream(name: string): ReadableStream<Uint8Array> {
    const entry = this.#entry(name)
    const declared = entry.uncompressedSize
    const abort = new AbortController()
    let produced = 0
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        produced += chunk.byteLength
        if (produced > declared) {
          const error = new HostileArchive('bomb', `${name} inflates past the ${declared} bytes it declares`)
          abort.abort(error)
          throw error
        }
        controller.enqueue(chunk)
      },
    })
    // zip.js leaves the stream open, so it ends with the reason in Blockly's terms.
    entry
      .getData(writable, { signal: abort.signal, preventClose: true })
      .then(
        () => writable.close(),
        (error: unknown) => writable.abort(archiveError(error, name)),
      )
      .catch(() => {})
    return readable
  }

  async close(): Promise<void> {
    await this.#file.close()
  }

  #entry(name: string): FileEntry {
    const entry = this.#entries.get(name)
    if (entry === undefined) throw new Error(`The pack has no file ${name}`)
    return entry
  }
}

/**
 * A file on this machine read by position, so only the bytes asked for are ever in memory. Not
 * `fs.openAsBlob` with zip.js's BlobReader: on Bun 1.3, a `slice().stream()` of a file-backed Blob
 * over 1 MiB never ends unless it reaches the end of the file, and a FileHandle reads the same on
 * Node and Bun.
 */
class FileReader extends Reader<string> {
  #path: string
  #handle: FileHandle | undefined

  constructor(path: string) {
    super(path)
    this.#path = path
  }

  override async init(): Promise<void> {
    if (this.#handle !== undefined) return
    this.#handle = await open(this.#path, 'r')
    this.size = (await this.#handle.stat()).size
  }

  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    if (this.#handle === undefined) throw new Error(`${this.#path} is closed`)
    const bytes = new Uint8Array(Math.max(0, Math.min(index + length, this.size) - index))
    let filled = 0
    while (filled < bytes.length) {
      const { bytesRead } = await this.#handle.read(bytes, filled, bytes.length - filled, index + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return filled === bytes.length ? bytes : bytes.subarray(0, filled)
  }

  async close(): Promise<void> {
    const handle = this.#handle
    this.#handle = undefined
    await handle?.close()
  }
}

/**
 * Every entry in the central directory, checked in the order it comes, stopping at the first that
 * fails; then what only the whole directory shows: folders under files, the overall ratio, overlap,
 * and each local header against its central record.
 */
async function checkedFiles(zip: ZipReader<unknown>, limits: ArchiveLimits): Promise<Map<string, FileEntry>> {
  const entries: Entry[] = []
  const files = new Map<string, FileEntry>()
  const kinds = new Map<string, 'file' | 'folder'>()
  let totalBytes = 0
  let totalCompressed = 0
  for await (const entry of zip.getEntriesGenerator({
    strictness: 'strict',
    filenameValidation: 'strict',
    filenameEncoding: 'utf-8',
    normalizeFilename,
  })) {
    entries.push(entry)
    if (entries.length > limits.maxFiles * 2)
      throw new HostileArchive('too_many_files', `More than ${limits.maxFiles * 2} entries`)
    const name = checkedName(entry)
    const type = (entry.externalFileAttributes >>> 16) & S_IFMT
    // Any host, not only Unix: 7-Zip writes Unix modes under the MS-DOS host too.
    if (entry.symlink || !ENTRY_TYPES.has(type))
      throw new HostileArchive('link', `${name} is a link, device or pipe, not a file`)
    if (
      entry.encrypted ||
      entry.extraFieldAES !== undefined ||
      ((entry.rawBitFlag ?? 0) & ENCRYPTION_FLAGS) !== 0
    )
      throw new HostileArchive('encrypted', `${name} is encrypted`)
    if (entry.compressionMethod !== STORED && entry.compressionMethod !== DEFLATED)
      throw new HostileArchive('malformed', `${name} is compressed with method ${entry.compressionMethod}`)
    if (entry.compressionMethod === STORED && entry.compressedSize !== entry.uncompressedSize)
      throw new HostileArchive('malformed', `${name} is stored, yet its two sizes differ`)
    if (entry.diskNumberStart !== 0) throw new HostileArchive('malformed', `${name} is on another disk`)
    const key = keyOf(name)
    if (kinds.has(key)) throw new HostileArchive('duplicate', `${name} is in the pack twice, ignoring case`)
    kinds.set(key, entry.directory ? 'folder' : 'file')
    if (entry.directory) continue

    if (files.size + 1 > limits.maxFiles)
      throw new HostileArchive('too_many_files', `More than ${limits.maxFiles} files`)
    if (entry.uncompressedSize > limits.maxFileBytes)
      throw new HostileArchive(
        'too_large',
        `${name} is ${entry.uncompressedSize} bytes, more than ${limits.maxFileBytes}`,
      )
    totalBytes += entry.uncompressedSize
    totalCompressed += entry.compressedSize
    if (totalBytes > limits.maxTotalBytes)
      throw new HostileArchive('too_large', `The files come to more than ${limits.maxTotalBytes} bytes`)
    if (
      entry.uncompressedSize > ENTRY_BOMB_FLOOR &&
      entry.uncompressedSize > ENTRY_BOMB_RATIO * entry.compressedSize
    )
      throw new HostileArchive(
        'bomb',
        `${name} inflates ${entry.compressedSize} bytes to ${entry.uncompressedSize}`,
      )
    files.set(name, entry)
  }

  for (const name of files.keys())
    for (let slash = name.indexOf('/'); slash !== -1; slash = name.indexOf('/', slash + 1))
      if (kinds.get(keyOf(name.slice(0, slash))) === 'file')
        throw new HostileArchive('duplicate', `${name} is under ${name.slice(0, slash)}, which is a file`)
  if (totalBytes > PACK_BOMB_FLOOR && totalBytes > PACK_BOMB_RATIO * totalCompressed)
    throw new HostileArchive('bomb', `The files inflate ${totalCompressed} bytes to ${totalBytes}`)
  checkNoOverlap(entries, zip.directoryOffset ?? Number.POSITIVE_INFINITY)
  // Reads each local header (zip.js strict) against its central record, and records its range.
  for (const entry of files.values())
    await entry.getData(new Uint8ArrayWriter(), { checkOverlappingEntryOnly: true })
  return files
}

/**
 * The name as the pack's own bytes spell it, normalised the way zip.js was told to, and checked
 * against every rule for a plain relative path. zip.js refuses an unsafe name from a Unicode Path
 * extra field itself; a safe one that differs from the raw name is refused here.
 */
function checkedName(entry: Entry): string {
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.rawFilename)
  } catch {
    throw new HostileArchive('unsafe_name', `${JSON.stringify(entry.filename)} is not UTF-8`)
  }
  const name = normalizeFilename(decoded)
  const path = entry.directory && name.endsWith('/') ? name.slice(0, -1) : name
  const unsafe = (why: string) => new HostileArchive('unsafe_name', `${JSON.stringify(name)} ${why}`)
  if (path === '') throw unsafe('is empty')
  if (path.startsWith('/') || DRIVE.test(path)) throw unsafe('is absolute')
  if (UNSAFE_CHARACTERS.test(path)) throw unsafe('holds a control or bidirectional character')
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) throw unsafe(`is longer than ${MAX_PATH_BYTES} bytes`)
  const parts = path.split('/')
  if (parts.length > MAX_DEPTH) throw unsafe(`is more than ${MAX_DEPTH} folders deep`)
  for (const part of parts) {
    if (part === '' || /^\.+$/.test(part)) throw unsafe('has an empty, "." or ".." part')
    if (Buffer.byteLength(part) > MAX_PART_BYTES)
      throw unsafe(`has a part longer than ${MAX_PART_BYTES} bytes`)
    // Windows drops trailing dots and spaces before it looks for a device name.
    if (RESERVED.test(part.replace(/[. ]+$/, ''))) throw unsafe('names a Windows device')
  }
  if (name !== entry.filename)
    throw new HostileArchive(
      'malformed',
      `${JSON.stringify(name)} is also named ${JSON.stringify(entry.filename)}`,
    )
  return path
}

/**
 * Old PowerShell `Compress-Archive` wrote backslashes, and macOS decomposes accents: both are the
 * same path a player meant, so they are normalised rather than refused.
 */
function normalizeFilename(name: string): string {
  return name.replaceAll('\\', '/').normalize('NFC')
}

/** What a case-insensitive disk, or a normalising one, would make of a name. */
const keyOf = (name: string) => name.normalize('NFC').toLowerCase()

/**
 * Each entry's local header and data, at the least, must end before the next entry starts, and
 * the last before the central directory: two records that share bytes (Fifield's overlapping
 * zip bombs) are refused before anything is read.
 */
function checkNoOverlap(entries: readonly Entry[], directoryOffset: number): void {
  const spans = entries
    .map((entry) => ({
      entry,
      end: entry.offset + LOCAL_HEADER_BYTES + entry.rawFilename.length + entry.compressedSize,
    }))
    .sort((a, b) => a.entry.offset - b.entry.offset)
  for (const [index, { entry, end }] of spans.entries()) {
    const next = spans[index + 1]?.entry.offset ?? directoryOffset
    if (end > next) throw new HostileArchive('malformed', `${entry.filename} overlaps the entry after it`)
  }
}

/** What went wrong, in Blockly's terms: the reasons zip.js gives, mapped; anything else as is. */
function archiveError(error: unknown, name?: string): unknown {
  if (error instanceof HostileArchive || error instanceof UnreadableFile || !(error instanceof Error))
    return error
  const about = name === undefined ? error.message : `${name}: ${error.message}`
  const { reason, filename } = error as Error & { reason?: string; filename?: string }
  switch (error.message) {
    case ERR_EOCDR_NOT_FOUND:
    case ERR_BAD_FORMAT:
    case ERR_SPLIT_ZIP_FILE:
      return new UnreadableFile(`Not a whole zip file: ${error.message}`)
    case ERR_UNSAFE_FILENAME:
      return new HostileArchive('unsafe_name', `${JSON.stringify(filename)} is not a plain relative path`)
    case ERR_AMBIGUOUS_ARCHIVE:
      return reason === WARNING_DUPLICATE_FILENAME
        ? new HostileArchive('duplicate', 'Two entries have the same name')
        : new HostileArchive('malformed', `Other readers could read this differently: ${reason}`)
    case ERR_ENCRYPTED:
    case ERR_ENCRYPTED_CENTRAL_DIRECTORY:
    case ERR_UNSUPPORTED_ENCRYPTION:
      return new HostileArchive('encrypted', about)
    // Raised past the declared size and short of it alike: the header lies about what inflates.
    case ERR_INVALID_UNCOMPRESSED_SIZE:
      return new HostileArchive('bomb', `${about} (not the size it declares)`)
    case ERR_CENTRAL_DIRECTORY_NOT_FOUND:
    case ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND:
    case ERR_LOCAL_FILE_HEADER_NOT_FOUND:
    case ERR_EXTRAFIELD_ZIP64_NOT_FOUND:
    case ERR_ENTRY_DATA_OUT_OF_BOUNDS:
    case ERR_OVERLAPPING_ENTRY:
    case ERR_UNSUPPORTED_COMPRESSION:
    case ERR_UNSUPPORTED_UINT64:
    case ERR_INVALID_CRC32:
    case ERR_INVALID_COMPRESSED_DATA:
    case ERR_CODEC_OUT_OF_MEMORY:
      return new HostileArchive('malformed', about)
  }
  if (error.name === 'AbortError' && error.cause instanceof HostileArchive) return error.cause
  return error
}

/** The size and sha512 of a file, read back from disk as a stream. */
async function digestOf(path: string): Promise<{ sizeBytes: number; sha512: string }> {
  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk)
    size += chunk.length
  }
  return { sizeBytes: size, sha512: hash.digest('hex') }
}

const MIB = 1024 * 1024
/** A single entry over 1 MiB that inflates 250 times its size is a bomb; real files stay far under. */
const ENTRY_BOMB_FLOOR = MIB
const ENTRY_BOMB_RATIO = 250
/** A whole pack past 64 MiB inflating 20 times its size is too: jars and worlds are already packed. */
const PACK_BOMB_FLOOR = 64 * MIB
const PACK_BOMB_RATIO = 20

const MAX_PATH_BYTES = 1024
const MAX_PART_BYTES = 255
const MAX_DEPTH = 32
const LOCAL_HEADER_BYTES = 30
const STORED = 0
const DEFLATED = 8
/** Encrypted, strongly encrypted, and a central directory with its local headers masked. */
const ENCRYPTION_FLAGS = 0x1 | 0x40 | 0x2000
const S_IFMT = 0o170000
/** None given, a regular file, a folder. */
const ENTRY_TYPES = new Set([0, 0o100000, 0o040000])
const DRIVE = /^[A-Za-z]:/
// Built from escapes on purpose: direction characters written as themselves would hide in the source.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters refused.
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i
