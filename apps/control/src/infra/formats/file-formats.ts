// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { PassThrough, Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { configure, HttpRangeReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'
import { parse as parseProperties } from 'dot-properties'
import { strFromU8, unzipSync } from 'fflate'
import nbt from 'prismarine-nbt'
import { parse as parseToml } from 'smol-toml'
import { Header, Pack, Parser, ReadEntry } from 'tar'
import { parse as parseYaml } from 'yaml'
import { type FileFormats, UnreadableFile } from '../../app/ports/formats.ts'

/**
 * Formats through maintained libraries (docs/dependency-audit.md): fflate for zips, zip.js for a
 * zip read by byte ranges, smol-toml, yaml, dot-properties for Java properties, prismarine-nbt for
 * level.dat, and node-tar to stream an archive without unpacking it, and to rewrite one as it
 * streams.
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
    try {
      const { parsed } = await nbt.parse(Buffer.from(bytes), 'big')
      return nbt.simplify(parsed)
    } catch (error) {
      throw new UnreadableFile(`Not an NBT file: ${messageOf(error)}`)
    }
  }

  async readTarball(
    url: string,
    options: {
      wanted(path: string): boolean
      enough(found: ReadonlyMap<string, Uint8Array>): boolean
      maxEntryBytes: number
    },
  ): Promise<Map<string, Uint8Array>> {
    const response = await fetch(url)
    if (!response.ok || response.body === null)
      throw new Error(`Fetching the archive answered ${response.status}`)
    const input = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
    const found = new Map<string, Uint8Array>()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        input.destroy()
        if (error) reject(error)
        else resolve(found)
      }
      // Strict: an archive that isn't one fails instead of warning its way to nothing.
      const parser = new Parser({
        strict: true,
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
      input.pipe(parser)
    })
  }

  readRemoteZip(
    url: string,
    options: { wanted(name: string): boolean; maxEntryBytes: number },
  ): Promise<{ names: string[]; entries: Map<string, Uint8Array> }> {
    return readRemote(url, options)
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
}

/** A remote zip's reader, answering by ranges or not at all. */
async function readRemote(
  url: string,
  options: { wanted(name: string): boolean; maxEntryBytes: number },
): Promise<{ names: string[]; entries: Map<string, Uint8Array> }> {
  const reader = new ZipReader(new HttpRangeReader(url))
  try {
    const all = await reader.getEntries()
    const entries = new Map<string, Uint8Array>()
    for (const entry of all) {
      if (entry.directory || !options.wanted(entry.filename)) continue
      if (entry.uncompressedSize > options.maxEntryBytes)
        throw new UnreadableFile(
          `${entry.filename} is ${entry.uncompressedSize} bytes, more than ${options.maxEntryBytes}`,
        )
      entries.set(entry.filename, await entry.getData(new Uint8ArrayWriter()))
    }
    return { names: all.map((entry) => entry.filename), entries }
  } catch (error) {
    if (error instanceof UnreadableFile) throw error
    throw new UnreadableFile(`Not a zip that can be read by ranges: ${messageOf(error)}`)
  } finally {
    await reader.close()
  }
}

/** Entry types that hold a file's bytes. */
const FILES = new Set(['File', 'OldFile', 'ContiguousFile'])

/** A jar's metadata files are a few kilobytes; a signed jar's manifest lists every class. */
const MAX_JAR_ENTRY_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_JAR_RECORDS = 20_000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
