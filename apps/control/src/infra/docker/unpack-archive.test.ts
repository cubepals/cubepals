// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Docker runtime filling a volume from an archive, in its archiver's own image: gzip, as every
 * archive so far, and zstd, told apart by their first bytes; and a download that is neither leaves
 * the world as it was.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import Docker from 'dockerode'
import { unpackArchive } from './docker-runtime/archives.ts'
import { helperRunner } from './docker-runtime/helper.ts'

const SOCKET = '/var/run/docker.sock'
const READER = 'curlimages/curl:8.22.0'

describe.skipIf(!existsSync(SOCKET))('a Docker volume filled from an archive', () => {
  const docker = new Docker({ socketPath: SOCKET })
  const helper = helperRunner(docker, `test-${randomUUID().slice(0, 8)}`)
  const volume = `blockly-unpack-${randomUUID().slice(0, 8)}`
  const served = new Map<string, Buffer>()
  let dir = ''
  let server: Server
  let base = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blockly-unpack-'))
    await mkdir(join(dir, 'world', 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'world', 'level.dat'), 'LEVEL')
    const tar = Bun.spawnSync(['tar', '-cf', join(dir, 'world.tar'), '-C', join(dir, 'world'), '.'])
    if (tar.exitCode !== 0) throw new Error('tar failed')
    const packed = await readFile(join(dir, 'world.tar'))
    served.set('/world.tgz', gzipSync(packed))
    served.set('/world.tzst', zstdCompressSync(packed))
    served.set('/garbage', Buffer.from('not an archive at all'.repeat(10)))
    server = createServer((request, response) => {
      const body = served.get(request.url ?? '')
      if (body === undefined) return response.writeHead(404).end()
      response.writeHead(200, { 'content-length': body.length }).end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    base = `http://host.docker.internal:${(server.address() as AddressInfo).port}`
    await docker.createVolume({ Name: volume })
  }, 240_000)

  afterAll(async () => {
    server.close()
    await rm(dir, { recursive: true, force: true })
    await docker
      .getVolume(volume)
      .remove()
      .catch(() => undefined)
  })

  /** The volume's files, as `find` lists them. */
  const files = async () =>
    (
      await helper(READER, ['sh', '-c', 'cd /to && find . -type f | sort'], {
        mounts: [{ Type: 'volume', Source: volume, Target: '/to' }],
      })
    ).trim()

  test('a gzip archive and a zstd one both fill it', async () => {
    for (const name of ['/world.tgz', '/world.tzst']) {
      await helper(READER, ['sh', '-c', 'find /to -mindepth 1 -delete && echo stale > /to/old'], {
        mounts: [{ Type: 'volume', Source: volume, Target: '/to' }],
      })
      await unpackArchive(helper, volume, { url: `${base}${name}` })
      expect(await files()).toBe('./world/level.dat')
    }
  }, 120_000)

  test('a download that is neither fails, and the world stays as it was', async () => {
    await helper(READER, ['sh', '-c', 'find /to -mindepth 1 -delete && echo kept > /to/old'], {
      mounts: [{ Type: 'volume', Source: volume, Target: '/to' }],
    })
    await expect(unpackArchive(helper, volume, { url: `${base}/garbage` })).rejects.toThrow()
    expect(await files()).toBe('./old')
  }, 120_000)
})
