// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import Docker from 'dockerode'
import { S3ArchiveStore } from '../s3/s3-archive-store.ts'
import { exportJob, partBatches, partsJob, partsPut } from './fly-runtime.ts'

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

describe.skipIf(!existsSync(SOCKET) || !s3.endpoint || !s3.bucket)(
  'Fly’s helper jobs, in the helper image',
  () => {
    const docker = new Docker({ socketPath: SOCKET })
    const volume = `blockly-fly-jobs-${randomUUID().slice(0, 8)}`
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
    async function run(script: string): Promise<string> {
      const container = await docker.createContainer({
        Image: HELPER,
        User: '0',
        Entrypoint: ['sh', '-c', `${script}\ncat /tmp/job.result`],
        HostConfig: {
          Mounts: [{ Type: 'volume', Source: volume, Target: '/data' }],
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

    beforeAll(async () => {
      const present = await docker
        .getImage(HELPER)
        .inspect()
        .then(
          () => true,
          () => false,
        )
      if (!present) {
        const stream = await docker.pull(HELPER)
        await new Promise((resolve, reject) =>
          docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve(null))),
        )
      }
      await docker.createVolume({ Name: volume })
      // A world of 20 MiB that doesn't compress: its archive is three parts of 8 MiB.
      await run(
        'mkdir -p /data/world && head -c 20971520 /dev/urandom > /data/world/region.mca && echo "ok" > /tmp/job.result',
      )
    }, 240_000)

    afterAll(async () => {
      await docker
        .getVolume(volume)
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
  },
)
