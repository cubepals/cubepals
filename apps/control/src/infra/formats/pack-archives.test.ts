// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import {
  type ArchiveLimits,
  DownloadRefused,
  HostileArchive,
  UnreadableFile,
} from '../../app/ports/formats.ts'
import { LibraryPackArchives } from './pack-archives.ts'

const archives = new LibraryPackArchives()
const MIB = 1024 * 1024
const LIMITS: ArchiveLimits = { maxFiles: 100, maxTotalBytes: 64 * MIB, maxFileBytes: 32 * MIB }
const ROOMY: ArchiveLimits = { maxFiles: 1000, maxTotalBytes: 4096 * MIB, maxFileBytes: 1024 * MIB }
const sha512 = (bytes: Uint8Array) => createHash('sha512').update(bytes).digest('hex')

/** One record as a hostile writer would lay it out; everything left out is a plain stored file. */
interface Raw {
  name: string | Uint8Array
  /** The bytes as stored, already deflated for method 8. */
  data?: Uint8Array
  /** What `data` inflates to, for the default checksum and size. */
  plain?: Uint8Array
  method?: number
  crc?: number
  /** The uncompressed size both headers declare. */
  size?: number
  flags?: number
  madeBy?: number
  attributes?: number
  extra?: Uint8Array
  /** A different name in the local header than in the central directory. */
  localName?: string
  /** No local header of its own: the central record points into an earlier entry's. */
  at?: { entry: number; plus?: number }
}

const bytesOf = (value: string | Uint8Array) =>
  typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
const stored = (
  name: string | Uint8Array,
  text: string | Uint8Array = 'x',
  more: Partial<Raw> = {},
): Raw => ({
  name,
  data: bytesOf(text),
  ...more,
})
const deflated = (name: string, plain: Uint8Array, more: Partial<Raw> = {}): Raw => ({
  name,
  data: deflateRawSync(plain),
  plain,
  method: 8,
  ...more,
})
const folder = (name: string): Raw => ({ name, attributes: 0o040755 * 0x10000 + 0x10 })
const unixMode = (mode: number) => mode * 0x10000

