// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worlds as people upload them, made by the tools they make them with: GNU tar for a server's
 * download, a zip for a folder sent from a desktop. What the import writes is read back by GNU tar,
 * as a server's restore reads it. Hostile tarballs are written header by header with node-tar's
 * own Header, so each lie is exactly the one meant.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { zipSync } from 'fflate'
import { Header } from 'tar'
import { HostileArchive, type TarballEntry } from '../../app/ports/formats.ts'
import { LibraryUploadArchives } from './world-archives.ts'

const run = promisify(execFile)
const archives = new LibraryUploadArchives()
const LIMITS = {
  maxFiles: 1000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  keep: (name: string) => name.endsWith('level.dat'),
  maxKeptBytes: 1024 * 1024,
}
const bytes = (text: string) => new TextEncoder().encode(text)

let scratch: string
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'blockly-world-archives-'))
})
afterAll(() => rm(scratch, { recursive: true, force: true }))

/** A folder of files on disk, as a player's or a server's is. */
async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(scratch, 'folder-'))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  return dir
}

/** Every file of an opened archive again, as the import reads them, by name. */
async function everyFile(path: string): Promise<Record<string, string>> {
  const world = await archives.openWorld(path, LIMITS)
  const read: Record<string, string> = {}
  for await (const file of world.entries()) read[file.name] = await new Response(file.data).text()
  await world.close()
  return read
}

