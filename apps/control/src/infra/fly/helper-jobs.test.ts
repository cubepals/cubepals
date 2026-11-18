// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import Docker from 'dockerode'
import { S3ArchiveStore } from '../s3/s3-archive-store.ts'
import { exportJob, partBatches, partsJob, partsPut, restoreJob } from './fly-runtime.ts'

// The scripts Fly's helper machines run, run here in the helper's own image (its busybox shell,
// its curl, its dd) against an S3 store, as a helper runs them on a volume made from a snapshot.

const SOCKET = '/var/run/docker.sock'
const HELPER = 'curlimages/curl:8.22.0'
const MIB = 1024 ** 2
const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

const docker = new Docker({ socketPath: SOCKET })
const volume = `blockly-fly-jobs-${randomUUID().slice(0, 8)}`
const restored = `${volume}-restored`
// The test reaches the store on the host; the helper through the host gateway.
const store = new S3ArchiveStore({
  endpoint: s3.endpoint ?? '',
  runtimeEndpoint: (s3.endpoint ?? '').replace(/127\.0\.0\.1|localhost/, 'host.docker.internal'),
  bucket: s3.bucket ?? '',
  region: 'auto',
  accessKeyId: s3.accessKeyId,
  secretAccessKey: s3.secretAccessKey,
})
const keys: string[] = []

