import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { ArtifactMismatch } from '../../app/ports/optional.ts'
import { S3ArchiveStore } from './s3-archive-store.ts'

// A real S3 server, as CI runs one:
//   docker run --rm -p 127.0.0.1:9000:9000 -e RUSTFS_ACCESS_KEY=blockly-test \
//     -e RUSTFS_SECRET_KEY=blockly-test-secret rustfs/rustfs:1.0.0 /data
//   S3_TEST_ENDPOINT=http://127.0.0.1:9000 bun test
// Against R2, with a token for an existing bucket, add S3_TEST_BUCKET, S3_TEST_ACCESS_KEY_ID and
// S3_TEST_SECRET_ACCESS_KEY; the test removes what it writes.
const env = process.env
const endpoint = env.S3_TEST_ENDPOINT
const credentials = {
  accessKeyId: env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}
const MIB = 1024 ** 2
const sha512 = (bytes: Uint8Array) => createHash('sha512').update(bytes).digest('hex')

describe.skipIf(!endpoint)('S3ArchiveStore', () => {
  const bucket = env.S3_TEST_BUCKET ?? `blockly-test-${randomBytes(4).toString('hex')}`
  const jar = randomBytes(200_000)
  let cdn: Server
  let cdnUrl = ''
  let cdnRequests = 0

  const store = (patch: { maxIngestBytes?: number } = {}) =>
    new S3ArchiveStore({
      endpoint: endpoint ?? '',
      runtimeEndpoint: 'http://runtime.test:9000',
      bucket,
      region: 'auto',
      ...credentials,
      ...patch,
    })

  beforeAll(async () => {
    if (!env.S3_TEST_BUCKET)
      await new S3Client({ endpoint, region: 'auto', forcePathStyle: true, credentials }).send(
        new CreateBucketCommand({ Bucket: bucket }),
      )
    // Stands in for the Modrinth CDN.
    cdn = createServer((request, response) => {
      cdnRequests++
      if (request.url === '/mod.jar') return response.end(jar)
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve) => cdn.listen(0, '127.0.0.1', resolve))
    cdnUrl = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    cdn.close()
    const archives = store()
    for (const key of [
      'uploads/one.jar',
      'uploads/sized.jar',
      'archives/world.tar.gz',
      'archives/parts.tar.gz',
      `artifacts/${sha512(jar)}`,
    ])
      await archives.delete(key)
  })

  test('a presigned upload lands, signed for the name its user will call', async () => {
    const archives = store()
    const browser = await archives.presignPut('uploads/one.jar', 300, 'browser')
    const runtime = await archives.presignPut('uploads/one.jar', 300, 'runtime')
    expect(new URL(browser.url).origin).toBe(new URL(endpoint ?? '').origin)
    expect(new URL(runtime.url).origin).toBe('http://runtime.test:9000')
    // No checksum rides in the link: an uploader has only the URL.
    expect(browser.url).not.toMatch(/x-amz-(sdk-)?checksum/i)
    const put = await fetch(browser.url, { method: 'PUT', body: jar, headers: browser.headers })
    expect(put.status).toBe(200)
    expect(await archives.head('uploads/one.jar')).toEqual({ sizeBytes: jar.length })
  })

  test('an upload signed for a size takes exactly that many bytes', async () => {
    const archives = store()
    const put = await archives.presignPut('uploads/sized.jar', 300, 'browser', jar.length)
    expect(new URL(put.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host')
    for (const body of [Buffer.concat([jar, Buffer.from('more')]), jar.subarray(0, 10)])
      expect((await fetch(put.url, { method: 'PUT', body })).status).toBe(403)
    expect(await archives.head('uploads/sized.jar')).toBeNull()
    expect((await fetch(put.url, { method: 'PUT', body: jar })).status).toBe(200)
    expect(await archives.head('uploads/sized.jar')).toEqual({ sizeBytes: jar.length })
  })

  test('an archive in parts lands whole, joined from the ETags its parts were put with', async () => {
    const archives = store()
    const world = randomBytes(17 * MIB + 4321)
    const target = await archives.archiveTarget('archives/parts.tar.gz', 300, 'browser')
    expect(target.maxPutBytes).toBe(5 * 1024 ** 3 - 5 * MIB)
    const parts = await target.inParts(world.length, 4)
    // 17 MiB in four: parts of 5 MiB (rounded up to whole MiB), the least the plan makes being 8.
    expect(parts.partSize).toBe(8 * MIB)
    const put = []
    for (let number = 1; number <= Math.ceil(world.length / parts.partSize); number++) {
      const body = world.subarray((number - 1) * parts.partSize, number * parts.partSize)
      const answer = await fetch(parts.urls[number - 1] ?? '', {
        method: 'PUT',
        body,
        headers: parts.headers,
      })
      expect(answer.status).toBe(200)
      put.push({ number, etag: answer.headers.get('etag') ?? '' })
    }
    // Nothing is there until the upload completes; given out of order, the parts still join in it.
    expect(await archives.head('archives/parts.tar.gz')).toBeNull()
    await parts.complete(put.reverse())
    expect(await archives.head('archives/parts.tar.gz')).toEqual({ sizeBytes: world.length })
    const read = await fetch((await archives.presignGet('archives/parts.tar.gz', 300, 'browser')).url)
    expect(Buffer.from(await read.arrayBuffer()).equals(world)).toBe(true)
    // Completed, it has nothing left to drop.
    await parts.abort()
    expect(await archives.head('archives/parts.tar.gz')).toEqual({ sizeBytes: world.length })
  })

  test('an upload in parts dropped stores nothing, takes no more parts, and drops twice', async () => {
    const archives = store()
    const target = await archives.archiveTarget('archives/dropped.tar.gz', 300, 'browser')
    const parts = await target.inParts(20 * MIB)
    const first = randomBytes(parts.partSize)
    expect((await fetch(parts.urls[0] ?? '', { method: 'PUT', body: first })).status).toBe(200)
    await parts.abort()
    await parts.abort()
    expect(await archives.head('archives/dropped.tar.gz')).toBeNull()
    // A few bytes: refused unread, a whole part would leave the connection with the rest unsent.
    expect((await fetch(parts.urls[1] ?? '', { method: 'PUT', body: 'more' })).status).toBe(404)
  })

  test('a presigned download carries its name, however it is spelled', async () => {
    const archives = store()
    const put = await archives.presignPut('archives/world.tar.gz', 300, 'browser')
    await fetch(put.url, { method: 'PUT', body: jar })
    const link = await archives.presignGet(
      'archives/world.tar.gz',
      300,
      'browser',
      'Überwelt 🌞 backup.tar.gz',
    )
    const got = await fetch(link.url)
    expect(Buffer.from(await got.arrayBuffer()).equals(jar)).toBe(true)
    expect(got.headers.get('content-disposition')).toBe(
      `attachment; filename="?berwelt ?? backup.tar.gz"; filename*=UTF-8''%C3%9Cberwelt%20%F0%9F%8C%9E%20backup.tar.gz`,
    )
  })

  test('ingest stores verified bytes under their hash, once', async () => {
    const archives = store()
    const before = cdnRequests
    const key = await archives.ingestFromUrl(`${cdnUrl}/mod.jar`, sha512(jar))
    expect(key).toBe(`artifacts/${sha512(jar)}`)
    expect(await archives.head(key)).toEqual({ sizeBytes: jar.length })
    expect(await archives.ingestFromUrl(`${cdnUrl}/mod.jar`, sha512(jar).toUpperCase())).toBe(key)
    expect(cdnRequests - before).toBe(1)
  })

  test('bytes that are not the ones asked for never reach the store', async () => {
    const archives = store()
    const other = sha512(randomBytes(10))
    await expect(archives.ingestFromUrl(`${cdnUrl}/mod.jar`, other)).rejects.toBeInstanceOf(ArtifactMismatch)
    expect(await archives.head(`artifacts/${other}`)).toBeNull()
    const small = store({ maxIngestBytes: 1000 })
    const unseen = sha512(Buffer.concat([jar, Buffer.from('x')]))
    await expect(small.ingestFromUrl(`${cdnUrl}/mod.jar`, unseen)).rejects.toBeInstanceOf(ArtifactMismatch)
    await expect(archives.ingestFromUrl(`${cdnUrl}/missing.jar`, unseen)).rejects.toThrow(/404/)
    await expect(archives.ingestFromUrl(`${cdnUrl}/mod.jar`, 'not-a-hash')).rejects.toThrow(/sha512/)
  })

  test('head of nothing is null, and deleting twice is fine', async () => {
    const archives = store()
    await fetch((await archives.presignPut('gone.bin', 300, 'browser')).url, { method: 'PUT', body: jar })
    await archives.delete('gone.bin')
    await archives.delete('gone.bin')
    expect(await archives.head('gone.bin')).toBeNull()
  })

  test('an expired link is refused', async () => {
    const archives = store()
    const link = await archives.presignGet('uploads/one.jar', 1, 'browser')
    await new Promise((resolve) => setTimeout(resolve, 2100))
    expect((await fetch(link.url)).status).toBe(403)
  })
})

// A store that accepts the connection and then says nothing: under Node, which runs the control
// plane, every call fails in bounded time instead of holding a request, a job and a lock forever.
// Bun's node:http doesn't fire socket timeouts, so the check runs in a Node process.
const node = spawnSync('node', ['--version'], { encoding: 'utf8' })
const nodeRuns = node.status === 0 && /^v(2[3-9]|22\.(1[89]|[2-9]\d))/.test(node.stdout)

describe.skipIf(!nodeRuns)('a store that stops answering', () => {
  test('fails a call after the idle timeout, retries included', () => {
    const run = spawnSync(
      'node',
      [fileURLToPath(new URL('../../testing/silent-store.ts', import.meta.url))],
      {
        encoding: 'utf8',
        timeout: 30_000,
      },
    )
    expect(run.status).toBe(0)
    const ended = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as {
      outcome: string
      name?: string
      ms?: number
    }
    expect(ended).toMatchObject({ outcome: 'failed', name: 'TimeoutError' })
    // Three attempts of 0.7 s each, plus the SDK's backoff between them.
    expect(ended.ms).toBeLessThan(10_000)
  }, 40_000)
})
