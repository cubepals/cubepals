// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { strToU8, zipSync } from 'fflate'
import nbt from 'prismarine-nbt'
import { UnreadableFile } from '../../app/ports/formats.ts'
import { Cdn } from '../../testing/cdn.ts'
import { LibraryFileFormats } from './file-formats.ts'

const run = promisify(execFile)
const formats = new LibraryFileFormats()

describe('file formats', () => {
  test('a jar gives up the files asked for, and nothing else', () => {
    const jar = zipSync({
      'fabric.mod.json': strToU8('{"id":"lithium","depends":{"minecraft":["1.21","1.21.1"]}}'),
      'META-INF/MANIFEST.MF': strToU8('Manifest-Version: 1.0\n'),
      'net/example/Mod.class': new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
    })
    expect(formats.unzip(jar, ['fabric.mod.json', 'plugin.yml'])).toEqual({
      'fabric.mod.json': '{"id":"lithium","depends":{"minecraft":["1.21","1.21.1"]}}',
    })
  })

  test('a cut-off jar, or something that is not a zip, is unreadable', () => {
    const jar = zipSync({ 'fabric.mod.json': strToU8('{}'), 'big.bin': new Uint8Array(50_000).fill(7) })
    for (const bad of [jar.subarray(0, jar.length - 30), new TextEncoder().encode('not a jar at all')])
      expect(() => formats.unzip(bad, ['fabric.mod.json'])).toThrow(UnreadableFile)
  })

  test('a jar that lies about its metadata’s size, or holds more entries than a jar does, is refused at once', () => {
    // fflate allocates the size a record declares: a 1 MB jar once made it allocate 1 GiB.
    const jar = Buffer.from(zipSync({ 'fabric.mod.json': strToU8('{"id":"liar"}') }, { level: 0 }))
    const central = jar.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    jar.writeUInt32LE(1024 ** 3, central + 24)
    jar.writeUInt32LE(1024 ** 3, 22)
    const started = performance.now()
    expect(() => formats.unzip(jar, ['fabric.mod.json'])).toThrow(UnreadableFile)
    expect(performance.now() - started).toBeLessThan(100)
    const crowded = zipSync(
      Object.fromEntries(Array.from({ length: 20_001 }, (_, i) => [`f${i}`, new Uint8Array()])),
      { level: 0 },
    )
    expect(() => formats.unzip(crowded, ['fabric.mod.json'])).toThrow(UnreadableFile)
  })

  test('texts decode the way their formats define', () => {
    // YAML's floats would make 1.20 into 1.2; every scalar stays a string.
    expect(formats.decode('yaml', 'name: Chunky\napi-version: 1.20\nfolia-supported: true\n')).toEqual({
      name: 'Chunky',
      'api-version': '1.20',
      'folia-supported': 'true',
    })
    expect(
      formats.decode(
        'toml',
        'modLoader="javafml"\n[[mods]]\nmodId="jei"\n[[dependencies.jei]]\nmodId="minecraft"\nversionRange="[1.20.1, 1.20.2)"\n',
      ),
    ).toEqual({
      modLoader: 'javafml',
      mods: [{ modId: 'jei' }],
      dependencies: { jei: [{ modId: 'minecraft', versionRange: '[1.20.1, 1.20.2)' }] },
    })
    // As the server writes it: the colon is escaped.
    expect(
      formats.decode('properties', 'level-name=world\nlevel-type=minecraft\\:normal\nlevel-seed=\n'),
    ).toEqual({
      'level-name': 'world',
      'level-type': 'minecraft:normal',
      'level-seed': '',
    })
    expect(() => formats.decode('toml', 'mods = [')).toThrow(UnreadableFile)
    expect(() => formats.decode('json', '{')).toThrow(UnreadableFile)
  })

  test('a gzipped level.dat decodes to its data', async () => {
    const level = nbt.writeUncompressed({
      type: 'compound',
      name: '',
      value: {
        Data: {
          type: 'compound',
          value: {
            LevelName: { type: 'string', value: 'world' },
            DataVersion: { type: 'int', value: 5023 },
            Version: {
              type: 'compound',
              value: { Name: { type: 'string', value: '26.3' }, Snapshot: { type: 'byte', value: 0 } },
            },
          },
        },
      },
    })
    const decoded = (await formats.decodeNbt(gzipSync(level))) as { Data: { Version: { Name: string } } }
    expect(decoded.Data.Version.Name).toBe('26.3')
    await expect(formats.decodeNbt(new TextEncoder().encode('nope'))).rejects.toBeInstanceOf(UnreadableFile)
  })

  describe('tarballs over HTTP', () => {
    let dir: string
    let server: Server
    let base: string
    const served = new Map<string, Buffer>()

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'blockly-formats-'))
      const volume = join(dir, 'volume')
      await mkdir(join(volume, 'world', 'region'), { recursive: true })
      await mkdir(join(volume, 'libraries'), { recursive: true })
      await writeFile(join(volume, 'server.properties'), 'level-name=world\n')
      await writeFile(join(volume, 'world', 'level.dat'), 'LEVEL')
      await writeFile(join(volume, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(200_000, 1))
      await writeFile(join(volume, 'libraries', 'big.jar'), Buffer.alloc(300_000, 2))
      await run('tar', ['-czf', join(dir, 'world.tar.gz'), '-C', volume, '.'])
      served.set('/world.tar.gz', await readFile(join(dir, 'world.tar.gz')))
      served.set('/garbage.tar.gz', Buffer.from('this is not an archive'.repeat(100)))
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

    test('the entries asked for come back, and reading stops once they are in', async () => {
      const found = await formats.readTarball(`${base}/world.tar.gz`, {
        wanted: (path) => path === 'server.properties' || /^[^/]+\/level\.dat$/.test(path),
        enough: (files) => files.has('server.properties') && files.has('world/level.dat'),
        maxEntryBytes: 1024,
      })
      expect([...found.keys()].sort()).toEqual(['server.properties', 'world/level.dat'])
      expect(Buffer.from(found.get('world/level.dat') ?? []).toString()).toBe('LEVEL')
    })

    test('an entry over the limit, a file that is not an archive, and a missing one fail', async () => {
      const everything = { wanted: () => true, enough: () => false }
      await expect(
        formats.readTarball(`${base}/world.tar.gz`, { ...everything, maxEntryBytes: 100 }),
      ).rejects.toBeInstanceOf(UnreadableFile)
      await expect(
        formats.readTarball(`${base}/garbage.tar.gz`, { ...everything, maxEntryBytes: 1_000_000 }),
      ).rejects.toBeInstanceOf(UnreadableFile)
      await expect(
        formats.readTarball(`${base}/missing.tar.gz`, { ...everything, maxEntryBytes: 1 }),
      ).rejects.toThrow('answered 404')
    })
  })

  describe('zips read by ranges', () => {
    const cdn = new Cdn()
    beforeAll(() => cdn.start())
    afterAll(() => cdn.close())

    // A pack as Modrinth serves one: its index, its overrides, and the list a checker reads.
    const pack = Buffer.from(
      zipSync({
        'modrinth.index.json': strToU8('{"formatVersion":1}'),
        'overrides/mods/big.jar': new Uint8Array(400_000).fill(7),
        'overrides/config/list.json': strToU8('[{"displayName":"Balm"}]'),
      }),
    )

    test('the names, and the entries asked for, come back without the whole file', async () => {
      const file = cdn.file('pack', pack)
      const read = await formats.readRemoteZip(file.url, {
        wanted: (name) => name === 'overrides/config/list.json',
        maxEntryBytes: 10_000,
      })
      expect(read.names.sort()).toEqual([
        'modrinth.index.json',
        'overrides/config/list.json',
        'overrides/mods/big.jar',
      ])
      expect(new TextDecoder().decode(read.entries.get('overrides/config/list.json'))).toBe(
        '[{"displayName":"Balm"}]',
      )
      // Only ranges were read: the CDN counts a whole download, and there was none.
      expect(cdn.downloads).toBe(0)
    })

    test('an entry past the size asked for, or a zip that is not one, is unreadable', async () => {
      const file = cdn.file('pack-again', pack)
      await expect(
        formats.readRemoteZip(file.url, { wanted: (name) => name.endsWith('big.jar'), maxEntryBytes: 1_000 }),
      ).rejects.toBeInstanceOf(UnreadableFile)
      const garbage = cdn.file('garbage', Buffer.from('not a zip'.repeat(100)))
      await expect(
        formats.readRemoteZip(garbage.url, { wanted: () => true, maxEntryBytes: 1_000 }),
      ).rejects.toBeInstanceOf(UnreadableFile)
    })
  })
})
