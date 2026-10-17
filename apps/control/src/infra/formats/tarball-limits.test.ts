// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An uploaded world, and every archive checked before a world rests, is read by `readTarball`,
 * which stops once it would keep more files or bytes than it may, once the archive inflates past
 * what it may, or once it has taken too long: each is refused, and says why.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { Header } from 'tar'
import { ReadCutShort, UnreadableFile } from '../../app/ports/formats.ts'
import { LibraryFileFormats } from './file-formats.ts'

const formats = new LibraryFileFormats()
const GiB = 1024 ** 3
/** What the bomb inflates to; the upload itself stays a few megabytes. */
const INFLATED = 8 * GiB
const CHUNK = 64 * 1024 ** 2
const worldFiles = (path: string) => path === 'server.properties' || /^[^/]+\/level\.dat$/.test(path)
/** Every bound far past what a test's archive needs, but the one it is about. */
const limits = {
  wanted: worldFiles,
  enough: () => false,
  maxEntryBytes: 4 * 1024 * 1024,
  maxKeptEntries: 16,
  maxKeptBytes: 16 * 1024 * 1024,
  maxInflatedBytes: 4 * GiB,
  deadlineMs: 60_000,
}

function header(path: string, size: number): Buffer {
  const block = Buffer.alloc(512)
  new Header({ path, type: 'File', mode: 0o644, size, mtime: new Date(0) }).encode(block, 0)
  return block
}

/** A tarball of `files`, each padded to whole blocks, with its end. */
function tar(files: ReadonlyArray<[path: string, data: Buffer]>): Buffer {
  const parts = files.flatMap(([path, data]) => [
    header(path, data.length),
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ])
  return Buffer.concat([...parts, Buffer.alloc(1024)])
}

/** What a read came to: the entries it read, or why it was refused. */
const outcomeOf = (read: Promise<Map<string, Uint8Array>>) =>
  read.then(
    (found) => ({ read: [...found.keys()] }),
    (error: unknown) => ({
      refused: error instanceof UnreadableFile,
      limit: error instanceof ReadCutShort ? error.limit : null,
      why: String(error),
    }),
  )

describe('a world upload that inflates without end', () => {
  let server: Server
  let url = ''
  let sentBytes = 0

  beforeAll(async () => {
    // Gzip members, concatenated: one gzip stream to whoever inflates it.
    const zeros = gzipSync(Buffer.alloc(CHUNK), { level: 1 })
    const members: Buffer[] = [gzipSync(header('padding.bin', INFLATED))]
    for (let i = 0; i < INFLATED / CHUNK; i++) members.push(zeros)
    const props = Buffer.from('level-name=world\n')
    const tail = Buffer.concat([
      header('server.properties', props.length),
      props,
      Buffer.alloc(512 - props.length),
      Buffer.alloc(1024),
    ])
    members.push(gzipSync(tail))
    sentBytes = members.reduce((n, m) => n + m.length, 0)
    server = createServer((_request, response) => {
      response.setHeader('Content-Length', sentBytes)
      for (const m of members) response.write(m)
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bomb.tar.gz`
  })

  afterAll(() => server.close())

  test('is refused once it inflates far past what a world download can be, not read to the end', async () => {
    const outcome = await outcomeOf(formats.readTarball(url, { ...limits, maxInflatedBytes: GiB }))
    expect(outcome).toMatchObject({ refused: true, limit: 'size' })
    expect(outcome).toHaveProperty('why', expect.stringContaining('once inflated'))
  }, 600_000)
})

describe('a world upload that never finishes arriving', () => {
  let server: Server
  let url = ''

  beforeAll(async () => {
    // A tarball's first entry, then a trickle that never ends.
    server = createServer((_request, response) => {
      response.write(gzipSync(header('padding.bin', GiB)))
      const trickle = setInterval(() => response.write(gzipSync(Buffer.alloc(512))), 20)
      response.on('close', () => clearInterval(trickle))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow.tar.gz`
  })

  afterAll(() => server.closeAllConnections())

  test('is refused once it has taken longer than it may, and says so', async () => {
    const outcome = await outcomeOf(formats.readTarball(url, { ...limits, deadlineMs: 300 }))
    expect(outcome).toMatchObject({ refused: true, limit: 'time' })
    expect(outcome).toHaveProperty('why', expect.stringContaining('Not read within'))
  })
})

describe('what a world upload holds to keep', () => {
  const served = new Map<string, Buffer>()
  let server: Server
  let base = ''

  beforeAll(async () => {
    const level = (i: number): [string, Buffer] => [`world_${i}/level.dat`, Buffer.from('LEVEL')]
    served.set('/many.tar.gz', gzipSync(tar(Array.from({ length: 200 }, (_, i) => level(i)))))
    const large = (i: number): [string, Buffer] => [`world_${i}/level.dat`, Buffer.alloc(3 * 1024 * 1024, 1)]
    served.set('/large.tar.gz', gzipSync(tar(Array.from({ length: 8 }, (_, i) => large(i)))))
    // A tarball compressed twice: what the outer layer inflates to is compressed again. Its file
    // takes four values a byte, so it inflates a few times over, as ordinary data does.
    const padding = Buffer.from(Array.from({ length: 16 * 1024 * 1024 }, () => Math.floor(Math.random() * 4)))
    const inner = gzipSync(tar([['padding.bin', padding]]))
    served.set('/twice.tar.gz', gzipSync(inner))
    server = createServer((request, response) => {
      const body = served.get(request.url ?? '')
      if (body === undefined) return response.writeHead(404).end()
      response.writeHead(200, { 'content-length': body.length }).end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => server.close())

  test('too many small files to keep are refused before they fill memory', async () => {
    const outcome = await outcomeOf(formats.readTarball(`${base}/many.tar.gz`, limits))
    expect(outcome).toMatchObject({ refused: true, limit: 'kept' })
    expect(outcome).toHaveProperty('why', expect.stringContaining('to keep'))
  })

  test('files to keep that together pass the bytes it may hold are refused', async () => {
    const outcome = await outcomeOf(formats.readTarball(`${base}/large.tar.gz`, limits))
    expect(outcome).toMatchObject({ refused: true, limit: 'kept' })
  })

  test('a tarball compressed again inside is refused, not inflated a second time', async () => {
    const outcome = await outcomeOf(formats.readTarball(`${base}/twice.tar.gz`, limits))
    expect(outcome).toMatchObject({ refused: true, limit: null })
    expect(outcome).toHaveProperty('why', expect.stringContaining('decompression ratio'))
  })
})
