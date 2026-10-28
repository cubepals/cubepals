// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { PassThrough, Readable, Transform } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'
import { createGunzip, gunzip, gzipSync } from 'node:zlib'
import { SECOND_MS } from '@blockly/contracts/durations'
import { configure } from '@zip.js/zip.js'
import { parse as parseProperties } from 'dot-properties'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { PNG } from 'pngjs'
import nbt from 'prismarine-nbt'
import { parse as parseToml } from 'smol-toml'
import { Header, Pack, Parser, ReadEntry } from 'tar'
import { parse as parseYaml } from 'yaml'
import { type FileFormats, ReadCutShort, UnreadableFile } from '../../app/ports/formats.ts'
import { readRemoteZip } from './remote-zip.ts'

/**
 * Formats through maintained libraries (docs/dependency-audit.md): fflate for zips, pngjs for
 * pictures, zip.js for a zip read by byte ranges (`remote-zip.ts`), smol-toml, yaml,
 * dot-properties for Java properties, prismarine-nbt for level.dat, and node-tar to stream an
 * archive without unpacking it, and to rewrite one as it streams.
 */

// zip.js inflates on the calling thread here: the entries read this way are a few kilobytes.
configure({ useWebWorkers: false })
export class LibraryFileFormats implements FileFormats {
  /**
   * fflate allocates the size a record declares for every entry the filter takes, and inflates
   * its whole stream even past that, so the filter holds each wanted entry to a small size, takes
   * it once, and stops at a record count no jar reaches.
   */
  unzip(bytes: Uint8Array, names: readonly string[]): Record<string, string> {
    const wanted = new Set(names)
    const taken = new Set<string>()
    let records = 0
    try {
      const entries = unzipSync(bytes, {
        filter: (file) => {
          if (++records > MAX_JAR_RECORDS)
            throw new UnreadableFile(`More than ${MAX_JAR_RECORDS} entries, more than a jar holds`)
          if (!wanted.has(file.name)) return false
          const limit = file.name === 'META-INF/MANIFEST.MF' ? MAX_MANIFEST_BYTES : MAX_JAR_ENTRY_BYTES
          if (file.originalSize > limit || file.size > MAX_JAR_ENTRY_BYTES)
            throw new UnreadableFile(`${file.name} is larger than a jar's ${file.name} can be`)
          if (taken.has(file.name)) throw new UnreadableFile(`${file.name} is in the jar twice`)
          taken.add(file.name)
          return true
        },
      })
      return Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, strFromU8(data)]))
    } catch (error) {
      if (error instanceof UnreadableFile) throw error
      throw new UnreadableFile(`Not a whole zip file: ${messageOf(error)}`)
    }
  }

  /**
   * The zip's directory is read once for every entry's name and size, then the entries wanted are
   * inflated a batch at a time from it, so a jar of many megabytes of classes is never held
   * inflated whole. The directory is what a JVM reads, so nothing a local header hides is missed.
   */
  eachZipEntry(
    bytes: Uint8Array,
    options: {
      wanted(name: string): boolean
      maxEntryBytes: number
      visit(name: string, data: Uint8Array): void
    },
  ): { skipped: string[] } {
    const sizes = new Map<string, number>()
    try {
      unzipSync(bytes, {
        filter: (file) => {
          if (sizes.size >= MAX_SCANNED_RECORDS)
            throw new UnreadableFile(`More than ${MAX_SCANNED_RECORDS} entries, more than a jar holds`)
          if (options.wanted(file.name)) sizes.set(file.name, file.originalSize)
          return false
        },
      })
      const skipped = [...sizes].filter(([, size]) => size > options.maxEntryBytes).map(([name]) => name)
      const batches: string[][] = [[]]
      let batchBytes = 0
      for (const [name, size] of sizes) {
        if (size > options.maxEntryBytes) continue
        if (batchBytes + size > BATCH_BYTES && (batches.at(-1)?.length ?? 0) > 0) {
          batches.push([])
          batchBytes = 0
        }
        batches.at(-1)?.push(name)
        batchBytes += size
      }
      for (const batch of batches) {
        if (batch.length === 0) continue
        const names = new Set(batch)
        const entries = unzipSync(bytes, { filter: (file) => names.has(file.name) })
        for (const [name, data] of Object.entries(entries)) options.visit(name, data)
      }
      return { skipped }
    } catch (error) {
      if (error instanceof UnreadableFile) throw error
      throw new UnreadableFile(`Not a whole zip file: ${messageOf(error)}`)
    }
  }

  decode(format: 'json' | 'toml' | 'yaml' | 'properties', text: string): unknown {
    try {
      switch (format) {
        case 'json':
          return JSON.parse(text)
        case 'toml':
          return parseToml(text)
        // Every scalar as a string: `api-version: 1.20` means "1.20", never the number 1.2.
        case 'yaml':
          return parseYaml(text, { schema: 'failsafe' })
        case 'properties':
          return parseProperties(text)
      }
    } catch (error) {
      throw new UnreadableFile(`Not valid ${format}: ${messageOf(error)}`)
    }
  }

  async decodeNbt(bytes: Uint8Array): Promise<unknown> {
    return nbt.simplify(await parsedNbt(bytes))
  }

  async nbtPart(bytes: Uint8Array, path: readonly string[]): Promise<Uint8Array | null> {
    const parsed = await parsedNbt(bytes)
    let tag: nbt.Tags[nbt.TagType] = parsed
    for (const key of path) {
      if (tag.type !== 'compound') return null
      const next: nbt.Tags[nbt.TagType] | undefined = tag.value[key]
      if (next === undefined) return null
      tag = next
    }
    if (tag.type !== 'compound') return null
    return new Uint8Array(gzipSync(nbt.writeUncompressed({ type: 'compound', name: '', value: tag.value })))
  }

  async readTarball(
    url: string,
    options: {
      wanted(path: string): boolean
      enough(found: ReadonlyMap<string, Uint8Array>): boolean
      maxEntryBytes: number
      maxKeptEntries: number
      maxKeptBytes: number
      maxInflatedBytes: number
      deadlineMs: number
    },
  ): Promise<Map<string, Uint8Array>> {
    const late = () => new ReadCutShort('time', `Not read within ${options.deadlineMs / SECOND_MS} s`)
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(late()), options.deadlineMs)
    let response: Response
    try {
      response = await fetch(url, { signal: stop.signal })
    } catch (error) {
      clearTimeout(timer)
      throw stop.signal.aborted ? late() : error
    }
    if (!response.ok || response.body === null) {
      clearTimeout(timer)
      throw new Error(`Fetching the archive answered ${response.status}`)
    }
    const input = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
    const found = new Map<string, Uint8Array>()
    return new Promise((resolve, reject) => {
      // Inflated here rather than by the parser, so every byte the archive inflates to is counted,
      // the ones no entry is read for and any after its end included. Each chunk inflated costs a
      // round through the stream, so they are large ones: zlib's default is many times slower.
      const gunzip = createGunzip({ chunkSize: INFLATED_CHUNK_BYTES })
      let inflated = 0
      let kept = 0
      let keptBytes = 0
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.destroy()
        gunzip.destroy()
        counted.destroy()
        if (error) reject(error)
        else resolve(found)
      }
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          inflated += chunk.length
          if (inflated <= options.maxInflatedBytes) return done(null, chunk)
          finish(new ReadCutShort('size', `More than ${options.maxInflatedBytes} bytes once inflated`))
          done()
        },
      })
      // Strict: an archive that isn't one fails instead of warning its way to nothing. What reaches
      // it is inflated already: a tarball compressed again inside would inflate uncounted, so any
      // further inflating is refused.
      const parser = new Parser({
        strict: true,
        maxDecompressionRatio: 1,
        onReadEntry: (entry: ReadEntry) => {
          const path = entry.path.replace(/^\.\//, '')
          if (!FILES.has(entry.type) || !options.wanted(path)) {
            entry.resume()
            return
          }
          if (entry.size > options.maxEntryBytes) {
            entry.resume()
            finish(new UnreadableFile(`${path} is ${entry.size} bytes, more than ${options.maxEntryBytes}`))
            return
          }
          // Counted as each entry starts, before any of it is held.
          kept += 1
          keptBytes += entry.size
          if (kept > options.maxKeptEntries || keptBytes > options.maxKeptBytes) {
            entry.resume()
            finish(
              new ReadCutShort(
                'kept',
                `More than ${options.maxKeptEntries} files or ${options.maxKeptBytes} bytes to keep`,
              ),
            )
            return
          }
          const chunks: Buffer[] = []
          entry.on('data', (chunk: Buffer) => chunks.push(chunk))
          entry.on('end', () => {
            found.set(path, Buffer.concat(chunks))
            if (options.enough(found)) finish()
          })
        },
      })
      parser.on('error', (error: unknown) =>
        finish(new UnreadableFile(`Not a gzipped tarball: ${messageOf(error)}`)),
      )
      parser.on('end', () => finish())
      input.on('error', (error) => finish(error))
      gunzip.on('error', (error) => finish(new UnreadableFile(`Not a gzipped tarball: ${messageOf(error)}`)))
      if (stop.signal.aborted) return finish(late())
      stop.signal.addEventListener('abort', () => finish(late()))
      input.pipe(gunzip).pipe(counted).pipe(parser)
    })
  }

  readRemoteZip(
    url: string,
    options: { wanted(name: string): boolean; maxEntryBytes: number },
  ): Promise<{ names: string[]; entries: Map<string, Uint8Array> }> {
    return readRemoteZip(url, options)
  }

  async filterTarball(
    url: string,
    options: { kept(path: string): boolean; added(): ReadonlyMap<string, string> },
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(url)
    if (!response.ok || response.body === null)
      throw new Error(`Fetching the archive answered ${response.status}`)
    const input = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
    const pack = new Pack({ gzip: true })
    // Added files are owned as the archive's own first entry is: whoever unpacks it as root
    // leaves them as the server's user would find the rest.
    let owner: { uid?: number; gid?: number } = {}
    const parser = new Parser({
      strict: true,
      onReadEntry: (entry: ReadEntry) => {
        if (owner.uid === undefined) owner = { uid: entry.uid, gid: entry.gid }
        // A kept entry goes in with its own header; the pack reads its bytes as the parser does.
        if (options.kept(entry.path.replace(/^\.\//, ''))) pack.add(entry)
        else entry.resume()
      },
    })
    parser.on('end', () => {
      for (const [path, text] of options.added()) {
        const body = Buffer.from(text)
        const entry = new ReadEntry(
          new Header({ path, type: 'File', mode: 0o644, size: body.length, mtime: new Date(), ...owner }),
        )
        pack.add(entry)
        entry.end(body)
      }
      pack.end()
    })
    const output = pack.pipe(new PassThrough())
    const fail = (error: unknown) =>
      output.destroy(new UnreadableFile(`Not a gzipped tarball: ${messageOf(error)}`))
    parser.on('error', fail)
    pack.on('error', fail)
    input.on('error', (error) => output.destroy(error))
    // Whoever stops reading stops the archive's download too.
    output.on('close', () => input.destroy())
    input.pipe(parser)
    return Readable.toWeb(output) as ReadableStream<Uint8Array>
  }

  png(picture: { width: number; height: number; rgba: Uint8Array }): Uint8Array {
    const png = new PNG({ width: picture.width, height: picture.height })
    png.data = Buffer.from(picture.rgba)
    return new Uint8Array(PNG.sync.write(png))
  }

  zipped(entries: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
    return zipSync(
      Object.fromEntries(entries.map(({ name, data }) => [name, [data, { mtime: ZIPPED_ON }]])),
      {
        level: 9,
      },
    )
  }
}

/**
 * The date every entry `zipped` writes carries. A zip keeps the time of day as the clock where it
 * is made reads it, so it is given as a local time, and reads the same wherever it is made.
 */
const ZIPPED_ON = new Date(1980, 0, 1)

/** Entry types that hold a file's bytes. */
const FILES = new Set(['File', 'OldFile', 'ContiguousFile'])

/** A jar's metadata files are a few kilobytes; a signed jar's manifest lists every class. */
const MAX_JAR_ENTRY_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_JAR_RECORDS = 20_000
/** Reading every class of a jar: more files than any jar holds, inflated this much at a time. */
const MAX_SCANNED_RECORDS = 150_000
const BATCH_BYTES = 64 * 1024 * 1024
const INFLATED_CHUNK_BYTES = 1024 * 1024

/** A level.dat or a player's file is kilobytes inflated, a heavily modded one a few megabytes. */
const MAX_NBT_BYTES = 64 * 1024 * 1024
/** gzip's magic bytes (RFC 1952): a file that starts with them is gzipped. */
const GZIP_MAGIC = [0x1f, 0x8b]
const gunzipped = promisify(gunzip)

/**
 * An NBT file as Minecraft writes it, gzipped or not, inflated here up to `MAX_NBT_BYTES` and
 * parsed as it is then: prismarine-nbt's own `parse` inflates with no limit.
 */
async function parsedNbt(bytes: Uint8Array): Promise<nbt.NBT> {
  try {
    let data = Buffer.from(bytes)
    if (GZIP_MAGIC.every((byte, at) => data[at] === byte))
      data = await gunzipped(data, { maxOutputLength: MAX_NBT_BYTES })
    return nbt.parseUncompressed(data, 'big')
  } catch (error) {
    throw new UnreadableFile(`Not an NBT file: ${messageOf(error)}`)
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
