// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeHandle, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { RuntimeUnsupported } from '../../app/ports/runtime.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { FakeRuntime, fakeHandleKey } from './fake-runtime.ts'

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'blockly-fake-runtime-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const spec: RuntimeSpec = {
  image: 'image',
  env: {},
  secrets: {},
  resources: { memoryMb: 3072 },
  storage: { mountPath: '/data', sizeGb: 3 },
  ports: [{ name: 'game', port: 25565, protocol: 'tcp', audience: ['edge', 'control'] }],
  stop: { signal: 'SIGTERM', timeoutSeconds: 60 },
  labels: {},
}

// What every adapter's restart is, beside Boat's: boot restarts a workload through it, and one
// that won't stop is killed and started again rather than failing the boot (it used to throw).
test('a restart kills a workload that won’t stop, then starts it on the same compute', async () => {
  const runtime = new FakeRuntime({ deploymentId: 'test', root, regionMap: { local: 'fake-1' } })
  const key = '0f3a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b' as RuntimeKey
  const handle = await runtime.ensureProvisioned(key, { regionKey: 'local' }, spec, {
    step: async () => {},
    handle: async () => {},
  })
  runtime.failStops('the machine did not stop in time')
  await expect(runtime.stop(handle)).rejects.toThrow(/did not stop/)
  await runtime.restart(handle)
  expect((await runtime.observe(handle)).state).toBe('running')
  expect(await runtime.start(handle)).toBe(handle)
})

// ─── What the rest of the suite stands on, pinned before the runtime was taken apart ─────────────

const quiet = { step: async () => {}, handle: async () => {} }
let made = 0

/** A runtime of its own, under a root of its own, so what it leaves on disk can be looked at. */
async function fresh(options: { provider?: string; deploymentId?: string; root?: string } = {}) {
  const dir = options.root ?? (await mkdtemp(join(root, 'runtime-')))
  const runtime = new FakeRuntime({
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    deploymentId: options.deploymentId ?? 'test',
    root: dir,
    regionMap: { local: 'fake-1' },
  })
  return { runtime, root: dir }
}

async function provision(runtime: FakeRuntime) {
  const key = `server-${++made}` as RuntimeKey
  const handle = await runtime.ensureProvisioned(key, { regionKey: 'local' }, spec, quiet)
  const dir = runtime.machine(key)?.dir ?? ''
  return { key, handle, dir }
}

