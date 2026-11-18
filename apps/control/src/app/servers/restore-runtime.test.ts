// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world brought back from its archive inside the server's machine, run the way a start runs the
 * step: in this machine's sh (dash, as the image's Ubuntu builds have it), against a folder standing
 * in for the volume and a local server standing in for the store, which answers a ranged request as
 * the store does. A machine without zstd (this one may be) gets a stand-in that inflates stdin as
 * `zstd -dcq` does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, constants as zlib, zstdCompressSync } from 'node:zlib'
import {
  RESTORE_FAILED_EXIT,
  RESTORE_STEP,
  RESTORED_MARK,
  RESTORING_MARK,
  restoreEnv,
  stoppedByRestore,
} from '../../minecraft/restore-step.ts'
import { UNLINKED } from '../../minecraft/volume-links.ts'
import { NOT_ARCHIVED } from '../ports/runtime.ts'

/** Whether this run is root's, as the step's is in a machine. */
const ROOT = process.getuid?.() === 0
let root = ''
let shims = ''
let fetched = 0
let store: Bun.Server<undefined>
const served = new Map<string, Buffer>()
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** A world as a volume holds it, packed with `tar` and these options. */
async function packed(name: string, options: string[] = []): Promise<Buffer> {
  const world = join(root, `${name}-world`)
  await mkdir(join(world, 'world'), { recursive: true })
  await writeFile(join(world, 'world', 'level.dat'), 'the archived world')
  await writeFile(join(world, 'server.properties'), 'motd=back')
  await symlink('/etc/passwd', join(world, 'outside'))
  const out = join(root, `${name}.tar`)
  const tar = Bun.spawnSync(['tar', ...options, '-cf', out, '-C', world, '.'])
  if (tar.exitCode !== 0) throw new Error('tar failed')
  return readFile(out)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'in-machine-'))
  shims = join(root, 'bin')
  const tar = await packed('plain')
  served.set('/world.tgz', gzipSync(tar))
  served.set('/world.tzst', zstdCompressSync(tar))
  // Whole tar inside, a wrong checksum around it: gzip's CRC-32, zstd's content checksum.
  const crc = gzipSync(tar)
  crc[crc.length - 8] = (crc.at(-8) ?? 0) ^ 0xff
  served.set('/crc.tgz', crc)
  const sum = zstdCompressSync(tar, { params: { [zlib.ZSTD_c_checksumFlag]: 1 } })
  sum[sum.length - 1] = (sum.at(-1) ?? 0) ^ 0xff
  served.set('/sum.tzst', sum)
  // Whole and valid, its last record zeros past tar's end: tar is done before gzip is.
  served.set('/pad.tgz', gzipSync(await packed('pad', ['-b', '512'])))
  served.set('/neither', Buffer.from('neither gzip nor zstd, at any length'))
  store = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      fetched += 1
      const body = served.get(new URL(request.url).pathname)
      // An expired presigned link: the store refuses it, as S3 does, with 403.
      if (new URL(request.url).pathname === '/expired.tgz') return new Response(null, { status: 403 })
      if (body === undefined) return new Response(null, { status: 404 })
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? '')
      if (range === null) return new Response(body)
      return new Response(body.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 })
    },
  })
  await mkdir(shims)
  if (Bun.spawnSync(['sh', '-c', 'command -v zstd']).exitCode !== 0) {
    await writeFile(
      join(shims, 'zstd'),
      `#!/bin/sh\nexec ${process.execPath} -e 'process.stdout.write(require("node:zlib").zstdDecompressSync(require("node:fs").readFileSync(0)))'\n`,
    )
    await chmod(join(shims, 'zstd'), 0o755)
  }
  // The step runs as root in a machine, where it gives the volume to root. A run as anyone else, as
  // CI's, can't: a stand-in takes the call, and only root's run checks who owns it.
  if (!ROOT) {
    await writeFile(join(shims, 'chown'), '#!/bin/sh\nexit 0\n')
    await chmod(join(shims, 'chown'), 0o755)
  }
})

afterAll(async () => {
  store.stop(true)
  await rm(root, { recursive: true, force: true })
})

/** A volume as Fly makes a new one: empty but for `lost+found`. */
async function volume(): Promise<string> {
  const data = await mkdtemp(join(root, 'volume-'))
  await mkdir(join(data, 'lost+found'))
  return data
}

/** Runs the step on `data` with the archive at `name`, checked against `hash`; its exit. */
async function start(data: string, name: string, hash: string = sha256(served.get(name) ?? Buffer.alloc(0))) {
  const env = name === '' ? {} : restoreEnv(`http://127.0.0.1:${store.port}${name}`, hash)
  // As a start runs it: after what replaces a link where a step writes (`runtime-spec.ts`).
  const script = `${UNLINKED} ${RESTORE_STEP}`
    .replaceAll('/tmp/blockly-restore', `${data}-work`)
    .replaceAll('/data', data)
  return Bun.spawn(['/bin/sh', '-c', script], {
    env: { PATH: `${shims}:${process.env.PATH}`, ...env },
    stderr: 'ignore',
  }).exited
}

const listed = async (data: string) => (await readdir(data)).sort()

