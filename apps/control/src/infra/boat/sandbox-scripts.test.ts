// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../../testing/memory-store.ts'
import { script, scriptOnNew, type Verb } from './sandbox-scripts.ts'

const MIB = 1024 ** 2

// The sandbox's program itself, run by bash against a directory standing in for Docker's volumes,
// with `sudo` and `docker` that do nothing a test machine would mind.
describe('the sandbox program’s snapshot', () => {
  let root: string
  let volumes: string
  let shims: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'blockly-boat-program-'))
    volumes = join(root, 'volumes')
    shims = join(root, 'bin')
    await mkdir(join(volumes, 'blockly-data', '_data', 'world'), { recursive: true })
    await mkdir(join(volumes, 'blockly-snapshots', '_data'), { recursive: true })
    await writeFile(join(volumes, 'blockly-data', '_data', 'world', 'level.dat'), 'a world')
    await mkdir(shims)
    await writeFile(join(shims, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n')
    await writeFile(join(shims, 'docker'), '#!/bin/sh\nexit 0\n')
    await chmod(join(shims, 'sudo'), 0o755)
    await chmod(join(shims, 'docker'), 0o755)
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const run = (file: string, roomBytes: string, keeps = String(2 ** 50)) =>
    Bun.spawnSync(['bash', '-c', script('snapshot', file, keeps)], {
      env: {
        ...process.env,
        PATH: `${shims}:${process.env.PATH}`,
        BLOCKLY_VOLUMES: volumes,
        BLOCKLY_ROOM_BYTES: roomBytes,
      },
    })
      .stdout.toString()
      .trim()

  test('archives the world beside it when there is room', async () => {
    expect(run('a.tar.gz', '0')).toMatch(/^ok \d+$/)
    expect(await readdir(join(volumes, 'blockly-snapshots', '_data'))).toEqual(['a.tar.gz'])
  })

  test('refuses plainly, writing nothing, when the disk would be left without room', async () => {
    expect(run('b.tar.gz', String(2 ** 60))).toMatch(
      /^failed there isn't room for a snapshot: the world takes \d+ MB and \d+ MB are free$/,
    )
    expect(await readdir(join(volumes, 'blockly-snapshots', '_data'))).toEqual(['a.tar.gz'])
  })

  test('waits for Docker on a sandbox just woken for it, before touching a volume', async () => {
    // Docker answers from its second asking on, as one coming back after a resume.
    const slow = join(root, 'slow-bin')
    await mkdir(slow)
    await writeFile(join(slow, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n')
    await writeFile(
      join(slow, 'docker'),
      `#!/bin/sh\nif [ ! -f ${root}/docker-up ]; then [ "$1" = info ] && touch ${root}/docker-up; exit 1; fi\nexit 0\n`,
    )
    await chmod(join(slow, 'sudo'), 0o755)
    await chmod(join(slow, 'docker'), 0o755)
    const said = Bun.spawnSync(['bash', '-c', script('snapshot', 'd.tar.gz', String(2 ** 50))], {
      env: {
        ...process.env,
        PATH: `${slow}:${process.env.PATH}`,
        BLOCKLY_VOLUMES: volumes,
        BLOCKLY_ROOM_BYTES: '0',
      },
    })
    expect(said.stdout.toString().trim()).toMatch(/^ok \d+$/)
    await rm(join(volumes, 'blockly-snapshots', '_data', 'd.tar.gz'))
  })

  test('archives again when a file still streaming back fails the first read', async () => {
    const flaky = join(root, 'flaky-bin')
    await mkdir(flaky)
    await writeFile(
      join(flaky, 'sudo'),
      `#!/bin/sh\n[ "$1" = -n ] && shift\nif [ "$1" = tar ] && [ ! -f ${root}/read-once ]; then touch ${root}/read-once; echo 'tar: ./world/level.dat: Input/output error' >&2; exit 2; fi\nexec "$@"\n`,
    )
    await writeFile(join(flaky, 'docker'), '#!/bin/sh\nexit 0\n')
    await chmod(join(flaky, 'sudo'), 0o755)
    await chmod(join(flaky, 'docker'), 0o755)
    const said = Bun.spawnSync(['bash', '-c', script('snapshot', 'e.tar.gz', String(2 ** 50))], {
      env: {
        ...process.env,
        PATH: `${flaky}:${process.env.PATH}`,
        BLOCKLY_VOLUMES: volumes,
        BLOCKLY_ROOM_BYTES: '0',
      },
    })
    expect(said.stdout.toString().trim()).toMatch(/^ok \d+$/)
    expect(await readdir(join(volumes, 'blockly-snapshots', '_data'))).toContain('e.tar.gz')
    await rm(join(volumes, 'blockly-snapshots', '_data', 'e.tar.gz'))
  }, 20_000)

  test('refuses one that would take the server past what Boat keeps of its sandbox', async () => {
    expect(run('c.tar.gz', '0', '1')).toMatch(
      /^failed a snapshot would take the server past what its sandbox keeps: \d+ MB of 0 MB used$/,
    )
    expect(await readdir(join(volumes, 'blockly-snapshots', '_data'))).toEqual(['a.tar.gz'])
  })
})

// The export, run by bash with the machine's own curl and dd against a store in this process: a
// snapshot one PUT carries goes whole, a larger one is left for `export-parts`, which sends it.
describe('the sandbox program’s export', () => {
  const store = new MemoryStore()
  let root: string
  let volumes: string
  let shims: string
  let archive: Buffer
  let sha: string

  beforeAll(async () => {
    await store.start()
    root = await mkdtemp(join(tmpdir(), 'blockly-boat-export-'))
    volumes = join(root, 'volumes')
    shims = join(root, 'bin')
    await mkdir(join(volumes, 'blockly-snapshots', '_data'), { recursive: true })
    await mkdir(shims)
    await writeFile(join(shims, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n')
    await writeFile(join(shims, 'docker'), '#!/bin/sh\nexit 0\n')
    await chmod(join(shims, 'sudo'), 0o755)
    await chmod(join(shims, 'docker'), 0o755)
    // Bytes that don't compress, 20 MiB and a little: three parts of 8 MiB, the last shorter.
    archive = randomBytes(20 * MIB + 12_345)
    sha = createHash('sha256').update(archive).digest('hex')
    await writeFile(join(volumes, 'blockly-snapshots', '_data', 'w.tar.gz'), archive)
  })

  afterAll(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })

  // Spawned, not run synchronously: the store answering the uploads is in this process.
  async function run(verb: Verb, ...args: string[]): Promise<string> {
    const child = Bun.spawn(['bash', '-c', script(verb, ...args)], {
      env: { ...process.env, PATH: `${shims}:${process.env.PATH}`, BLOCKLY_VOLUMES: volumes },
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const said = await new Response(child.stdout).text()
    await child.exited
    return said.trim().split('\n').at(-1) ?? ''
  }

  test('one PUT carries a snapshot no larger than it, and the store holds it whole', async () => {
    const target = await store.archiveTarget('archives/whole')
    expect(await run('export', 'w.tar.gz', target.put.url, String(archive.length))).toBe(
      `ok ${sha} ${archive.length}`,
    )
    expect(store.objects.get('archives/whole')?.equals(archive)).toBe(true)
  })

  test('a larger one is sent in parts, each with its length, and joins into the same bytes', async () => {
    const target = await store.archiveTarget('archives/parts')
    expect(await run('export', 'w.tar.gz', target.put.url, String(10 * MIB))).toBe(
      `ok parts ${sha} ${archive.length}`,
    )
    expect(store.objects.has('archives/parts')).toBe(false)
    const parts = await target.inParts(archive.length, 16)
    expect(parts.partSize).toBe(8 * MIB)
    const said = await run(
      'export-parts',
      'w.tar.gz',
      '8',
      String(archive.length),
      parts.urls.slice(0, 3).join('\n'),
    )
    const put = said
      .slice(3)
      .split(' ')
      .map((pair) => ({ number: Number(pair.split('=')[0]), etag: pair.slice(pair.indexOf('=') + 1) }))
    expect(put.map((part) => part.number)).toEqual([1, 2, 3])
    await parts.complete(put)
    expect(store.objects.get('archives/parts')?.equals(archive)).toBe(true)
  })

  test('a part the store refuses is tried three times, then fails the verb', async () => {
    const target = await store.archiveTarget('archives/refused')
    const parts = await target.inParts(archive.length, 16)
    // An upload the store no longer knows: every part is refused.
    await parts.abort()
    const said = await run(
      'export-parts',
      'w.tar.gz',
      '8',
      String(archive.length),
      parts.urls.slice(0, 3).join('\n'),
    )
    expect(said).toBe('failed uploading part 1')
  }, 30_000)
})

// The wait for what a resume brings back, run by bash with a `docker` whose container is missing
// until it has been looked at a number of times, as Boat's comes back some time into a resume. Like
// Docker, it prints an empty line for a container it doesn't have, as well as failing.
describe('the sandbox program’s wait for a resumed sandbox’s workload', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'blockly-boat-settle-'))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** `stop` (which settles first) on a sandbox whose container is back after `back` looks. */
  async function stop(
    name: string,
    back: number,
    options: { part?: number; since?: number; isNew?: boolean },
  ) {
    const dir = join(root, name)
    await mkdir(join(dir, 'bin'), { recursive: true })
    await writeFile(
      join(dir, 'bin', 'docker'),
      `#!/bin/sh\ncase "$1" in\n  inspect) n=$(($(cat ${dir}/looks 2>/dev/null || echo 0) + 1)); echo $n > ${dir}/looks; [ $n -gt ${back} ] && echo exited && exit 0; echo; exit 1;;\nesac\nexit 0\n`,
    )
    await chmod(join(dir, 'bin', 'docker'), 0o755)
    if (options.since !== undefined) await writeFile(join(dir, 'since'), String(options.since))
    const said = Bun.spawnSync(['bash', '-c', options.isNew ? scriptOnNew('stop') : script('stop')], {
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        BLOCKLY_SETTLE_SECONDS: '100',
        BLOCKLY_SETTLE_PART_SECONDS: String(options.part ?? 60),
        BLOCKLY_SETTLE_SINCE: join(dir, 'since'),
      },
    })
    const looks = Number(await readFile(join(dir, 'looks'), 'utf8').catch(() => '0'))
    const since = await readFile(join(dir, 'since'), 'utf8').catch(() => null)
    return { said: said.stdout.toString().trim().split('\n').at(-1), looks, since }
  }

  test('touches nothing until Boat has brought the container back', async () => {
    const { said, looks, since } = await stop('back', 2, {})
    expect(said).toBe('ok stopped')
    expect(looks).toBeGreaterThan(2)
    expect(Number(since)).toBeGreaterThan(Date.now() / 1000 - 60)
  }, 20_000)

  test('answers "wait" once one command has waited its part, to be asked again', async () => {
    const { said } = await stop('part', 1000, { part: 1 })
    expect(said).toBe('wait the sandbox is still bringing its workload back')
  }, 20_000)

  test('waits no longer once the whole wait, counted from the first look, is spent', async () => {
    const { said, looks } = await stop('spent', 1000, { since: Math.floor(Date.now() / 1000) - 101 })
    expect(said).toBe('ok stopped')
    expect(looks).toBeLessThan(5)
  }, 20_000)

  test('never waits on a sandbox Boat never saved, with nothing coming back', async () => {
    const { said, looks, since } = await stop('new', 1000, { isNew: true })
    expect(said).toBe('ok stopped')
    expect(looks).toBeLessThan(5)
    expect(since).toBeNull()
  }, 20_000)
})
