// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Indexes real node-tar archives and leaves extensions or damaged layouts to the strict reader. */
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create, Header } from 'tar'
import { indexedBody, indexTar } from './indexed-tar.ts'

async function archive(run: (dir: string, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'indexed-tar-'))
  const path = join(dir, 'world.tar')
  await mkdir(join(dir, 'world'))
  try {
    await run(dir, path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('offsets retrieve the original bytes, empty entries and exact entry limits', () =>
  archive(async (dir, path) => {
    const opaque = new Uint8Array(1024 * 1024 + 3).fill(7)
    await writeFile(join(dir, 'world/level.dat'), 'level')
    await writeFile(join(dir, 'world/empty'), '')
    await writeFile(join(dir, 'world/opaque.bin'), opaque)
    await create({ cwd: dir, file: path, gzip: false, portable: true }, ['world'])
    const entries = await indexTar(path, 4)
    expect(entries).not.toBeNull()
    if (entries === null) throw new Error('An ordinary archive must be indexed')
    expect(entries.map((entry) => entry.header.path).sort()).toEqual([
      'world/',
      'world/empty',
      'world/level.dat',
      'world/opaque.bin',
    ])
    for (const entry of entries) {
      const data = new Uint8Array(await new Response(indexedBody(path, entry)).arrayBuffer())
      const expected =
        entry.header.path === 'world/level.dat'
          ? Buffer.from('level')
          : entry.header.path === 'world/opaque.bin'
            ? opaque
            : new Uint8Array()
      expect(data).toEqual(new Uint8Array(expected))
    }
    expect(await indexTar(path, entries.length - 1)).toBeNull()
    expect(await indexTar(path, entries.length)).not.toBeNull()
    const body = entries.find((entry) => entry.header.path === 'world/opaque.bin')
    if (body === undefined) throw new Error('The opaque entry must exist')
    const reader = indexedBody(path, body).getReader()
    const first = await reader.read()
    expect(first.value?.length).toBeLessThan(opaque.length)
    await reader.cancel()
  }))

test('a damaged checksum and a truncated payload cannot establish a usable index', () =>
  archive(async (dir, path) => {
    await writeFile(join(dir, 'world/opaque.bin'), new Uint8Array(64 * 1024).fill(1))
    await create({ cwd: dir, file: path, gzip: false, portable: true }, ['world'])
    const bytes = await readFile(path)
    const changed = Buffer.from(bytes)
    changed[0] = (changed[0] ?? 0) ^ 1
    await writeFile(path, changed)
    expect(await indexTar(path, 10)).toBeNull()
    await writeFile(path, bytes.subarray(0, Math.floor(bytes.length / 2)))
    expect(await indexTar(path, 10)).toBeNull()
    await writeFile(path, new Uint8Array())
    expect(await indexTar(path, 10)).toBeNull()
  }))

test('long-name extensions and links use the full parser', () =>
  archive(async (dir, path) => {
    const long = 'x'.repeat(160)
    await writeFile(join(dir, 'world', long), 'extended')
    await create({ cwd: dir, file: path, gzip: false, portable: true }, ['world'])
    expect(await indexTar(path, 10)).toBeNull()
    await rm(join(dir, 'world', long))
    await symlink('../elsewhere', join(dir, 'world/link'))
    await create({ cwd: dir, file: path, gzip: false, portable: true }, ['world'])
    expect(await indexTar(path, 10)).toBeNull()
  }))

test('single zero blocks are not an end marker and truncated framing falls back', () =>
  archive(async (_dir, path) => {
    const block = Buffer.alloc(512)
    new Header({ path: 'world/level.dat', type: 'File', size: 0 }).encode(block)
    await writeFile(path, Buffer.concat([Buffer.alloc(512), block, Buffer.alloc(1024)]))
    expect((await indexTar(path, 10))?.map((entry) => entry.header.path)).toEqual(['world/level.dat'])
    await writeFile(path, Buffer.concat([block, Buffer.alloc(512), block, Buffer.alloc(1024)]))
    expect((await indexTar(path, 10))?.length).toBe(2)
    await writeFile(path, Buffer.concat([block, Buffer.alloc(512)]))
    expect(await indexTar(path, 10)).toBeNull()
    const oversized = Buffer.alloc(512)
    new Header({ path: 'world/level.dat', type: 'File', size: 4096 }).encode(oversized)
    await writeFile(path, Buffer.concat([oversized, Buffer.alloc(1024)]))
    expect(await indexTar(path, 10)).toBeNull()
  }))

test.each(['OldFile', 'ContiguousFile'] as const)(
  'ordinary %s tar entries retain indexed body bytes',
  (type) =>
    archive(async (_dir, path) => {
      const header = Buffer.alloc(512)
      new Header({ path: 'world/level.dat', type, size: 5 }).encode(header)
      await writeFile(path, Buffer.concat([header, Buffer.from('level'), Buffer.alloc(507 + 1024)]))
      const entries = await indexTar(path, 1)
      expect(entries?.length).toBe(1)
      const entry = entries?.[0]
      if (entry === undefined) throw new Error('An ordinary tar file must be indexed')
      expect(await new Response(indexedBody(path, entry)).text()).toBe('level')
    }),
)
