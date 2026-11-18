// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The fake runtime unpacking an archive into a volume: gzip or zstd, told apart by their first bytes. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { unpackArchive } from './fake-runtime/archive.ts'

let dir = ''
let server: Server
let base = ''
const served = new Map<string, Buffer>()

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blockly-fake-archive-'))
  await mkdir(join(dir, 'world', 'world'), { recursive: true })
  await writeFile(join(dir, 'world', 'world', 'level.dat'), 'LEVEL')
  const tar = Bun.spawnSync(['tar', '-cf', join(dir, 'w.tar'), '-C', join(dir, 'world'), '.'])
  if (tar.exitCode !== 0) throw new Error('tar failed')
  const packed = await readFile(join(dir, 'w.tar'))
  served.set('/w.tgz', gzipSync(packed))
  served.set('/w.tzst', zstdCompressSync(packed))
  served.set('/garbage', Buffer.from('neither of them'))
  server = createServer((request, response) => {
    const body = served.get(request.url ?? '')
    if (body === undefined) return response.writeHead(404).end()
    response.writeHead(200).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

test('a gzip archive and a zstd one unpack the same world', async () => {
  for (const name of ['w.tgz', 'w.tzst']) {
    const volume = join(dir, `volume-${name}`)
    await mkdir(volume)
    await unpackArchive(`${base}/${name}`, volume)
    expect(await readFile(join(volume, 'world', 'level.dat'), 'utf8')).toBe('LEVEL')
  }
})

test('one that is neither is refused', async () => {
  const volume = join(dir, 'volume-garbage')
  await mkdir(volume)
  await expect(unpackArchive(`${base}/garbage`, volume)).rejects.toThrow('neither gzip nor zstd')
})
