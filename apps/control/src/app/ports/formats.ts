// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading what people upload: containers and text formats, decoded into plain data. It knows
 * nothing about Minecraft; `minecraft/` says what the data means (§15.2).
 */
export interface FileFormats {
  /**
   * The named entries of a zip (a jar), as text; names it doesn't hold are left out. Anything
   * that isn't a whole zip is an UnreadableFile.
   */
  unzip(bytes: Uint8Array, names: readonly string[]): Record<string, string>
  /** One text in a structured format, as plain data. Java properties come back as strings. */
  decode(format: 'json' | 'toml' | 'yaml' | 'properties', text: string): unknown
  /** A gzipped NBT file, such as a world's level.dat, as plain data. */
  decodeNbt(bytes: Uint8Array): Promise<unknown>
  /**
   * Reads a gzipped tarball from a URL and keeps the entries `wanted` picks, each up to
   * `maxEntryBytes`. It stops as soon as `enough` says it has what it needs, so a large
   * archive is only read as far as that. Paths are relative, without a leading `./`.
   */
  readTarball(
    url: string,
    options: {
      wanted(path: string): boolean
      enough(found: ReadonlyMap<string, Uint8Array>): boolean
      maxEntryBytes: number
    },
  ): Promise<Map<string, Uint8Array>>
  /**
   * A gzipped tarball at a URL as another, made while it is read and never held whole: the
   * entries `kept` keeps, each with its own header, then the files `added` returns once every
   * entry has been seen. It throws before the stream starts when the URL doesn't answer; an
   * archive that turns out not to be one errors the stream.
   */
  filterTarball(
    url: string,
    options: { kept(path: string): boolean; added(): ReadonlyMap<string, string> },
  ): Promise<ReadableStream<Uint8Array>>
  /**
   * The file names in a zip at a URL, and the entries `wanted` picks, each up to `maxEntryBytes`,
   * read by byte ranges: the zip's own directory and those entries, never the whole file. A 66 MB
   * modpack is read in a few small requests. A server that doesn't answer ranges is an
   * UnreadableFile, rather than a download of the whole thing.
   */
  readRemoteZip(
    url: string,
    options: { wanted(name: string): boolean; maxEntryBytes: number },
  ): Promise<{ names: string[]; entries: Map<string, Uint8Array> }>
}

/**
 * Reading and writing the archives people upload as packs, which are hostile input: every name,
 * type, size and count is checked before a byte is used (docs/modpack-system.md § Security).
 */
export interface PackArchives {
  /**
   * A zip on this machine, its central directory read and checked in full: every file's name is
   * a plain relative path (forward slashes, NFC, no `.`/`..`/empty part, no drive, no control
   * character, within the length limits), no two names match ignoring case, nothing is a link,
   * device or encrypted, only stored and deflated entries, no entries overlap, and the counts and
   * sizes are within `limits`. Folders are left out of `files`. Anything else is a HostileArchive
   * or, for a file that isn't a whole zip, an UnreadableFile.
   */
  open(path: string, limits: ArchiveLimits): Promise<PackArchive>
  /**
   * Downloads `url` to `path`, refusing more than `maxBytes`, and says what arrived. With `allowed`,
   * every address the download goes to, redirects included, is held to it before it is asked: a
   * DownloadRefused otherwise.
   */
  fetchTo(
    url: string,
    path: string,
    maxBytes: number,
    options?: { allowed?(url: string): boolean },
  ): Promise<{ sizeBytes: number; sha512: string }>
  /** Writes a new zip at `path` from `entries`, in order, and says what it wrote. */
  write(
    path: string,
    entries: AsyncIterable<{ name: string; data: Uint8Array | ReadableStream<Uint8Array> }>,
  ): Promise<{ sizeBytes: number; sha512: string }>
}

export interface ArchiveLimits {
  maxFiles: number
  /** The sum of every file's size once inflated. */
  maxTotalBytes: number
  maxFileBytes: number
}

export interface PackArchive {
  /** Every file, by its checked name, with its size once inflated. */
  readonly files: ReadonlyArray<{ name: string; sizeBytes: number }>
  /** One file's bytes, refused as HostileArchive past `maxBytes` or past its declared size. */
  read(name: string, maxBytes: number): Promise<Uint8Array>
  /** One file's bytes as they inflate, held to its declared size. */
  stream(name: string): ReadableStream<Uint8Array>
  close(): Promise<void>
}

/** Why an archive is refused before anything in it is used. */
export type HostileReason =
  | 'unsafe_name'
  | 'link'
  | 'encrypted'
  | 'duplicate'
  | 'too_many_files'
  | 'too_large'
  | 'bomb'
  | 'malformed'

/** An archive built to escape its folder, exhaust the machine or confuse a reader. */
export class HostileArchive extends Error {
  readonly reason: HostileReason
  constructor(reason: HostileReason, detail: string) {
    super(detail)
    this.name = 'HostileArchive'
    this.reason = reason
  }
}

/**
 * A download sent somewhere it isn't allowed to go: a host outside the ones it is held to, or a
 * redirect that leads away from them or goes round in circles.
 */
export class DownloadRefused extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'DownloadRefused'
  }
}

/** Not the format it should be: a cut-off zip, a tarball that isn't one, malformed text. */
export class UnreadableFile extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'UnreadableFile'
  }
}