/** A zip written byte by byte, for the shapes no zip library will produce. */
function rawZip(entries: Raw[], options: { zip64Mismatch?: boolean } = {}): Uint8Array {
  const parts: Buffer[] = []
  const centrals: Buffer[] = []
  const offsets: number[] = []
  let offset = 0
  for (const entry of entries) {
    const name = bytesOf(entry.name)
    const data = entry.data ?? new Uint8Array()
    const plain = entry.plain ?? data
    const extra = Buffer.from(entry.extra ?? [])
    const crc = entry.crc ?? crc32(plain)
    const size = entry.size ?? plain.length
    const at = entry.at === undefined ? offset : (offsets[entry.at.entry] ?? 0) + (entry.at.plus ?? 0)
    offsets.push(at)
    if (entry.at === undefined) {
      const localName = entry.localName === undefined ? name : bytesOf(entry.localName)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(entry.flags ?? 0, 6)
      local.writeUInt16LE(entry.method ?? 0, 8)
      local.writeUInt16LE(0x21, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(size, 22)
      local.writeUInt16LE(localName.length, 26)
      local.writeUInt16LE(extra.length, 28)
      const record = Buffer.concat([local, localName, extra, data])
      parts.push(record)
      offset += record.length
    }
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.madeBy ?? 0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags ?? 0, 8)
    central.writeUInt16LE(entry.method ?? 0, 10)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt32LE(entry.attributes ?? unixMode(0o100644), 38)
    central.writeUInt32LE(at, 42)
    centrals.push(Buffer.concat([central, name, extra]))
  }
  const directory = Buffer.concat(centrals)
  const count = entries.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(options.zip64Mismatch ? 0xffff : count, 8)
  end.writeUInt16LE(options.zip64Mismatch ? 0xffff : count, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  if (!options.zip64Mismatch) return Buffer.concat([...parts, directory, end])
  // A Zip64 end record that disagrees with the classic one about the directory's size.
  const zip64 = Buffer.alloc(56)
  zip64.writeUInt32LE(0x06064b50, 0)
  zip64.writeBigUInt64LE(44n, 4)
  zip64.writeUInt16LE(45, 12)
  zip64.writeUInt16LE(45, 14)
  zip64.writeBigUInt64LE(BigInt(count), 24)
  zip64.writeBigUInt64LE(BigInt(count), 32)
  zip64.writeBigUInt64LE(BigInt(directory.length + 1), 40)
  zip64.writeBigUInt64LE(BigInt(offset), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8)
  locator.writeUInt32LE(1, 16)
  return Buffer.concat([...parts, directory, zip64, locator, end])
}

/** A Unicode Path extra field (0x7075) naming the entry differently from its raw name. */
function unicodePath(rawName: string, name: string): Uint8Array {
  const path = Buffer.from(name)
  const field = Buffer.alloc(9)
  field.writeUInt16LE(0x7075, 0)
  field.writeUInt16LE(5 + path.length, 2)
  field.writeUInt8(1, 4)
  field.writeUInt32LE(crc32(Buffer.from(rawName)), 5)
  return Buffer.concat([field, path])
}

/** `megabytes` MiB of zeros deflated as a stream, never held inflated. */
async function deflatedZeros(megabytes: number): Promise<Buffer> {
  const deflate = createDeflateRaw({ level: 9 })
  const chunks: Buffer[] = []
  deflate.on('data', (chunk: Buffer) => chunks.push(chunk))
  const zero = Buffer.alloc(MIB)
  for (let i = 0; i < megabytes; i++) deflate.write(zero)
  await new Promise((resolve) => deflate.end(resolve))
  return Buffer.concat(chunks)
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<{ bytes: number; hash: string }> {
  const hash = createHash('sha512')
  let bytes = 0
  const reader = stream.getReader()
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    hash.update(next.value)
    bytes += next.value.byteLength
  }
  return { bytes, hash: hash.digest('hex') }
}

const randomBytesOnce = new Uint8Array(randomBytes(4096))

describe('pack archives', () => {
  let dir: string
  let files = 0
  const put = async (bytes: Uint8Array) => {
    const path = join(dir, `pack-${++files}.zip`)
    await writeFile(path, bytes)
    return path
  }
  /** Why `bytes` is refused: a HostileArchive's reason, or the error itself. */
  const refusal = async (bytes: Uint8Array, limits = LIMITS): Promise<unknown> => {
    const path = await put(bytes)
    try {
      const archive = await archives.open(path, limits)
      await archive.close()
      return 'opened'
    } catch (error) {
      return error instanceof HostileArchive ? error.reason : error
    }
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blockly-packs-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('a pack opens with its folders left out, a zip inside kept as a file, and backslashes made slashes', async () => {
    const inner = rawZip([stored('pack.mcmeta', '{"pack":{}}')])
    const config = Buffer.from('{"quality":"fast"}'.repeat(200))
    const accent = 'config/café.toml'.normalize('NFD')
    const path = await put(
      rawZip([
        folder('overrides/'),
        folder('overrides/mods/'),
        stored('modrinth.index.json', '{"formatVersion":1}'),
        stored('overrides/mods/sodium.jar', randomBytes(4000)),
        stored('overrides/resourcepacks/faithful.zip', inner),
        // Old PowerShell Compress-Archive: backslashes, written on Windows.
        deflated('overrides\\config\\sodium.json', config, { madeBy: 0x0014, attributes: 0x20 }),
        stored(`overrides/${accent}`, 'a = 1'),
      ]),
    )
    const archive = await archives.open(path, LIMITS)
    expect(archive.files).toEqual([
      { name: 'modrinth.index.json', sizeBytes: 19 },
      { name: 'overrides/mods/sodium.jar', sizeBytes: 4000 },
      { name: 'overrides/resourcepacks/faithful.zip', sizeBytes: inner.length },
      { name: 'overrides/config/sodium.json', sizeBytes: config.length },
      { name: 'overrides/config/café.toml'.normalize('NFC'), sizeBytes: 5 },
    ])
    expect(Buffer.from(await archive.read('overrides/config/sodium.json', MIB))).toEqual(config)
    expect(Buffer.from(await archive.read('overrides/resourcepacks/faithful.zip', MIB))).toEqual(
      Buffer.from(inner),
    )
    await archive.close()
  })

  test('names that leave the folder, or that a disk would read differently, are refused', async () => {
    const names: Array<string | Uint8Array> = [
      '../evil.txt',
      '..\\evil.txt',
      'mods/../../evil.txt',
      '/etc/passwd',
      '\\\\server\\share\\evil.txt',
      'C:/Windows/evil.txt',
      'c:\\evil.txt',
      'mods//evil.jar',
      './evil.txt',
      'mods/./evil.jar',
      'mods/.../evil.jar',
      '',
      'evil\u0000.txt',
      'evil\u001b[31m.txt',
      'evil\u007f.txt',
      'evil\u202egnp.exe',
      'evil\u2066.txt',
      `${'a'.repeat(256)}.txt`,
      Array.from({ length: 5 }, () => 'b'.repeat(250)).join('/'),
      Array.from({ length: 33 }, () => 'd').join('/'),
      'CON',
      'mods/aux.txt',
      'config/LPT1.json',
      'con.',
      'COM¹.txt',
      new Uint8Array([0x6d, 0x6f, 0x64, 0xff, 0x2e, 0x6a, 0x61, 0x72]),
    ]
    const reasons = await Promise.all(names.map((name) => refusal(rawZip([stored(name)]))))
    expect(reasons).toEqual(names.map(() => 'unsafe_name'))
    // Folder entries are held to the same rules.
    expect(await refusal(rawZip([folder('../evil/')]))).toBe('unsafe_name')
  })

  test('a name swapped in by a Unicode Path extra field is refused, as unsafe or as readers disagree', async () => {
    expect(await refusal(rawZip([stored('n', 'x', { extra: unicodePath('n', '../a') })]))).toBe('unsafe_name')
    expect(await refusal(rawZip([stored('n', 'x', { extra: unicodePath('n', 'a') })]))).toBe('malformed')
  })

  test('links, devices, pipes and sockets are refused, under a Unix host or a 7-Zip one', async () => {
    const shapes = [
      { madeBy: 0x031e, attributes: unixMode(0o120777) },
      { madeBy: 0x0014, attributes: unixMode(0o120777) + 0x8020 },
      { madeBy: 0x031e, attributes: unixMode(0o010644) },
      { madeBy: 0x031e, attributes: unixMode(0o020644) },
      { madeBy: 0x031e, attributes: unixMode(0o060644) },
      { madeBy: 0x031e, attributes: unixMode(0o140755) },
    ]
    const reasons = await Promise.all(shapes.map((shape) => refusal(rawZip([stored('link', '/etc', shape)]))))
    expect(reasons).toEqual(shapes.map(() => 'link'))
  })

  test('encrypted entries are refused, whether ZipCrypto, strong or AES', async () => {
    const aes = new Uint8ArrayWriter()
    const writer = new ZipWriter(aes, { password: 'hunter2', useWebWorkers: false })
    await writer.add('secret.txt', new Uint8ArrayReader(Buffer.from('secret')))
    await writer.close()
    expect(await refusal(rawZip([stored('secret.txt', 'x', { flags: 0x1 })]))).toBe('encrypted')
    expect(await refusal(rawZip([stored('secret.txt', 'x', { flags: 0x41 })]))).toBe('encrypted')
    expect(await refusal(await aes.getData())).toBe('encrypted')
  })

  test('only stored and deflated entries are read', async () => {
    expect(await refusal(rawZip([stored('a.txt', 'x', { method: 12 })]))).toBe('malformed')
    expect(await refusal(rawZip([stored('a.txt', 'x', { method: 9 })]))).toBe('malformed')
    // A stored entry whose sizes differ declares bytes it doesn't hold.
    expect(await refusal(rawZip([stored('a.txt', 'x', { size: 5000 })]))).toBe('malformed')
  })

  test('two names a disk would treat as one are refused', async () => {
    const pairs: Raw[][] = [
      [stored('mods/a.jar'), stored('mods/a.jar')],
      [stored('mods/A.jar'), stored('mods/a.jar')],
      [stored('config/café.toml'.normalize('NFC')), stored('config/café.toml'.normalize('NFD'))],
      [stored('config/x.toml'), stored('config\\x.toml')],
      [folder('Mods/'), stored('mods')],
      [stored('config'), stored('config/x.toml')],
    ]
    const reasons = await Promise.all(pairs.map((pair) => refusal(rawZip(pair))))
    expect(reasons).toEqual(pairs.map(() => 'duplicate'))
  })

  test('too many files, or too many entries of any kind, are refused before the rest is read', async () => {
    const limits = { ...LIMITS, maxFiles: 3 }
    expect(await refusal(rawZip(['a', 'b', 'c', 'd'].map((name) => stored(name))), limits)).toBe(
      'too_many_files',
    )
    expect(await refusal(rawZip(['a/', 'b/', 'c/', 'd/', 'e/', 'f/', 'g/'].map(folder)), limits)).toBe(
      'too_many_files',
    )
    const many = rawZip(Array.from({ length: 20_000 }, (_, i) => folder(`f${i}/`)))
    const started = performance.now()
    expect(await refusal(many, limits)).toBe('too_many_files')
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('a file past the size allowed, or files that come to more than the total, are refused', async () => {
    const limits = { ...LIMITS, maxFileBytes: 100, maxTotalBytes: 150 }
    expect(await refusal(rawZip([stored('big.bin', Buffer.alloc(101))]), limits)).toBe('too_large')
    expect(
      await refusal(rawZip([stored('a.bin', Buffer.alloc(100)), stored('b.bin', Buffer.alloc(100))]), limits),
    ).toBe('too_large')
  })

  test('an entry, or a whole pack, that inflates far past its size is a bomb', async () => {
    const zeros = await deflatedZeros(200)
    const one = rawZip([{ name: 'zeros.bin', data: zeros, method: 8, crc: 0, size: 200 * MIB }])
    expect(await refusal(one, ROOMY)).toBe('bomb')
    // Each under 1 MiB, so none is a bomb alone; 80 MiB from 80 kB together is.
    const mebibyte = await deflatedZeros(1)
    const many = rawZip(
      Array.from({ length: 80 }, (_, i) => ({
        name: `z${i}.bin`,
        data: mebibyte,
        method: 8,
        crc: 0,
        size: MIB,
      })),
    )
    expect(await refusal(many, ROOMY)).toBe('bomb')
  })

  test('an entry that inflates past its declared size stops there, quickly', async () => {
    const plain = Buffer.alloc(16 * MIB)
    const path = await put(rawZip([deflated('liar.json', plain, { size: 1000 })]))
    const archive = await archives.open(path, LIMITS)
    const started = performance.now()
    const read = await archive.read('liar.json', MIB).catch((error: unknown) => error)
    expect(read).toBeInstanceOf(HostileArchive)
    expect((read as HostileArchive).reason).toBe('bomb')
    let received = 0
    const reader = archive.stream('liar.json').getReader()
    const streamed = await (async () => {
      for (let next = await reader.read(); !next.done; next = await reader.read())
        received += next.value.byteLength
    })().catch((error: unknown) => error)
    expect((streamed as HostileArchive).reason).toBe('bomb')
    expect(received).toBeLessThanOrEqual(1000)
    expect(performance.now() - started).toBeLessThan(100)
    // Short of the declared size isn't a bomb, but it isn't a whole entry either.
    const short = await put(rawZip([deflated('short.json', Buffer.alloc(1000), { size: 5000 })]))
    const shortArchive = await archives.open(short, LIMITS)
    expect(await shortArchive.read('short.json', MIB).catch((error: HostileArchive) => error.reason)).toBe(
      'malformed',
    )
    await Promise.all([archive.close(), shortArchive.close()])
  })

  test('entries that share bytes are refused before any is read', async () => {
    const payload = Buffer.alloc(1000, 7)
    // Two central records for one local file, and one pointing into another's data.
    const shared = rawZip([stored('a.bin', payload), stored('b.bin', payload, { at: { entry: 0 } })])
    const inside = rawZip([stored('a.bin', payload), stored('b.bin', 'x', { at: { entry: 0, plus: 40 } })])
    expect(await refusal(shared)).toBe('malformed')
    expect(await refusal(inside)).toBe('malformed')
  })

  test('a local header that disagrees with its central record, or zip64 records that disagree, are refused', async () => {
    expect(await refusal(rawZip([stored('a.txt', 'x', { localName: 'b.txt' })]))).toBe('malformed')
    expect(await refusal(rawZip([stored('a.txt')], { zip64Mismatch: true }))).toBe('malformed')
  })

  test('a cut-off zip, an empty file, or something that is not a zip, is unreadable', async () => {
    const whole = rawZip([stored('a.txt', 'hello'), stored('b.txt', randomBytes(5000))])
    for (const bytes of [
      whole.subarray(0, whole.length - 30),
      new Uint8Array(),
      Buffer.from('not a zip'.repeat(20)),
    ])
      expect(await refusal(bytes)).toBeInstanceOf(UnreadableFile)
  })

  test('a read is held to its limit, an unknown name is an error, and a stream gives the bytes as they inflate', async () => {
    const big = randomBytes(3 * MIB)
    const path = await put(rawZip([deflated('world/region/r.0.0.mca', big), stored('small.txt', 'hi')]))
    const archive = await archives.open(path, LIMITS)
    const over = await archive.read('world/region/r.0.0.mca', MIB).catch((error: unknown) => error)
    expect(over).toBeInstanceOf(HostileArchive)
    expect((over as HostileArchive).reason).toBe('too_large')
    const unknown = await archive.read('nope.txt', MIB).catch((error: unknown) => error)
    expect(unknown).toBeInstanceOf(Error)
    expect(unknown).not.toBeInstanceOf(HostileArchive)
    expect(await drain(archive.stream('world/region/r.0.0.mca'))).toEqual({
      bytes: big.length,
      hash: sha512(big),
    })
    await archive.close()
    // Closed, it reads nothing.
    expect(await archive.read('small.txt', 10).catch(() => 'closed')).toBe('closed')
  })

  test('a written zip holds the entries in order, and opens again to the same bytes', async () => {
    const index = Buffer.from('{"formatVersion":1,"files":[]}')
    const jar = randomBytes(2 * MIB)
    const config = Buffer.from('difficulty = "hard"\n'.repeat(1000))
    async function* entries() {
      yield { name: 'modrinth.index.json', data: new Uint8Array(index) }
      yield {
        name: 'overrides/mods/big.jar',
        data: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(jar.subarray(0, MIB))
            controller.enqueue(jar.subarray(MIB))
            controller.close()
          },
        }),
      }
      yield { name: 'overrides/config/game.toml', data: new Uint8Array(config) }
    }
    const path = join(dir, 'written.zip')
    const written = await archives.write(path, entries())
    const onDisk = await readFile(path)
    expect(written).toEqual({ sizeBytes: (await stat(path)).size, sha512: sha512(onDisk) })

    const archive = await archives.open(path, LIMITS)
    expect(archive.files).toEqual([
      { name: 'modrinth.index.json', sizeBytes: index.length },
      { name: 'overrides/mods/big.jar', sizeBytes: jar.length },
      { name: 'overrides/config/game.toml', sizeBytes: config.length },
    ])
    expect(Buffer.from(await archive.read('modrinth.index.json', MIB))).toEqual(index)
    expect(await drain(archive.stream('overrides/mods/big.jar'))).toEqual({
      bytes: jar.length,
      hash: sha512(jar),
    })
    expect(Buffer.from(await archive.read('overrides/config/game.toml', MIB))).toEqual(config)
    await archive.close()
  })

  test('the same entries always make the same bytes, whenever they are written', async () => {
    const entries = async function* () {
      yield { name: 'modrinth.index.json', data: new TextEncoder().encode('{"formatVersion":1}') }
      yield { name: 'overrides/mods/a.jar', data: randomBytesOnce }
    }
    const first = await archives.write(join(dir, 'first.zip'), entries())
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    const second = await archives.write(join(dir, 'second.zip'), entries())
    expect(second).toEqual(first)
  })

  test('the same entries make the same bytes in every time zone', () => {
    // A zip keeps local time, so each zone's process would write its own hour into every header.
    const script = `
      const { LibraryPackArchives } = await import(${JSON.stringify(import.meta.resolve('./pack-archives.ts'))})
      async function* entries() {
        yield { name: 'overrides/mods/a.jar', data: new Uint8Array(4096).fill(7) }
      }
      console.log((await new LibraryPackArchives().write(process.argv[1], entries())).sha512)
    `
    const written = ['UTC', 'America/New_York', 'Asia/Riyadh'].map((zone, i) => {
      const run = spawnSync(process.execPath, ['-e', script, join(dir, `zone-${i}.zip`)], {
        encoding: 'utf8',
        env: { ...process.env, TZ: zone },
      })
      if (run.status !== 0) throw new Error(run.stderr)
      return run.stdout.trim()
    })
    expect(written[0]).toMatch(/^[0-9a-f]{128}$/)
    expect(new Set(written).size).toBe(1)
  })

  describe('downloads', () => {
    const body = randomBytes(500_000)
    let server: Server
    let base: string
    beforeAll(async () => {
      // Node's own server on the address it is asked on, as every other suite's: Bun's could be
      // handed a port another suite's server in the process still held, and answer as that one.
      server = createServer((request, response) => {
        switch (request.url) {
          case '/pack.zip':
            response.end(body)
            return
          // Redirects: onward on the same host, off to another name for it, and round in a circle.
          case '/moved.zip':
            response.writeHead(302, { location: '/pack.zip' }).end()
            return
          case '/away.zip':
            response.writeHead(302, { location: `http://localhost:${port}/pack.zip` }).end()
            return
          case '/loop.zip':
            response.writeHead(302, { location: '/loop.zip' }).end()
            return
          // Chunked, so no length is declared up front, and never more than 1 MiB in all: a test
          // that serves without end holds the process's memory hostage when a limit fails.
          case '/endless.zip': {
            let sent = 0
            const more = () => {
              while (sent < MIB) {
                sent += 64 * 1024
                if (!response.write(randomBytes(64 * 1024))) return void response.once('drain', more)
              }
              response.end()
            }
            more()
            return
          }
          default:
            response.statusCode = 404
            response.end('no')
        }
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as AddressInfo).port
      base = `http://127.0.0.1:${port}`
    })
    afterAll(() => new Promise((resolve) => server.close(resolve)))
    let port = 0
    /** A download held to this one address, as curated packs are held to their catalog's hosts. */
    const held = { allowed: (url: string) => new URL(url).hostname === '127.0.0.1' }

    test('a held download follows redirects that stay where it may go', async () => {
      const path = join(dir, 'moved.zip')
      expect(await archives.fetchTo(`${base}/moved.zip`, path, MIB, held)).toEqual({
        sizeBytes: body.length,
        sha512: sha512(body),
      })
    })

    test('a held download never asks an address it may not use, first or after a redirect', async () => {
      for (const url of [`http://localhost:${port}/pack.zip`, `${base}/away.zip`, `${base}/loop.zip`]) {
        const path = join(dir, 'refused.zip')
        const refused = await archives.fetchTo(url, path, MIB, held).catch((error: unknown) => error)
        expect(refused).toBeInstanceOf(DownloadRefused)
        expect(existsSync(path)).toBe(false)
      }
    })

    test('a download lands on disk with its size and sha512', async () => {
      const path = join(dir, 'fetched.zip')
      expect(await archives.fetchTo(`${base}/pack.zip`, path, MIB)).toEqual({
        sizeBytes: body.length,
        sha512: sha512(body),
      })
      expect(Buffer.from(await readFile(path))).toEqual(body)
    })

    test('a download past the limit is refused and leaves nothing behind, declared or not', async () => {
      const streamed = join(dir, 'endless.zip')
      const endless = await archives
        .fetchTo(`${base}/endless.zip`, streamed, 300_000)
        .catch((error: unknown) => error)
      expect((endless as HostileArchive).reason).toBe('too_large')
      expect(existsSync(streamed)).toBe(false)
      const declared = join(dir, 'declared.zip')
      const refused = await archives
        .fetchTo(`${base}/pack.zip`, declared, 1000)
        .catch((error: unknown) => error)
      expect((refused as HostileArchive).reason).toBe('too_large')
      expect(existsSync(declared)).toBe(false)
    })

    test('an answer other than success names its status', async () => {
      const missing = await archives
        .fetchTo(`${base}/gone.zip`, join(dir, 'gone.zip'), MIB)
        .catch((error: unknown) => error)
      expect(missing).not.toBeInstanceOf(HostileArchive)
      expect((missing as Error).message).toContain('404')
    })
  })
})
