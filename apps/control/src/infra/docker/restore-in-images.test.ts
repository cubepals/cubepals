// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The restore step in the game's own images, each with its own shell and tools: the Ubuntu builds'
 * dash and GNU gzip, the Alpine builds' BusyBox ash and BusyBox gzip. Every case the step meets is
 * run in each, against a local server standing in for the store, and must end the same way, exit
 * included. An image this machine hasn't pulled is skipped: CI pulls none of them, as each is
 * hundreds of megabytes, so these run where the images already are.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { gzipSync, constants as zlib, zstdCompressSync } from 'node:zlib'
import Docker from 'dockerode'
import { RESTORE_FAILED_EXIT, RESTORE_STEP, restoreEnv } from '../../minecraft/restore-step.ts'
import { imageFor } from '../../minecraft/runtime-spec.ts'
import { UNLINKED } from '../../minecraft/volume-links.ts'

const SOCKET = '/var/run/docker.sock'
const docker = new Docker({ socketPath: SOCKET })
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** The images a server runs, by shell: an Ubuntu build and an Alpine one. */
const IMAGES = {
  dash: imageFor({ gameVersion: '26.3', loader: 'paper', modpack: null }),
  ash: imageFor({ gameVersion: '26.3', loader: 'vanilla', modpack: null }),
}
const present = (image: string) => {
  try {
    return existsSync(SOCKET) && Bun.spawnSync(['docker', 'image', 'inspect', image]).exitCode === 0
  } catch {
    return false
  }
}

/** A tar of a world, made in the image itself with `-b <blocking>`: 512 pads its last record. */
const TAR = (blocking: number) =>
  `mkdir -p /tmp/w/world && echo level > /tmp/w/world/level.dat && tar -b ${blocking} -cf - -C /tmp/w .`

const served = new Map<string, Buffer>()
const fetched = new Map<string, number>()
let store: ReturnType<typeof Bun.serve>
let base = ''

/** Runs `before`, then the step as a start runs it, in `image`; its exit and what /data holds. */
async function run(image: string, before: string, env: Record<string, string>): Promise<string> {
  const script = [
    'mkdir -p /data /tmp/outside && echo kept > /tmp/outside/file',
    before,
    `( ${UNLINKED} ${RESTORE_STEP} )`,
    'e=$?; echo "exit=$e $(cd /data && find . -mindepth 1 -maxdepth 2 | sort | tr "\\n" " ")outside=$(cat /tmp/outside/file)"',
  ].join('\n')
  const container = await docker.createContainer({
    Image: image,
    User: '0',
    Entrypoint: ['sh', '-c', script],
    Env: Object.entries(env).map(([name, value]) => `${name}=${value}`),
    HostConfig: { ExtraHosts: ['host.docker.internal:host-gateway'] },
  })
  try {
    await container.start()
    await container.wait()
    const logs = (await container.logs({ stdout: true, stderr: false })) as Buffer
    let out = ''
    for (let at = 0; at + 8 <= logs.length; ) {
      const length = logs.readUInt32BE(at + 4)
      out += logs.subarray(at + 8, at + 8 + length).toString('utf8')
      at += 8 + length
    }
    return out.trim().split('\n').at(-1) ?? ''
  } finally {
    await container.remove({ force: true })
  }
}

/** The tar the image makes, read out of it. */
async function tarFrom(image: string, blocking: number): Promise<Buffer> {
  const made = Bun.spawnSync(['docker', 'run', '--rm', '--entrypoint', 'sh', image, '-c', TAR(blocking)])
  if (made.exitCode !== 0) throw new Error(`tar in ${image} failed`)
  return Buffer.from(made.stdout)
}

const restoring = (name: string, hash = sha256(served.get(name) ?? Buffer.alloc(0))) =>
  restoreEnv(`${base}${name}`, hash)

