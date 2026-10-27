// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The archives people upload, packs and worlds: a pack, or a world in a zip, is opened as
 * `pack-archives.ts` opens one, through zip.js in its strictest reading; a world in a tarball,
 * gzipped or not, through node-tar, its every header held to the same rules. The tarball a world
 * becomes is written with node-tar too. Not where a world's files are told apart, which is
 * `minecraft/world-layout.ts`.
 */
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { PassThrough, Readable, Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { Header, Pack, Parser, ReadEntry } from 'tar'
import {
  type ArchiveLimits,
  HostileArchive,
  type PackArchive,
  type TarballEntry,
  UnreadableFile,
  type WorldArchive,
  type WorldArchiveKept,
  type WorldArchives,
} from '../../app/ports/formats.ts'
import { checkedPath, keyOf, LibraryPackArchives, normalizeFilename } from './pack-archives.ts'

/** The user the server image runs as (`itzg/minecraft-server`'s `minecraft`), who owns a volume's files. */
const SERVER_USER = { uid: 1000, gid: 1000 }
/** Region files are compressed already: a light gzip costs little and gains as much as a heavy one. */
const GZIP_LEVEL = 1
/** Read a little at a time, so a header is checked before much of what it promises is inflated. */
const READ_CHUNK_BYTES = 16 * 1024
/** A tarball inflating past this many times its size, beyond a floor, is a bomb, as a pack is. */
const BOMB_FLOOR = 64 * 1024 * 1024
const BOMB_RATIO = 20
/** The kinds of tar entry a world is made of; anything else (links, devices, pipes) is refused. */
const FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile'])

/** What the file at `path` is, from its first bytes: a zip, a gzipped tarball, or a plain one. */
async function formatOf(path: string): Promise<'zip' | 'gzip' | 'tar'> {
  const file = await open(path, 'r')
  try {
    const head = Buffer.alloc(4)
    await file.read(head, 0, 4, 0)
    if (head.readUInt32LE(0) === 0x04034b50) return 'zip'
    return head[0] === 0x1f && head[1] === 0x8b ? 'gzip' : 'tar'
  } finally {
    await file.close()
  }
}

/** Packs as `LibraryPackArchives` opens them, and worlds in either kind of archive. */
export class LibraryUploadArchives extends LibraryPackArchives implements WorldArchives {
  async openWorld(path: string, limits: ArchiveLimits & WorldArchiveKept): Promise<WorldArchive> {
    const format = await formatOf(path)
    if (format === 'zip') return zipWorld(await this.open(path, limits), limits)
    return tarWorld(path, format === 'gzip', limits)
  }

  tarball(entries: AsyncIterable<TarballEntry>): ReadableStream<Uint8Array> {
    return tarballOf(entries)
  }
}

async function zipWorld(zip: PackArchive, limits: WorldArchiveKept): Promise<WorldArchive> {
  const kept = new Map<string, Uint8Array>()
  let keptBytes = 0
  try {
    for (const file of zip.files) {
      if (!limits.keep(file.name)) continue
      keptBytes += file.sizeBytes
      if (keptBytes > limits.maxKeptBytes)
        throw new HostileArchive('too_large', `The files kept come to more than ${limits.maxKeptBytes} bytes`)
      kept.set(file.name, await zip.read(file.name, file.sizeBytes))
    }
  } catch (error) {
    await zip.close()
    throw error
  }
  return {
    files: zip.files,
    kept,
    async *entries() {
      for (const file of zip.files) yield { ...file, data: zip.stream(file.name) }
    },
    close: () => zip.close(),
  }
}

/** One tar entry's checked name, or null for the archive's own root (`./`). */
function tarName(entry: ReadEntry): string | null {
  const name = normalizeFilename(entry.path)
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
  if (name === '' || name === '.') return null
  return checkedPath(name)
}

/**
 * Reads a tarball through once. Each file entry's header goes to `check` as it arrives, before
 * node-tar inflates what it promises, with how much of the file has been read so far; then its
 * bytes go to `visit`, which reads or resumes them, one entry after another. Entries the archive
 * marks as folders are passed over; anything else not a file is refused.
 */
async function eachTarEntry(
  path: string,
  gzipped: boolean,
  check: (name: string, entry: ReadEntry) => void,
  visit: (name: string, entry: ReadEntry) => Promise<void> | void,
): Promise<void> {
  const parser = new Parser({ strict: true })
  const file = createReadStream(path, { highWaterMark: READ_CHUNK_BYTES })
  let compressed = 0
  let inflated = 0
  let failure: unknown = null
  let pending: Promise<void> = Promise.resolve()
  let stop: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    stop = resolve
  })
  const fail = (error: unknown) => {
    if (failure === null) failure = error
    file.destroy()
    stop()
  }
  parser.on('entry', (entry: ReadEntry) => {
    let name: string | null
    try {
      name = tarName(entry)
      if (failure !== null || entry.type === 'Directory' || name === null) return void entry.resume()
      if (!FILE_TYPES.has(entry.type))
        throw new HostileArchive('link', `${name} is a ${entry.type}, not a file`)
      check(name, entry)
    } catch (error) {
      entry.resume()
      return fail(error)
    }
    const checked = name
    pending = pending.then(async () => {
      if (failure !== null) return void entry.resume()
      try {
        await visit(checked, entry)
      } catch (error) {
        entry.resume()
        fail(error)
      }
    })
  })
  const done = new Promise<void>((resolve, reject) => {
    parser.on('end', () => resolve())
    parser.on('error', (error: unknown) => reject(new UnreadableFile(`Not a tarball: ${String(error)}`)))
    file.on('error', (error) => reject(error))
  })
  file.on('data', (chunk) => {
    compressed += chunk.length
  })
  // Inflated here rather than by node-tar, so a bomb is measured against the floor a pack's is.
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, next) {
      inflated += chunk.length
      if (inflated > BOMB_FLOOR && inflated > BOMB_RATIO * compressed)
        return next(new HostileArchive('bomb', `${compressed} bytes inflate to more than ${inflated}`))
      next(null, chunk)
    },
  })
  meter.on('error', fail)
  if (gzipped) {
    const gunzip = createGunzip()
    gunzip.on('error', (error) => fail(new UnreadableFile(`Not a gzipped tarball: ${String(error)}`)))
    file.pipe(gunzip).pipe(meter).pipe(parser)
  } else file.pipe(meter).pipe(parser)
  await Promise.race([done.catch((error: unknown) => fail(error)), stopped])
  await pending
  if (failure !== null) throw failure
}