describe('a world brought back in its own machine', () => {
  test('a gzip archive and a zstd one each fill an empty volume, checked, and say they are done', async () => {
    for (const name of ['/world.tgz', '/world.tzst', '/pad.tgz']) {
      const data = await volume()
      expect(await start(data, name)).toBe(0)
      expect(await listed(data)).toEqual([RESTORED_MARK, 'lost+found', 'server.properties', 'world'])
      expect(await readFile(join(data, 'world', 'level.dat'), 'utf8')).toBe('the archived world')
      if (ROOT) expect((await stat(data)).uid).toBe(0)
    }
  })

  test('takes out a link the archive held, as the helper does', async () => {
    const data = await volume()
    expect(await start(data, '/world.tgz')).toBe(0)
    await expect(lstat(join(data, 'outside'))).rejects.toThrow()
  })

  test('a start after it is done fetches nothing and changes nothing', async () => {
    const data = await volume()
    expect(await start(data, '/world.tgz')).toBe(0)
    await writeFile(join(data, 'world', 'level.dat'), 'played since')
    const before = fetched
    expect(await start(data, '/world.tgz')).toBe(0)
    expect(fetched).toBe(before)
    expect(await readFile(join(data, 'world', 'level.dat'), 'utf8')).toBe('played since')
  })

  test('a sha256 that isn’t the archive’s fails the restore, leaves nothing, and a later try fills it', async () => {
    const data = await volume()
    expect(await start(data, '/world.tgz', '0'.repeat(64))).toBe(RESTORE_FAILED_EXIT)
    expect(await listed(data)).toEqual([RESTORING_MARK, 'lost+found'])
    expect(await start(data, '/world.tgz')).toBe(0)
    expect(await listed(data)).toEqual([RESTORED_MARK, 'lost+found', 'server.properties', 'world'])
  })

  test('a checksum of its own that is wrong, or bytes that are neither, fail it', async () => {
    for (const name of ['/crc.tgz', '/sum.tzst', '/neither', '/gone.tgz']) {
      const data = await volume()
      expect(await start(data, name)).toBe(RESTORE_FAILED_EXIT)
      expect(await listed(data)).toEqual([RESTORING_MARK, 'lost+found'])
    }
  })

  test('a try cut short is started over on an emptied volume', async () => {
    const data = await volume()
    await writeFile(join(data, RESTORING_MARK), '')
    await writeFile(join(data, 'half-written.mca'), 'partial')
    expect(await start(data, '/world.tgz')).toBe(0)
    expect(await listed(data)).toEqual([RESTORED_MARK, 'lost+found', 'server.properties', 'world'])
  })

  test('a link at either mark is taken away before root reads or writes it; what it named is untouched', async () => {
    const outside = join(root, 'outside-the-volume')
    await writeFile(outside, 'not the volume’s')
    // A server that took the done mark away and put links where both marks go, once its world was back.
    const data = await volume()
    expect(await start(data, '/world.tgz')).toBe(0)
    await rm(join(data, RESTORED_MARK))
    await symlink(outside, join(data, RESTORING_MARK))
    await symlink(outside, join(data, RESTORED_MARK))
    await start(data, '/world.tgz')
    expect(await readFile(outside, 'utf8')).toBe('not the volume’s')
    // Both links gone, and a world there: left as it is, nothing written.
    expect(await listed(data)).toEqual(['lost+found', 'server.properties', 'world'])
  })

  test('a volume holding anything else is left as it is, and nothing is fetched', async () => {
    const data = await volume()
    await mkdir(join(data, 'world'))
    await writeFile(join(data, 'world', 'level.dat'), 'a world already here')
    const before = fetched
    expect(await start(data, '/world.tgz')).toBe(0)
    expect(fetched).toBe(before)
    expect(await readFile(join(data, 'world', 'level.dat'), 'utf8')).toBe('a world already here')
  })

  test('a link that answers no more, as an expired one, fails it as a restore; a start with no restore does nothing', async () => {
    const expired = await volume()
    expect(await start(expired, '/expired.tgz', sha256(served.get('/world.tgz') ?? Buffer.alloc(0)))).toBe(
      RESTORE_FAILED_EXIT,
    )
    expect(await listed(expired)).toEqual([RESTORING_MARK, 'lost+found'])
    const plain = await volume()
    expect(await start(plain, '')).toBe(0)
    expect(await listed(plain)).toEqual(['lost+found'])
  })
})

test('the marks are never archived, and a sha256 is checked before it reaches the step', () => {
  expect(NOT_ARCHIVED).toContain(RESTORING_MARK)
  expect(NOT_ARCHIVED).toContain(RESTORED_MARK)
  expect(() => restoreEnv('https://store.example/a.tgz', 'abc; rm -rf /')).toThrow("isn't a sha256")
})

test('a start the step stopped reads as a restore that failed, a crash after it or a run started again alike', () => {
  expect(stoppedByRestore({ exit: { code: RESTORE_FAILED_EXIT, oom: false } })).toBe(true)
  expect(stoppedByRestore({ failedCode: RESTORE_FAILED_EXIT })).toBe(true)
  expect(stoppedByRestore({ exit: { code: 1, oom: false } })).toBe(false)
  expect(stoppedByRestore({ failedCode: 1 })).toBe(false)
  expect(stoppedByRestore({})).toBe(false)
  expect(stoppedByRestore(null)).toBe(false)
})
