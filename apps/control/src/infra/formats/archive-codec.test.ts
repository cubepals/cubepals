// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Archives packed with zstd read as those packed with gzip: the codec told by the first bytes, the
 * inflated bytes counted the same way, and a player's download still a gzipped tarball.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { codecOf } from './archive-codec.ts'
import { LibraryFileFormats } from './file-formats.ts'

const formats = new LibraryFileFormats()
const bounds = {
  maxEntryBytes: 1_000_000,
  maxKeptEntries: 100,
  maxKeptBytes: 10_000_000,
  maxInflatedBytes: 10_000_000,
  deadlineMs: 60_000,
}
const everything = { wanted: () => true, enough: () => false, ...bounds }

let dir = ''
let server: Server
let base = ''
const served = new Map<string, Buffer>()

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blockly-codec-'))
  const volume = join(dir, 'volume')
  await mkdir(join(volume, 'world', 'region'), { recursive: true })
  await writeFile(join(volume, 'server.properties'), 'level-name=world\n')
  await writeFile(join(volume, 'world', 'level.dat'), 'LEVEL')
  // A world's region data is mostly compressed already: random bytes stand for it, since a file of
  // one repeated byte packs past the 1000:1 node-tar refuses, in zstd though not in gzip.
  await writeFile(join(volume, 'world', 'region', 'r.0.0.mca'), randomBytes(200_000))
  const tar = Bun.spawnSync(['tar', '-cf', join(dir, 'w.tar'), '-C', volume, '.'])
  if (tar.exitCode !== 0) throw new Error('tar failed')
  const packed = await readFile(join(dir, 'w.tar'))
  served.set('/w.tgz', gzipSync(packed))
  served.set('/w.tzst', zstdCompressSync(packed))
  served.set('/tar', packed)
  server = createServer((request, response) => {
    const body = served.get(request.url ?? '')
    if (body === undefined) return response.writeHead(404).end()
    response.writeHead(200, { 'content-length': body.length }).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

test('the codec is told by the first bytes', () => {
  expect(codecOf(served.get('/w.tgz') ?? new Uint8Array())).toBe('gzip')
  expect(codecOf(served.get('/w.tzst') ?? new Uint8Array())).toBe('zstd')
  expect(codecOf(served.get('/tar') ?? new Uint8Array())).toBeNull()
  expect(codecOf(Uint8Array.of(0x28, 0xb5))).toBeNull()
})

test('a zstd archive reads as the gzip one does, and an archive in neither is refused', async () => {
  for (const name of ['/w.tgz', '/w.tzst']) {
    const found = await formats.readTarball(`${base}${name}`, {
      ...bounds,
      wanted: (path) => path === 'server.properties' || path === 'world/level.dat',
      enough: (files) => files.size === 2,
    })
    expect(Buffer.from(found.get('world/level.dat') ?? []).toString()).toBe('LEVEL')
  }
  await expect(formats.readTarball(`${base}/tar`, everything)).rejects.toThrow('Not a gzip or zstd tarball')
})

test('what a zstd archive inflates to is counted as a gzip one’s is', async () => {
  await expect(
    formats.readTarball(`${base}/w.tzst`, { ...everything, maxInflatedBytes: 100_000 }),
  ).rejects.toThrow('once inflated')
})

test('a download made from a zstd archive is a gzipped tarball of the entries kept', async () => {
  const body = await formats.filterTarball(`${base}/w.tzst`, {
    kept: (path) => path.startsWith('world/'),
    added: () => new Map([['NOTE.txt', 'note']]),
  })
  const gzipped = Buffer.from(await new Response(body).arrayBuffer())
  expect(codecOf(gzipped)).toBe('gzip')
  served.set('/download', gzipped)
  const listed = await formats.readTarball(`${base}/download`, everything)
  expect([...listed.keys()].sort()).toEqual(['NOTE.txt', 'world/level.dat', 'world/region/r.0.0.mca'])
})
