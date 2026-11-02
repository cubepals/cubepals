// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Fetch progress reports cumulative bytes actually written, including the final chunk. */
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryUploadArchives } from './world-archives.ts'

test('a real streamed download reports its consumed bytes and preserves the file and digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'download-progress-'))
  const body = new Uint8Array(256 * 1024).map((_, index) => index % 251)
  const server = Bun.serve({ port: 0, fetch: () => new Response(body) })
  const observed: number[] = []
  try {
    const path = join(dir, 'world.bin')
    const result = await new LibraryUploadArchives().fetchTo(
      `http://127.0.0.1:${server.port}/world`,
      path,
      body.length,
      {
        progress: async (bytes) => {
          observed.push(bytes)
        },
      },
    )
    expect(result).toEqual({
      sizeBytes: body.length,
      sha512: createHash('sha512').update(body).digest('hex'),
    })
    expect(await readFile(path)).toEqual(Buffer.from(body))
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.at(-1)).toBe(body.length)
    for (let index = 1; index < observed.length; index++)
      expect(observed[index]).toBeGreaterThan(observed[index - 1] ?? 0)
  } finally {
    server.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
})