/** Every byte of a tar entry, which is at most `most` long (its header says so). */
async function bytesOf(entry: ReadEntry, most: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of entry as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > most) throw new HostileArchive('bomb', `${entry.path} is longer than its header says`)
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

async function tarWorld(
  path: string,
  gzipped: boolean,
  limits: ArchiveLimits & WorldArchiveKept,
): Promise<WorldArchive> {
  const files: Array<{ name: string; sizeBytes: number }> = []
  const kinds = new Map<string, 'file'>()
  const kept = new Map<string, Uint8Array>()
  let totalBytes = 0
  let keptBytes = 0
  await eachTarEntry(
    path,
    gzipped,
    (name, entry) => {
      const key = keyOf(name)
      if (kinds.has(key))
        throw new HostileArchive('duplicate', `${name} is in the archive twice, ignoring case`)
      kinds.set(key, 'file')
      if (files.length + 1 > limits.maxFiles)
        throw new HostileArchive('too_many_files', `More than ${limits.maxFiles} files`)
      if (entry.size > limits.maxFileBytes)
        throw new HostileArchive(
          'too_large',
          `${name} is ${entry.size} bytes, more than ${limits.maxFileBytes}`,
        )
      totalBytes += entry.size
      if (totalBytes > limits.maxTotalBytes)
        throw new HostileArchive('too_large', `The files come to more than ${limits.maxTotalBytes} bytes`)
      files.push({ name, sizeBytes: entry.size })
      if (!limits.keep(name)) return
      keptBytes += entry.size
      if (keptBytes > limits.maxKeptBytes)
        throw new HostileArchive('too_large', `The files kept come to more than ${limits.maxKeptBytes} bytes`)
    },
    async (name, entry) => {
      if (!limits.keep(name)) return void entry.resume()
      kept.set(name, await bytesOf(entry, entry.size))
    },
  )
  for (const { name } of files)
    for (let slash = name.indexOf('/'); slash !== -1; slash = name.indexOf('/', slash + 1))
      if (kinds.has(keyOf(name.slice(0, slash))))
        throw new HostileArchive('duplicate', `${name} is under ${name.slice(0, slash)}, which is a file`)
  return {
    files,
    kept,
    entries: () => tarEntries(path, gzipped),
    close: async () => {},
  }
}