beforeAll(async () => {
  const image = Object.values(IMAGES).find(present)
  if (image === undefined) return
  const tar = await tarFrom(image, 20)
  served.set('/w.tgz', gzipSync(tar))
  served.set('/w.tzst', zstdCompressSync(tar))
  served.set('/pad.tgz', gzipSync(await tarFrom(image, 512)))
  const crc = gzipSync(tar)
  crc[crc.length - 8] = (crc.at(-8) ?? 0) ^ 0xff
  served.set('/crc.tgz', crc)
  const sum = zstdCompressSync(tar, { params: { [zlib.ZSTD_c_checksumFlag]: 1 } })
  sum[sum.length - 1] = (sum.at(-1) ?? 0) ^ 0xff
  served.set('/sum.tzst', sum)
  served.set('/neither', Buffer.from('neither gzip nor zstd, at any length'))
  store = Bun.serve({
    port: 0,
    hostname: '0.0.0.0',
    fetch(request) {
      const path = new URL(request.url).pathname
      fetched.set(path, (fetched.get(path) ?? 0) + 1)
      const body = served.get(path)
      if (body === undefined) return new Response(null, { status: 403 })
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? '')
      if (range === null) return new Response(body)
      return new Response(body.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 })
    },
  })
  base = `http://host.docker.internal:${store.port}`
}, 300_000)

afterAll(() => store?.stop(true))

const WORLD = './.blockly-restored ./world ./world/level.dat '

for (const [shell, image] of Object.entries(IMAGES)) {
  describe.skipIf(!present(image))(`the restore step in ${image} (${shell})`, () => {
    test('a gzip, a zstd and a padded gzip copy each fill an empty volume, checked, and are done', async () => {
      for (const name of ['/w.tgz', '/w.tzst', '/pad.tgz'])
        expect(await run(image, '', restoring(name))).toBe(`exit=0 ${WORLD}outside=kept`)
    }, 120_000)

    test('a wrong sha256, a wrong checksum of its own, bytes that are neither, and a refused link each fail it', async () => {
      const failed = `exit=${RESTORE_FAILED_EXIT} ./.blockly-restoring outside=kept`
      expect(await run(image, '', restoring('/w.tgz', '0'.repeat(64)))).toBe(failed)
      for (const name of ['/crc.tgz', '/sum.tzst', '/neither', '/expired.tgz'])
        expect(await run(image, '', restoring(name, '1'.repeat(64)))).toBe(failed)
    }, 120_000)

    test('done, it fetches nothing; cut short, it starts over; a world it didn’t bring is left alone', async () => {
      const before = fetched.get('/w.tgz') ?? 0
      const done = 'echo played > /data/played && : > /data/.blockly-restored'
      expect(await run(image, done, restoring('/w.tgz'))).toBe(
        'exit=0 ./.blockly-restored ./played outside=kept',
      )
      const theirs = 'mkdir -p /data/world && echo theirs > /data/world/level.dat'
      expect(await run(image, theirs, restoring('/w.tgz'))).toBe(
        'exit=0 ./world ./world/level.dat outside=kept',
      )
      expect(fetched.get('/w.tgz') ?? 0).toBe(before)
      const cut = ': > /data/.blockly-restoring && echo half > /data/half.mca'
      expect(await run(image, cut, restoring('/w.tgz'))).toBe(`exit=0 ${WORLD}outside=kept`)
    }, 120_000)

    test('a link at either mark is taken away, and what it named is left as it was', async () => {
      const links =
        'mkdir -p /data/world && ln -s /tmp/outside/file /data/.blockly-restoring && ln -s /tmp/outside/file /data/.blockly-restored'
      expect(await run(image, links, restoring('/w.tgz'))).toBe('exit=0 ./world outside=kept')
      expect(await run(image, 'ln -s /tmp/outside/file /data/.blockly-restoring', restoring('/w.tgz'))).toBe(
        `exit=0 ${WORLD}outside=kept`,
      )
    }, 120_000)

    test('a start with no restore does nothing', async () => {
      expect(await run(image, '', {})).toBe('exit=0 outside=kept')
    }, 60_000)
  })
}