/** A job's script, run as the helper runs it, as root on the volume; returns its result. */
async function run(script: string, on = volume): Promise<string> {
  const container = await docker.createContainer({
    Image: HELPER,
    User: '0',
    Entrypoint: ['sh', '-c', `${script}\ncat /tmp/job.result`],
    HostConfig: {
      Mounts: [{ Type: 'volume', Source: on, Target: '/data' }],
      ExtraHosts: ['host.docker.internal:host-gateway'],
    },
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

async function stored(key: string): Promise<{ sizeBytes: number; sha256: string }> {
  const read = await fetch((await store.presignGet(key, 600, 'browser')).url)
  const bytes = Buffer.from(await read.arrayBuffer())
  return { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

const key = () => {
  keys.push(`archives/test/${randomUUID()}.tar.gz`)
  return keys.at(-1) ?? ''
}

/** The helper's image, pulled where this machine hasn't it yet. */
async function helperImage(): Promise<void> {
  const present = await docker
    .getImage(HELPER)
    .inspect()
    .then(
      () => true,
      () => false,
    )
  if (present) return
  const stream = await docker.pull(HELPER)
  await new Promise((resolve, reject) =>
    docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve(null))),
  )
}

/**
 * `script` run with a `sync` that notes it ran, first on the PATH, its result led by whether it
 * did: `synced ok …` or `unsynced ok …`.
 */
const noted = (script: string) =>
  [
    'mkdir -p /tmp/shim',
    `printf '#!/bin/sh\necho synced >> /tmp/calls\n' > /tmp/shim/sync && chmod +x /tmp/shim/sync`,
    'export PATH=/tmp/shim:$PATH',
    script,
    'echo "$(cat /tmp/calls 2>/dev/null || echo unsynced) $(cat /tmp/job.result)" > /tmp/job.result',
  ].join('\n')

// The helper is destroyed by force the moment its job gives a result, and what the kernel hadn't
// written to the volume by then is lost: a world restored that way booted with an empty level.dat.
describe.skipIf(!existsSync(SOCKET))('a helper job that writes to the volume', () => {
  const flushed = `${volume}-flushed`

  beforeAll(async () => {
    await helperImage()
    await docker.createVolume({ Name: flushed })
  }, 240_000)

  afterAll(async () => {
    await docker
      .getVolume(flushed)
      .remove()
      .catch(() => undefined)
  })

  // A world with bytes after the tar's end: tar stops at its end, and the hash still covers them.
  const packed = [
    'mkdir -p /tmp/w/world && echo level > /tmp/w/world/level.dat',
    'tar -cf /tmp/a.tar -C /tmp/w . && head -c 102400 /dev/zero >> /tmp/a.tar && gzip -c /tmp/a.tar > /tmp/a.tgz',
    "sha=$(sha256sum /tmp/a.tgz | cut -d' ' -f1)",
  ].join('\n')
  /** What the volume holds after `script`, read in the same helper: its files, or `empty`. */
  const holds = (script: string) =>
    `${script}\necho "$(cat /tmp/job.result) | $(cd /data && find . -mindepth 1 -type f | sort | tr '\\n' ' ')" > /tmp/job.result`
  /** The job with the archive's own sha256, read when the script runs; or with `wrong`. */
  const checked = (wrong?: string) =>
    restoreJob('file:///tmp/a.tgz', wrong ?? 'f'.repeat(64)).replace(
      `'${'f'.repeat(64)}'`,
      wrong ? `'${wrong}'` : '"$sha"',
    )

  test('an archive whose sha256 is the one recorded is restored, every byte of it hashed', async () => {
    const said = await run(holds(`find /data -mindepth 1 -delete\n${packed}\n${checked()}`), flushed)
    expect(said).toBe('ok restored | ./world/level.dat')
  }, 120_000)

  test('an archive that isn’t the one recorded fails the restore, and leaves nothing on the volume', async () => {
    const said = await run(
      holds(`find /data -mindepth 1 -delete\n${packed}\n${checked('0'.repeat(64))}`),
      flushed,
    )
    expect(said).toBe('failed 1 |')
  }, 120_000)

  test('a zstd archive is restored as a gzip one is, told apart by its first bytes', async () => {
    const zstd = packed.replace('gzip -c /tmp/a.tar > /tmp/a.tgz', 'zstd -q -c /tmp/a.tar > /tmp/a.tgz')
    expect(zstd).not.toBe(packed)
    const said = await run(holds(`find /data -mindepth 1 -delete\n${zstd}\n${checked()}`), flushed)
    expect(said).toBe('ok restored | ./world/level.dat')
    const unchecked = await run(
      holds(`find /data -mindepth 1 -delete\n${zstd}\n${restoreJob('file:///tmp/a.tgz')}`),
      flushed,
    )
    expect(unchecked).toBe('ok restored | ./world/level.dat')
  }, 120_000)

  test('a gzip archive whose own checksum is wrong fails the restore, though its sha256 is recorded', async () => {
    // The CRC-32 in gzip's trailer, changed after the archive's sha256 is taken: tar's headers
    // are whole, and only the inflater can tell.
    const broken = packed.replace(
      'sha=$(sha256sum',
      'printf "\\377\\377\\377\\377" | dd of=/tmp/a.tgz bs=1 seek=$(( $(stat -c %s /tmp/a.tgz) - 8 )) conv=notrunc 2>/dev/null\nsha=$(sha256sum',
    )
    expect(broken).not.toBe(packed)
    const said = await run(holds(`find /data -mindepth 1 -delete\n${broken}\n${checked()}`), flushed)
    expect(said).toStartWith('failed')
  }, 120_000)

  test('flushes the world it restored before it says so', async () => {
    const made =
      'mkdir -p /tmp/w/world && echo level > /tmp/w/world/level.dat && tar -czf /tmp/a.tgz -C /tmp/w .'
    expect(await run(noted(`${made}\n${restoreJob('file:///tmp/a.tgz')}`), flushed)).toBe(
      'synced ok restored',
    )
  }, 120_000)

  test('archives a volume its machine was to fill only once the restore’s mark is there', async () => {
    const target = { url: 'http://127.0.0.1:9/unused', headers: {} }
    const empty = `find /data -mindepth 1 -delete\necho level > /data/level.dat\n`
    expect(await run(`${empty}${exportJob(target, 0, '.blockly-restored')}`, flushed)).toBe('ok unrestored')
    const marked = `${empty}: > /data/.blockly-restored\n${exportJob(target, 0, '.blockly-restored')}`
    expect(await run(marked, flushed)).toMatch(/^ok parts [0-9a-f]{64} \d+$/)
  }, 120_000)

  test('flushes the archive it leaves for the parts, which another helper reads', async () => {
    const said = await run(noted(exportJob({ url: 'http://127.0.0.1:9/unused', headers: {} }, 0)), flushed)
    expect(said).toMatch(/^synced ok parts [0-9a-f]{64} \d+$/)
  }, 120_000)
})

describe.skipIf(!existsSync(SOCKET) || !s3.endpoint || !s3.bucket)(
  'Fly’s helper jobs, in the helper image',
  () => {
    beforeAll(async () => {
      await helperImage()
      await docker.createVolume({ Name: volume })
      await docker.createVolume({ Name: restored })
      // A world of 20 MiB that doesn't compress: its archive is three parts of 8 MiB.
      await run(
        'mkdir -p /data/world && head -c 20971520 /dev/urandom > /data/world/region.mca && echo "ok" > /tmp/job.result',
      )
    }, 240_000)

    afterAll(async () => {
      for (const made of [volume, restored])
        await docker
          .getVolume(made)
          .remove()
          .catch(() => undefined)
      for (const stale of keys) await store.delete(stale).catch(() => undefined)
    })

    test('an archive one PUT carries goes whole', async () => {
      const whole = key()
      const target = await store.archiveTarget(whole, 600, 'runtime')
      const said = await run(exportJob(target.put, target.maxPutBytes))
      const [how, sha256, size] = said.replace(/^ok /, '').split(' ')
      expect(how).toBe('put')
      expect(await stored(whole)).toEqual({ sizeBytes: Number(size), sha256: sha256 ?? '' })
    }, 120_000)

    test('a larger one waits on the volume and goes in parts, a batch to each job', async () => {
      const inParts = key()
      const target = { ...(await store.archiveTarget(inParts, 600, 'runtime')), maxPutBytes: 4 * MIB }
      const said = await run(exportJob(target.put, target.maxPutBytes))
      const [how, sha256 = '', size = '0'] = said.replace(/^ok /, '').split(' ')
      expect(how).toBe('parts')
      expect(await store.head(inParts)).toBeNull()
      const sizeBytes = Number(size)
      // Parts of 8 MiB, two to a job: parts 1 and 2, then 3.
      const parts = await target.inParts(sizeBytes)
      expect(parts.partSize).toBe(8 * MIB)
      const batches = partBatches(parts, sizeBytes, 2)
      expect(batches).toEqual([[1, 2], [3]])
      const put = []
      for (const batch of batches) {
        const sent = await run(partsJob(parts, sizeBytes, batch))
        expect(sent).toMatch(/^ok /)
        put.push(...partsPut(sent.slice(3)))
      }
      expect(put.map((part) => part.number)).toEqual([1, 2, 3])
      await parts.complete(put)
      expect(await stored(inParts)).toEqual({ sizeBytes, sha256 })
    }, 180_000)

    test('a part the store refuses fails its job, which says so', async () => {
      const refused = key()
      const target = await store.archiveTarget(refused, 600, 'runtime')
      const said = await run(exportJob(target.put, 4 * MIB))
      const sizeBytes = Number(said.split(' ').at(-1))
      const parts = await target.inParts(sizeBytes, 2)
      await parts.abort()
      expect(await run(partsJob(parts, sizeBytes, [1]))).toMatch(/^failed /)
      expect(await store.head(refused)).toBeNull()
    }, 120_000)

    test('a restore keeps regular files and directories only, all root’s, none setuid', async () => {
      const archive = key()
      const put = await store.presignPut(archive, 600, 'runtime')
      // An archive holding one of each kind of entry, owned by the server's user, made in the
      // helper's own image as root.
      const made = await run(
        [
          'set -e',
          'mkdir -p /tmp/w/world && cd /tmp/w',
          'echo level > world/level.dat && chmod 4755 world/level.dat',
          'ln -s level.dat world/near && ln -s / world/root && ln world/level.dat world/again',
          'mkfifo world/pipe && mknod world/null c 1 3',
          'chown -R 1000:1000 .',
          'tar -czf /tmp/a.tgz .',
          `curl -fsS -X PUT --upload-file /tmp/a.tgz '${put.url}' > /dev/null`,
          'echo ok > /tmp/job.result',
        ].join('\n'),
      )
      expect(made).toBe('ok')
      const download = await store.presignGet(archive, 600, 'runtime')
      expect(await run(restoreJob(download.url), restored)).toBe('ok restored')
      const listed = await run(
        `echo "$(cd /data && find . -xdev | sort | while read -r f; do stat -c '%F %u:%g %A %n' "$f"; done | tr '\\n' ';')" > /tmp/job.result`,
        restored,
      )
      expect(listed.split(';').filter(Boolean)).toEqual([
        'directory 0:0 drwxr-xr-x .',
        'directory 0:0 drwxr-xr-x ./world',
        'regular file 0:0 -rwxr-xr-x ./world/again',
        'regular file 0:0 -rwxr-xr-x ./world/level.dat',
      ])
    }, 120_000)
  },
)

test('a restore checks the sha256 it is given, refuses one that isn’t a sha256, and checks none without one', () => {
  const sha = 'AB'.repeat(32)
  expect(restoreJob('https://store.example/a.tgz', sha)).toContain(`!= '${sha.toLowerCase()}' ]`)
  expect(() => restoreJob('https://store.example/a.tgz', 'abc; rm -rf /')).toThrow("isn't a sha256")
  for (const none of [undefined, null, ''])
    expect(restoreJob('https://store.example/a.tgz', none)).not.toContain('sha256sum')
})