/** Whether a promise has settled by the time everything queued before this call has run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  return done
}

describe('handles', () => {
  test('each provider owns only what it issued, and says so in its own words', async () => {
    const { runtime, root: shared } = await fresh()
    const { runtime: other } = await fresh({ provider: 'other', root: shared })
    const { key, handle } = await provision(runtime)
    const { snapshot } = await runtime.snapshot(handle)
    expect(runtime.owns(handle)).toBe(true)
    expect(other.owns(handle)).toBe(false)
    expect(runtime.ownsSnapshot(snapshot)).toBe(true)
    expect(other.ownsSnapshot(snapshot)).toBe(false)
    await expect(other.observe(handle)).rejects.toThrow('This handle was not issued by the other runtime')
    await expect(other.deleteSnapshot(snapshot)).rejects.toThrow(
      'This snapshot was not taken by the other runtime',
    )
    expect(fakeHandleKey(handle)).toBe(key)
  })

  test('a handle from another deployment is refused by the runtime, not read as stale', async () => {
    const { runtime, root: shared } = await fresh()
    const { runtime: elsewhere } = await fresh({ deploymentId: 'elsewhere', root: shared })
    const { handle } = await provision(runtime)
    await expect(elsewhere.observe(handle)).rejects.toThrow('This handle belongs to another deployment')
    await expect(elsewhere.release(handle)).rejects.toThrow('This handle belongs to another deployment')
  })

  test('a restore issues a new handle, and the old one finds nothing', async () => {
    const { runtime } = await fresh()
    const { handle } = await provision(runtime)
    const { snapshot } = await runtime.snapshot(handle)
    const next = await runtime.restore(handle, { kind: 'snapshot', snapshot }, spec, quiet)
    expect(next).not.toBe(handle)
    expect(runtime.sameCompute(handle, next)).toBe(false)
    await expect(runtime.start(handle)).rejects.toThrow('No machine answers to this handle any more')
    expect((await runtime.observe(handle)).state).toBe('absent')
    expect((await runtime.observe(next)).state).toBe('running')
  })

  test('a deleted snapshot is gone, and nothing restores from it', async () => {
    const { runtime } = await fresh()
    const { handle } = await provision(runtime)
    const { snapshot } = await runtime.snapshot(handle)
    expect(await runtime.goneSnapshots([snapshot])).toEqual(new Set())
    await runtime.deleteSnapshot(snapshot)
    expect(await runtime.goneSnapshots([snapshot])).toEqual(new Set([snapshot]))
    await expect(runtime.restore(handle, { kind: 'snapshot', snapshot }, spec, quiet)).rejects.toThrow(
      'The snapshot is gone',
    )
  })
})

describe('archives', () => {
  let store: MemoryStore
  beforeAll(async () => {
    store = new MemoryStore()
    await store.start()
  })
  afterAll(() => store.close())

  async function world(runtime: FakeRuntime) {
    const server = await provision(runtime)
    await writeFile(join(server.dir, 'level.dat'), 'a world')
    const { snapshot } = await runtime.snapshot(server.handle)
    return { ...server, snapshot }
  }

  const exportsLeft = async (dir: string) => (await readdir(dir)).filter((name) => name.startsWith('export-'))

  test('an archive goes in one PUT, and a restore brings the world back from it', async () => {
    const { runtime, root: dir } = await fresh()
    const { handle, snapshot, key } = await world(runtime)
    const completed = store.completed
    const sent = await runtime.exportSnapshot(snapshot, await store.archiveTarget('whole'))
    const bytes = store.objects.get('whole')
    expect(bytes?.length).toBe(sent.sizeBytes)
    expect(sent.sha256).toBe(
      createHash('sha256')
        .update(bytes ?? '')
        .digest('hex'),
    )
    expect(store.completed).toBe(completed)
    expect(await exportsLeft(dir)).toEqual([])
    const download = await store.presignGet('whole')
    await runtime.restore(handle, { kind: 'archive', download }, spec, quiet)
    expect(await readFile(join(runtime.machine(key)?.dir ?? '', 'level.dat'), 'utf8')).toBe('a world')
  })

  test('past the limit it goes in parts, which complete into the same archive', async () => {
    const { runtime, root: dir } = await fresh()
    const { handle, snapshot, key } = await world(runtime)
    runtime.limitPuts(10)
    const completed = store.completed
    const sent = await runtime.exportSnapshot(snapshot, await store.archiveTarget('parts'))
    expect(store.completed).toBe(completed + 1)
    expect(store.objects.get('parts')?.length).toBe(sent.sizeBytes)
    expect(await exportsLeft(dir)).toEqual([])
    const download = await store.presignGet('parts')
    await runtime.restore(handle, { kind: 'archive', download }, spec, quiet)
    expect(await readFile(join(runtime.machine(key)?.dir ?? '', 'level.dat'), 'utf8')).toBe('a world')
  })

  test('a refused part aborts the upload, and the scratch goes', async () => {
    const { runtime, root: dir } = await fresh()
    const { snapshot } = await world(runtime)
    runtime.limitPuts(10)
    const aborted = store.aborted
    store.refuse.push(500)
    await expect(runtime.exportSnapshot(snapshot, await store.archiveTarget('refused'))).rejects.toThrow(
      'The upload was refused with 500',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.aborted).toBe(aborted + 1)
    expect(store.objects.has('refused')).toBe(false)
    expect(await exportsLeft(dir)).toEqual([])
  })

  test('too few part links abort the upload with how many there were', async () => {
    const { runtime, root: dir } = await fresh()
    const { snapshot } = await world(runtime)
    runtime.limitPuts(10)
    let aborts = 0
    const target = await store.archiveTarget('short')
    const short = {
      ...target,
      inParts: async (sizeBytes: number) => ({
        ...(await target.inParts(sizeBytes)),
        urls: [],
        abort: async () => {
          aborts++
        },
      }),
    }
    await expect(runtime.exportSnapshot(snapshot, short)).rejects.toThrow(/ bytes need more parts than 0$/)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(aborts).toBe(1)
    expect(await exportsLeft(dir)).toEqual([])
  })

  test('a refused single PUT fails without parts to abort', async () => {
    const { runtime } = await fresh()
    const { snapshot } = await world(runtime)
    const aborted = store.aborted
    store.refuse.push(403)
    await expect(runtime.exportSnapshot(snapshot, await store.archiveTarget('single'))).rejects.toThrow(
      'The upload was refused with 403',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.aborted).toBe(aborted)
  })

  test('a download that is refused fails the restore with its status', async () => {
    const { runtime } = await fresh()
    const { handle } = await provision(runtime)
    const download = await store.presignGet('nothing-here')
    await expect(runtime.restore(handle, { kind: 'archive', download }, spec, quiet)).rejects.toThrow(
      'Downloading the archive answered 404',
    )
  })

  test('an unsupported export fails as one no retry changes', async () => {
    const { runtime } = await fresh()
    const { snapshot } = await world(runtime)
    runtime.failExports('too big to pack', { unsupported: true })
    await expect(runtime.exportSnapshot(snapshot, await store.archiveTarget('x'))).rejects.toBeInstanceOf(
      RuntimeUnsupported,
    )
    runtime.failExports('the store is down')
    const failed = runtime.exportSnapshot(snapshot, await store.archiveTarget('x'))
    await expect(failed).rejects.toThrow('the store is down')
    await expect(failed).rejects.not.toBeInstanceOf(RuntimeUnsupported)
  })

  test('a failing export takes no hold, and the next one waits for it', async () => {
    const { runtime } = await fresh()
    const { snapshot } = await world(runtime)
    const letGo = runtime.holdExports(1)
    runtime.failExports('not now')
    await expect(runtime.exportSnapshot(snapshot, await store.archiveTarget('held'))).rejects.toThrow(
      'not now',
    )
    runtime.failExports(null)
    const held = runtime.exportSnapshot(snapshot, await store.archiveTarget('held'))
    expect(await settled(held)).toBe(false)
    letGo()
    await held
    expect(store.objects.has('held')).toBe(true)
    await runtime.exportSnapshot(snapshot, await store.archiveTarget('after'))
  })
})

describe('holds', () => {
  test('the next stops wait until one call lets them all go', async () => {
    const { runtime } = await fresh()
    const { handle, key } = await provision(runtime)
    const letGo = runtime.holdStops(2)
    const first = runtime.stop(handle)
    const second = runtime.stop(handle)
    expect(await settled(first)).toBe(false)
    expect(await settled(second)).toBe(false)
    expect(runtime.machine(key)?.state).toBe('running')
    await runtime.stop(handle)
    expect(runtime.machine(key)?.state).toBe('stopped')
    expect(await settled(first)).toBe(false)
    letGo()
    await Promise.all([first, second])
  })

  test('a stop that fails takes no hold', async () => {
    const { runtime } = await fresh()
    const { handle } = await provision(runtime)
    const letGo = runtime.holdStops(1)
    runtime.failStops('no')
    await expect(runtime.stop(handle)).rejects.toThrow('no')
    runtime.failStops(null)
    const held = runtime.stop(handle)
    expect(await settled(held)).toBe(false)
    letGo()
    await held
  })

  test('a hold asked for again keeps the earlier waiters on the earlier release', async () => {
    const { runtime } = await fresh()
    const { handle } = await provision(runtime)
    const letFirstGo = runtime.holdStops(1)
    const first = runtime.stop(handle)
    const letSecondGo = runtime.holdStops(1)
    const second = runtime.stop(handle)
    letSecondGo()
    await second
    expect(await settled(first)).toBe(false)
    letFirstGo()
    await first
  })

  test('a stop nobody holds waits for nothing: it settles on the first turn', async () => {
    const { runtime } = await fresh()
    const { handle } = await provision(runtime)
    await runtime.stop(handle)
    const order: string[] = []
    const turns = Promise.resolve()
      .then(() => order.push('1'))
      .then(() => order.push('2'))
      .then(() => order.push('3'))
    const stopped = runtime.stop(handle).then(() => order.push('stop'))
    await Promise.all([turns, stopped])
    expect(order).toEqual(['1', 'stop', '2', '3'])
  })

  test('a release held mid-rest goes on when let go', async () => {
    const { runtime } = await fresh()
    const { handle, key } = await provision(runtime)
    const letGo = runtime.holdReleases(1)
    const releasing = runtime.release(handle)
    expect(await settled(releasing)).toBe(false)
    expect(runtime.machine(key)?.state).toBe('running')
    letGo()
    await releasing
    expect(runtime.machine(key)?.released).toBe(true)
  })
})

describe('releases', () => {
  test('one that fails partway leaves the storage and the handle, and a retry finishes it', async () => {
    const { runtime } = await fresh()
    const { handle, key, dir } = await provision(runtime)
    await runtime.snapshot(handle)
    runtime.failReleases('the provider timed out', { partway: true })
    await expect(runtime.release(handle)).rejects.toThrow('the provider timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runtime.machine(key)).toMatchObject({ state: 'stopped', compute: false, released: false, dir })
    expect((await stat(dir)).isDirectory()).toBe(true)
    expect((await runtime.observe(handle)).state).toBe('absent')
    runtime.failReleases(null)
    const released = await runtime.release(handle)
    expect(released).not.toBe(handle)
    expect(runtime.machine(key)).toMatchObject({ compute: false, released: true, dir: '' })
    await expect(stat(dir)).rejects.toThrow()
    expect(await runtime.release(handle)).toBe(released)
    expect(await runtime.release(released)).toBe(released)
  })

  test('one that fails at once keeps the compute', async () => {
    const { runtime } = await fresh()
    const { handle, key } = await provision(runtime)
    runtime.failReleases('refused')
    await expect(runtime.release(handle)).rejects.toThrow('refused')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runtime.machine(key)).toMatchObject({ state: 'stopped', compute: true, released: false })
    expect((await runtime.observe(handle)).state).toBe('stopped')
  })
})

describe('hosts', () => {
  test('a lost host answers as unknown, and comes back running on the same handle', async () => {
    const { runtime } = await fresh()
    const { handle, key } = await provision(runtime)
    await runtime.loseHost(key)
    expect(await runtime.observe(handle)).toMatchObject({ state: 'unknown', hostLost: true })
    expect(runtime.machine(key)?.state).toBe('running')
    await expect(runtime.stop(handle)).rejects.toThrow('The machine’s host is unreachable')
    await expect(runtime.snapshot(handle)).rejects.toThrow('The machine’s host is unreachable')
    await expect(runtime.exec(handle, ['true'], 5)).rejects.toThrow('The machine’s host is unreachable')
    await runtime.regainHost(key)
    expect((await runtime.observe(handle)).state).toBe('running')
    expect(await runtime.start(handle)).toBe(handle)
  })

  test('a rebuild from a snapshot replaces a lost host’s machine, stopped', async () => {
    const { runtime } = await fresh()
    const { handle, key, dir } = await provision(runtime)
    const { snapshot } = await runtime.snapshot(handle)
    await runtime.loseHost(key)
    const next = await runtime.relocate(handle, { regionKey: 'local' }, spec, quiet, snapshot)
    expect(runtime.machine(key)).toMatchObject({ state: 'stopped', compute: true })
    expect(runtime.machine(key)?.dir).not.toBe(dir)
    expect((await stat(dir)).isDirectory()).toBe(true)
    expect((await runtime.observe(next)).state).toBe('stopped')
    expect((await runtime.observe(handle)).state).toBe('absent')
  })
})

describe('exec', () => {
  test('the mount path is the storage directory, as a whole path segment only', async () => {
    const { runtime } = await fresh()
    const { handle, dir, key } = await provision(runtime)
    const result = await runtime.exec(handle, ['sh', '-c', 'echo /data/x /database; exit 3'], 5)
    expect(result).toEqual({ exitCode: 3, stdout: `${dir}/x /database\n`, stderr: '' })
    runtime.reportDiskUsage(key, 1234)
    expect(await runtime.exec(handle, ['du', '-sk', '/data'], 5)).toEqual({
      exitCode: 0,
      stdout: '1234\t/data\n',
      stderr: '',
    })
    await runtime.stop(handle)
    await expect(runtime.exec(handle, ['true'], 5)).rejects.toThrow('The machine is not running')
  })
})

describe('restores that fail', () => {
  test('after the storage: the old handle still names the stopped machine on its old storage', async () => {
    const { runtime } = await fresh()
    const { handle, key, dir } = await provision(runtime)
    const { snapshot } = await runtime.snapshot(handle)
    runtime.failRestores('no room for the volume', 'storage')
    const handed: string[] = []
    const progress = { step: async () => {}, handle: async (next: string) => void handed.push(next) }
    await expect(runtime.restore(handle, { kind: 'snapshot', snapshot }, spec, progress)).rejects.toThrow(
      'no room for the volume',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(handed).toEqual([])
    expect(runtime.machine(key)).toMatchObject({ state: 'stopped', dir })
    expect((await runtime.observe(handle)).state).toBe('stopped')
  })

  test('after the compute: the new handle names it, stopped, and the old storage stays', async () => {
    const { runtime } = await fresh()
    const { handle, key, dir } = await provision(runtime)
    const { snapshot } = await runtime.snapshot(handle)
    runtime.failRestores('the machine did not come up', 'compute')
    const handed: string[] = []
    const progress = { step: async () => {}, handle: async (next: string) => void handed.push(next) }
    await expect(runtime.restore(handle, { kind: 'snapshot', snapshot }, spec, progress)).rejects.toThrow(
      'the machine did not come up',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(handed).toHaveLength(1)
    const next = handed[0] as RuntimeHandle
    expect((await runtime.observe(handle)).state).toBe('absent')
    expect((await runtime.observe(next)).state).toBe('stopped')
    expect(runtime.machine(key)?.dir).not.toBe(dir)
    expect((await stat(dir)).isDirectory()).toBe(true)
  })
})
