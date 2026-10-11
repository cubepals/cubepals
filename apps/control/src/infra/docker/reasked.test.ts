// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Asking the daemon again, against a fake one on a unix socket whose first answer to each call
 * sends its headers and all of its body, then never ends: what Bun's node:http client sometimes
 * makes of a real daemon's answer.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { ensureImage } from './docker-runtime/images.ts'
import { reasked } from './reasked.ts'

const SOCKET = join(tmpdir(), `blockly-reasked-${process.pid}.sock`)
const FAST = { firstMs: 100, longestMs: 400 }
const asked: string[] = []
let imagePresent = false

function answer(path: string, res: ServerResponse): void {
  const times = asked.filter((p) => p === path).length
  const first = times === 1
  if (path.endsWith('/logs')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' })
    res.write(`answer ${times}`)
    if (!first) res.end()
  } else if (path === '/images/create') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write(`${JSON.stringify({ status: 'Pulling' })}\n`)
    // The image lands with the last line; the answer to the first pull still never ends.
    imagePresent = true
    res.write(`${JSON.stringify({ status: 'Downloaded newer image' })}\n`)
    if (!first) res.end()
  } else if (path.startsWith('/images/')) {
    res.writeHead(imagePresent ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(imagePresent ? { Id: 'sha256:1' } : { message: 'No such image' }))
  } else {
    res.writeHead(404).end()
  }
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://docker').pathname
  asked.push(path)
  answer(path, res)
})
const docker = new Docker({ socketPath: SOCKET })

beforeAll(async () => {
  rmSync(SOCKET, { force: true })
  await new Promise<void>((resolve) => server.listen(SOCKET, resolve))
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(SOCKET, { force: true })
})
beforeEach(() => {
  asked.length = 0
  imagePresent = false
})

test('a reply that never ends is dropped and asked again', async () => {
  const target = docker.getContainer('c1')
  const logs = await reasked(
    ({ signal }) => target.logs({ stdout: true, stderr: true, follow: false, abortSignal: signal }),
    undefined,
    FAST,
  )
  expect(String(logs)).toBe('answer 2')
  expect(asked).toEqual(['/containers/c1/logs', '/containers/c1/logs'])
})

test('a call that keeps showing life is left to finish', async () => {
  let asks = 0
  const value = await reasked(
    async ({ alive }) => {
      asks++
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(40)
        alive()
      }
      return 'done'
    },
    undefined,
    FAST,
  )
  expect(value).toBe('done')
  expect(asks).toBe(1)
})

test('each ask is given longer than the one before, up to the ceiling', async () => {
  const started: number[] = []
  const at = Date.now()
  const value = await reasked(
    async () => {
      started.push(Date.now() - at)
      if (started.length < 5) return new Promise<never>(() => undefined)
      return 'answered'
    },
    undefined,
    FAST,
  )
  expect(value).toBe('answered')
  const gaps = started.slice(1).map((ms, i) => ms - (started[i] ?? 0))
  // 100, 200, 400, then 400 again: the ceiling. A busy machine only makes a gap longer.
  ;[100, 200, 400, 400].forEach((ms, i) => {
    expect(gaps[i]).toBeGreaterThanOrEqual(ms - 5)
    expect(gaps[i]).toBeLessThan(ms * 2)
  })
})

test('giving up drops the ask in hand and fails with the reason', async () => {
  const within = new AbortController()
  let dropped: AbortSignal | undefined
  const failing = reasked(
    ({ signal }) => {
      dropped = signal
      return new Promise<never>(() => undefined)
    },
    within.signal,
    FAST,
  )
  setTimeout(() => within.abort(new Error('too long')), 50)
  await expect(failing).rejects.toThrow('too long')
  expect(dropped?.aborted).toBe(true)
})

test('a pull whose progress never ends is asked again and finds its image', async () => {
  await ensureImage(docker, 'game:1')
  expect(asked).toEqual(['/images/game:1/json', '/images/create', '/images/game:1/json'])
}, 20_000)