/** A tarball whose headers say what a test needs, lies included. */
function rawTar(
  entries: Array<{
    path: string
    type?: 'File' | 'Link' | 'CharacterDevice'
    body?: string
    linkpath?: string
  }>,
): Uint8Array {
  const blocks: Buffer[] = []
  for (const { path, type = 'File', body = '', linkpath } of entries) {
    const data = Buffer.from(body)
    const header = new Header({ path, type, size: data.length, mode: 0o644, mtime: new Date(0), linkpath })
    const block = Buffer.alloc(512)
    header.encode(block, 0)
    blocks.push(block, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const WORLD = {
  'server.properties': 'level-name=world\n',
  'world/level.dat': 'level',
  'world/region/r.0.0.mca': 'chunks',
  'logs/latest.log': 'log',
}

describe('opening a world someone uploads', () => {
  test('a gzipped tarball GNU tar made, its small files kept and every file read again', async () => {
    const dir = await folder(WORLD)
    const path = join(scratch, 'server.tar.gz')
    await run('tar', ['-czf', path, '-C', dir, '.'])
    const world = await archives.openWorld(path, LIMITS)
    expect(world.files.map((file) => file.name).sort()).toEqual(Object.keys(WORLD).sort())
    expect(new TextDecoder().decode(world.kept.get('world/level.dat'))).toBe('level')
    expect(world.kept.size).toBe(1)
    await world.close()
    expect(await everyFile(path)).toEqual(WORLD)
  })

  test('a tarball that isn’t gzipped', async () => {
    const dir = await folder(WORLD)
    const path = join(scratch, 'server.tar')
    await run('tar', ['-cf', path, '-C', dir, '.'])
    expect(await everyFile(path)).toEqual(WORLD)
  })

  test('a zip, as a desktop makes one of a folder', async () => {
    const path = join(scratch, 'world.zip')
    await writeFile(
      path,
      zipSync({ 'My World/level.dat': bytes('level'), 'My World/region/r.0.0.mca': bytes('chunks') }),
    )
    expect(await everyFile(path)).toEqual({
      'My World/level.dat': 'level',
      'My World/region/r.0.0.mca': 'chunks',
    })
  })

  test('a file skipped half read lets the next one be read whole', async () => {
    const dir = await folder({ 'a.mca': 'x'.repeat(200_000), 'b/level.dat': 'level' })
    const path = join(scratch, 'skip.tar.gz')
    await run('tar', ['-czf', path, '-C', dir, 'a.mca', 'b'])
    const world = await archives.openWorld(path, LIMITS)
    const seen: Record<string, string> = {}
    for await (const file of world.entries()) {
      if (file.name === 'a.mca') await file.data.cancel()
      else seen[file.name] = await new Response(file.data).text()
    }
    expect(seen).toEqual({ 'b/level.dat': 'level' })
  })
})

describe('a server’s folder read again, some files skipped and some read', () => {
  test('hands over every file, whole, to its end', async () => {
    const dir = await folder({})
    const fixtures = `${import.meta.dir}/../../minecraft/world-fixtures/paper-1.21.11`
    const names = (await readFile(`${fixtures}/files.txt`, 'utf8')).trim().split('\n')
    // Its own small files as the server wrote them, the rest as stand-ins.
    const written = new Map<string, Buffer>()
    for (const name of names) {
      const bytes = await readFile(`${fixtures}/${name}`).catch(() =>
        Buffer.from(`${name} as the server wrote it`),
      )
      written.set(name, bytes)
      await run('mkdir', ['-p', join(dir, name, '..')])
      await writeFile(join(dir, name), bytes)
    }
    const path = join(scratch, 'every-other.tar.gz')
    await run('tar', ['-czf', path, '-C', dir, '.'])
    const archive = await archives.openWorld(path, LIMITS)
    const read: string[] = []
    let seen = 0
    for await (const file of archive.entries()) {
      // Every other file skipped, as a world's rewrite skips what isn't the world.
      if (seen++ % 2) await file.data.cancel()
      else {
        expect(new Uint8Array(await new Response(file.data).arrayBuffer())).toEqual(
          new Uint8Array(written.get(file.name) ?? []),
        )
        read.push(file.name)
      }
    }
    await archive.close()
    expect(seen).toBe(names.length)
    expect(read.length).toBe(Math.ceil(names.length / 2))
  }, 30_000)
})

describe('a tarball built to do harm is refused before anything is used', () => {
  const refused = async (tar: Uint8Array) => {
    const path = join(scratch, `${crypto.randomUUID()}.tar.gz`)
    await writeFile(path, tar)
    return archives.openWorld(path, LIMITS).then(
      () => null,
      (error: unknown) => (error instanceof HostileArchive ? error.reason : String(error)),
    )
  }

  test('one that climbs out of its folder', async () => {
    expect(await refused(rawTar([{ path: '../outside/level.dat', body: 'x' }]))).toBe('unsafe_name')
  })

  test('one with an absolute path', async () => {
    expect(await refused(rawTar([{ path: '/etc/cron.d/x', body: 'x' }]))).toBe('unsafe_name')
  })

  test('one with a link, made by GNU tar from a real one', async () => {
    const dir = await folder({ 'world/level.dat': 'level' })
    await symlink('/etc/passwd', join(dir, 'world', 'region'))
    const path = join(scratch, 'link.tar.gz')
    await run('tar', ['-czf', path, '-C', dir, '.'])
    expect(await refused(new Uint8Array(await Bun.file(path).arrayBuffer()))).toBe('link')
  })

  test('one with a hard link or a device', async () => {
    expect(
      await refused(
        rawTar([
          { path: 'a', body: 'x' },
          { path: 'b', type: 'Link', linkpath: 'a' },
        ]),
      ),
    ).toBe('link')
    expect(await refused(rawTar([{ path: 'dev', type: 'CharacterDevice' }]))).toBe('link')
  })

  test('one that holds a file twice, ignoring case, or a file under a file', async () => {
    expect(await refused(rawTar([{ path: 'Level.dat' }, { path: 'level.dat' }]))).toBe('duplicate')
    expect(await refused(rawTar([{ path: 'world' }, { path: 'world/level.dat' }]))).toBe('duplicate')
  })

  test('one with more files than a world has', async () => {
    const many = Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => ({ path: `f${i}` }))
    expect(await refused(rawTar(many))).toBe('too_many_files')
  })

  test('one that inflates far past its size', async () => {
    const path = join(scratch, 'bomb.tar.gz')
    const dir = await folder({})
    // Each within the size a file may be, together past what any world inflates to.
    await writeFile(join(dir, 'a.mca'), Buffer.alloc(40 * 1024 * 1024))
    await writeFile(join(dir, 'b.mca'), Buffer.alloc(40 * 1024 * 1024))
    await run('tar', ['-czf', path, '-C', dir, 'a.mca', 'b.mca'])
    expect(await refused(new Uint8Array(await Bun.file(path).arrayBuffer()))).toBe('bomb')
  })

  test('one that inflates past its size while a file it keeps is read is refused, not waited on', async () => {
    const path = join(scratch, 'bomb-kept.tar.gz')
    const dir = await folder({})
    // The meter trips inside the level.dat it is reading, as the world's own file is kept.
    await writeFile(join(dir, 'a.mca'), Buffer.alloc(40 * 1024 * 1024))
    await writeFile(join(dir, 'level.dat'), Buffer.alloc(30 * 1024 * 1024))
    await run('tar', ['-czf', path, '-C', dir, 'a.mca', 'level.dat'])
    const opened = archives.openWorld(path, { ...LIMITS, maxKeptBytes: 32 * 1024 * 1024 })
    const refusal = await Promise.race([
      opened.then(
        () => null,
        (error: unknown) => (error instanceof HostileArchive ? error.reason : String(error)),
      ),
      Bun.sleep(20_000).then(() => 'still waiting'),
    ])
    expect(refusal).toBe('bomb')
  }, 30_000)
})

describe('the tarball a world becomes', () => {
  test('GNU tar reads it as a server’s restore does: folders first, all the server user’s', async () => {
    const big = 'r'.repeat(3 * 1024 * 1024)
    async function* entries(): AsyncIterable<TarballEntry> {
      yield { name: 'server.properties', sizeBytes: 17, data: bytes('level-name=world\n') }
      yield { name: 'world/level.dat', sizeBytes: 5, data: bytes('level') }
      yield {
        name: 'world/region/r.0.0.mca',
        sizeBytes: big.length,
        data: new Response(big).body as ReadableStream,
      }
    }
    const path = join(scratch, 'made.tar.gz')
    await Bun.write(path, new Response(archives.tarball(entries())))
    const { stdout } = await run('tar', ['--numeric-owner', '-tvzf', path])
    const lines = stdout.trim().split('\n')
    expect(lines.map((line) => line.split(/\s+/).at(-1))).toEqual([
      'server.properties',
      'world/',
      'world/level.dat',
      'world/region/',
      'world/region/r.0.0.mca',
    ])
    for (const line of lines) expect(line.split(/\s+/)[1]).toBe('1000/1000')
    const out = await mkdtemp(join(scratch, 'out-'))
    await run('tar', ['-xzf', path, '-C', out])
    expect(await Bun.file(join(out, 'world/region/r.0.0.mca')).text()).toBe(big)
  })

  test('a file that isn’t the size it said fails the tarball rather than write a wrong one', async () => {
    async function* entries(): AsyncIterable<TarballEntry> {
      yield { name: 'level.dat', sizeBytes: 10, data: bytes('short') }
    }
    expect(new Response(archives.tarball(entries())).arrayBuffer()).rejects.toThrow('not the 10 it said')
  })
})

describe('a tarball left before its end', () => {
  test('lets go of the world it was reading, and of its own writing, at once', async () => {
    const dir = await folder({
      'world/level.dat': 'level',
      'world/region/r.0.0.mca': 'r'.repeat(4 * 1024 * 1024),
    })
    const path = join(scratch, 'left.tar.gz')
    await run('tar', ['-czf', path, '-C', dir, '.'])
    const world = await archives.openWorld(path, LIMITS)
    async function* entries(): AsyncIterable<TarballEntry> {
      for await (const file of world.entries())
        yield { name: file.name, sizeBytes: file.sizeBytes, data: file.data }
    }
    const reader = archives.tarball(entries()).getReader()
    await reader.read()
    const settled = reader.cancel().then(() => 'settled')
    expect(await Promise.race([settled, Bun.sleep(5000).then(() => 'still waiting')])).toBe('settled')
  })
})