/** A tar entry's bytes as a stream; cancelling it lets the rest of the entry flow past. */
function streamOf(entry: ReadEntry): ReadableStream<Uint8Array> {
  const chunks = (entry as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next()
      if (next.done) controller.close()
      else controller.enqueue(new Uint8Array(next.value))
    },
    cancel() {
      entry.resume()
    },
  })
}

/**
 * The tarball's files again, in order, as `WorldArchive.entries` hands them out: the next entry
 * is read once the last one's bytes have been.
 */
async function* tarEntries(
  path: string,
  gzipped: boolean,
): AsyncIterable<{ name: string; sizeBytes: number; data: ReadableStream<Uint8Array> }> {
  const queue: Array<{
    name: string
    sizeBytes: number
    data: ReadableStream<Uint8Array>
    read: Promise<void>
  }> = []
  let wake: (() => void) | null = null
  let ended = false
  let failure: unknown = null
  const reading = eachTarEntry(
    path,
    gzipped,
    () => {},
    (name, entry) => {
      const read = new Promise<void>((resolve) => entry.on('end', () => resolve()))
      queue.push({ name, sizeBytes: entry.size, data: streamOf(entry), read })
      wake?.()
      return read
    },
  ).then(
    () => {
      ended = true
      wake?.()
    },
    (error: unknown) => {
      failure = error
      ended = true
      wake?.()
    },
  )
  try {
    while (true) {
      const next = queue.shift()
      if (next !== undefined) {
        const { read: _, ...file } = next
        yield file
        continue
      }
      if (failure !== null) throw failure
      if (ended) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      wake = null
    }
  } finally {
    await reading
  }
}

/** A gzipped tarball of `entries`, as `WorldArchives.tarball` writes one. */
function tarballOf(entries: AsyncIterable<TarballEntry>): ReadableStream<Uint8Array> {
  const pack = new Pack({ gzip: { level: GZIP_LEVEL } })
  const output = pack.pipe(new PassThrough())
  const folders = new Set<string>()
  const write = async () => {
    for await (const file of entries) {
      for (const folder of foldersOf(file.name)) {
        if (folders.has(folder)) continue
        folders.add(folder)
        added(pack, `${folder}/`, 'Directory', 0).end()
      }
      await fill(added(pack, file.name, 'File', file.sizeBytes), file)
    }
    pack.end()
  }
  write().catch((error: unknown) => output.destroy(error instanceof Error ? error : new Error(String(error))))
  return Readable.toWeb(output) as ReadableStream<Uint8Array>
}

/** Every folder a path is in, outermost first: `a`, `a/b` for `a/b/c`. */
function foldersOf(path: string): string[] {
  const folders: string[] = []
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1))
    folders.push(path.slice(0, slash))
  return folders
}

/** An entry added to the pack, owned by the server's user; node-tar's Pack takes one as a ReadEntry. */
function added(pack: Pack, path: string, type: 'File' | 'Directory', size: number): ReadEntry {
  const mode = type === 'File' ? 0o644 : 0o755
  const entry = new ReadEntry(new Header({ path, type, size, mode, mtime: new Date(), ...SERVER_USER }))
  pack.add(entry)
  return entry
}

/** A file's bytes written into its entry as they come, which must be the size it said. */
async function fill(entry: ReadEntry, file: TarballEntry): Promise<void> {
  let written = 0
  const chunks = file.data instanceof Uint8Array ? [file.data] : (file.data as AsyncIterable<Uint8Array>)
  for await (const chunk of chunks) {
    written += chunk.byteLength
    if (written > file.sizeBytes)
      throw new Error(`${file.name} is longer than the ${file.sizeBytes} bytes it said`)
    if (!entry.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
      await once(entry, 'drain')
  }
  if (written !== file.sizeBytes)
    throw new Error(`${file.name} is ${written} bytes, not the ${file.sizeBytes} it said`)
  entry.end()
}
