// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A new server's first volume on a host known to be slow is made again elsewhere before any
 * machine is made on it, three times at most; a host not known, one Fly doesn't name, and a volume
 * that may hold a world are left alone. The server's machine is made once, and whatever fails
 * leaves it a volume to start on and nothing the leftover sweep wouldn't clear.
 */

import { describe, expect, test } from 'bun:test'
import type { ProgressSink, RuntimeHandle, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { type FakeHost, onHosts } from './fake-fly-hosts.ts'
import { CPUINFO } from './fly-runtime/host-cpu.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { decodeHandle } from './handle.ts'

const KEY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' as RuntimeKey
const APP = 'bly-test-7a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d'
const PLACE = { regionKey: 'eu-central' }
/** Hosts by the names tests know them by; which are known to be slow is each test's to say. */
const hosts = (...zones: string[]): FakeHost[] => zones.map((zone) => ({ zone, mhz: 2000 }))

const spec: RuntimeSpec = {
  image: 'itzg/minecraft-server:2026.9.1-java25',
  env: { EULA: 'TRUE', VERSION: '26.3' },
  secrets: { RCON_PASSWORD: 'secret' },
  resources: { memoryMb: 2048 },
  storage: { mountPath: '/data', sizeGb: 5 },
  ports: [{ name: 'game', port: 25565, protocol: 'tcp', audience: ['edge'] }],
  stop: { signal: 'SIGTERM', timeoutSeconds: 90 },
  labels: {},
}

/** One call to Fly, as a test refuses it: `POST /v1/apps/<app>/volumes`, and which one of them. */
interface Refused {
  call: RegExp
  /** The first is 1. */
  nth: number
}

type SlowHost = NonNullable<ProgressSink['slowHost']>

/** What a start reports as it goes, kept for a test to read, and what it is told of hosts when it asks. */
function watching(slowHost?: SlowHost) {
  const seen = { steps: [] as string[], marks: [] as string[], handles: [] as RuntimeHandle[] }
  const progress: ProgressSink = {
    step: async (step) => void seen.steps.push(step),
    handle: async (handle) => void seen.handles.push(handle),
    mark: async (mark) => void seen.marks.push(mark),
    ...(slowHost === undefined ? {} : { slowHost }),
  }
  return { seen, progress }
}

const runtimeOn = (fetch: (request: Request) => Promise<Response>) =>
  new FlyRuntime({
    client: flyClient('token', { fetch: fetch as never, pace: { perSecond: 1000, burst: 1000 } }),
    org: 'blockly',
    deploymentId: 'test',
    regionMap: { 'eu-central': 'fra' },
    snapshotRetentionDays: 30,
    machineLimit: 50,
    platformMachines: 7,
  })

/**
 * A runtime on a fake Fly whose new volumes land on `placed`, in order, of which `slow` are known
 * to be slow. `refused` answers one call with an error instead of passing it on, as Fly failing it
 * would; `unasked`, the start has nobody to ask which hosts are slow.
 */
function setup(
  placed: FakeHost[],
  slow: readonly string[],
  options: { refused?: Refused; unasked?: boolean } = {},
) {
  const fake = new FakeFly()
  const fly = onHosts(fake, placed)
  const sent: { call: string; body: unknown }[] = []
  let matched = 0
  const fetch = async (request: Request) => {
    const call = `${request.method} ${new URL(request.url).pathname}`
    sent.push({
      call,
      body: await request
        .clone()
        .json()
        .catch(() => null),
    })
    if (options.refused?.call.test(call) && ++matched === options.refused.nth)
      return Response.json({ error: 'internal: something went wrong' }, { status: 500 })
    return fly(request)
  }
  /** Each host the runtime asked about, as `fly:fra/z1`. */
  const asked: string[] = []
  const slowHost: SlowHost = async (provider, host) => {
    asked.push(`${provider}:${host.region}/${host.id}`)
    return slow.includes(host.id)
  }
  const calls = (pattern: RegExp) => sent.filter((s) => pattern.test(s.call))
  const watched = watching(options.unasked ? undefined : slowHost)
  return { fake, fetch, runtime: runtimeOn(fetch), sent, calls, asked, ...watched }
}

const VOLUMES_MADE = /^POST .*\/volumes$/
const VOLUMES_DELETED = /^DELETE .*\/volumes\/[^/]+$/
const MACHINES_MADE = /^POST .*\/machines$/

const volumes = (fake: FakeFly) => (fake.volumes.get(APP) ?? []).filter((v) => v.name === 'minecraft_data')
/** What Fly holds for the server: its machines with their states, and the zones of its world volumes. */
const held = (fake: FakeFly) => ({
  machines: (fake.machines.get(APP) ?? []).map((m) => m.state),
  zones: volumes(fake).map((v) => v.zone),
})
/** The zone of the volume a handle names. */
const zoneOf = (fake: FakeFly, handle: RuntimeHandle) =>
  volumes(fake).find((v) => v.id === decodeHandle(handle).volumeId)?.zone

describe('a new server on Fly', () => {
  test('whose first volume lands on a host known to be slow gets another, and its machine is made once', async () => {
    const { fake, runtime, progress, seen, sent, calls, asked } = setup(hosts('z1', 'z2'), ['z1'])
    const handle = await runtime.ensureProvisioned(KEY, PLACE, spec, progress)

    expect(held(fake)).toEqual({ machines: ['started'], zones: ['z2'] })
    expect(zoneOf(fake, handle)).toBe('z2')
    // One machine, one handle, one start: nothing was made on the first volume.
    expect(calls(MACHINES_MADE)).toHaveLength(1)
    expect(seen.handles).toEqual([handle])
    expect(fake.startedFrom).toHaveLength(1)
    expect(fake.stopSignals).toEqual([])
    // Its creator sees one start, and the record says which host was left.
    expect(seen.steps).toEqual(['allocating', 'storage', 'compute', 'booting'])
    expect(seen.marks).toEqual(['slow_host:fra/z1', 'no_compute'])
    expect(asked).toEqual(['fly:fra/z1', 'fly:fra/z2'])

    // The second volume is made beside the first, so Fly places it on another host, and only
    // then does the first go; the machine comes after both.
    const order = sent
      .map((s) => s.call)
      .filter((call) => /volumes|machines$/.test(call) && !call.startsWith('GET'))
    expect(order.map((call) => call.replace(/^(\w+) .*\/(volumes|machines)/, '$1 $2'))).toEqual([
      'POST volumes',
      'POST volumes',
      'DELETE volumes/vol_1',
      'POST machines',
    ])
    const [first, second] = calls(VOLUMES_MADE).map((s) => s.body as Record<string, unknown>)
    expect(first?.require_unique_zone).toBeUndefined()
    expect(second).toMatchObject({ require_unique_zone: true, size_gb: 5, region: 'fra' })
    // No machine is ever asked for its CPU here, and nothing is left for the sweep.
    expect(sent.filter((s) => JSON.stringify(s.body ?? '').includes(CPUINFO))).toEqual([])
    expect(await runtime.clearLeftovers(handle, false)).toEqual([])
  })

  test('on a host that isn’t known to be slow keeps its volume at once', async () => {
    const { fake, runtime, progress, seen, calls, asked } = setup(hosts('z1', 'z2'), ['z2'])
    const handle = await runtime.ensureProvisioned(KEY, PLACE, spec, progress)
    expect(zoneOf(fake, handle)).toBe('z1')
    expect(calls(VOLUMES_MADE)).toHaveLength(1)
    expect(calls(VOLUMES_DELETED)).toHaveLength(0)
    expect(seen.marks).toEqual(['no_compute'])
    expect(asked).toEqual(['fly:fra/z1'])
  })

  test('that lands on known slow hosts four times is made again three times, then keeps what it has', async () => {
    const { fake, runtime, progress, seen, calls, asked } = setup(hosts('z1', 'z2', 'z3', 'z4', 'z5'), [
      'z1',
      'z2',
      'z3',
      'z4',
    ])
    const handle = await runtime.ensureProvisioned(KEY, PLACE, spec, progress)
    expect(calls(VOLUMES_MADE)).toHaveLength(4)
    expect(calls(VOLUMES_DELETED)).toHaveLength(3)
    expect(held(fake)).toEqual({ machines: ['started'], zones: ['z4'] })
    expect(seen.marks).toEqual(['slow_host:fra/z1', 'slow_host:fra/z2', 'slow_host:fra/z3', 'no_compute'])
    // The fourth is kept whatever it is: nobody asks about it.
    expect(asked).toEqual(['fly:fra/z1', 'fly:fra/z2', 'fly:fra/z3'])
    expect(calls(MACHINES_MADE)).toHaveLength(1)
    expect(await runtime.clearLeftovers(handle, false)).toEqual([])
  })

  test('on a host Fly names nothing for keeps its volume, and nobody is asked', async () => {
    const { runtime, progress, calls, asked } = setup([], ['z1'])
    await runtime.ensureProvisioned(KEY, PLACE, spec, progress)
    expect(calls(VOLUMES_MADE)).toHaveLength(1)
    expect(asked).toEqual([])
  })

  test('with nobody to ask which hosts are slow keeps whatever volume Fly makes', async () => {
    const { fake, runtime, progress, seen, calls } = setup(hosts('z1', 'z2'), ['z1'], { unasked: true })
    const handle = await runtime.ensureProvisioned(KEY, PLACE, spec, progress)
    expect(zoneOf(fake, handle)).toBe('z1')
    expect(calls(VOLUMES_MADE)).toHaveLength(1)
    expect(seen.marks).toEqual(['no_compute'])
  })
})

describe('a volume that may hold a world is never made again', () => {
  /** A server on a host since learned to be slow: provisioned while nothing was known of it. */
  async function onSlowHost() {
    const first = setup(hosts('z1', 'z2', 'z3', 'z4'), [])
    const handle = await first.runtime.ensureProvisioned(KEY, PLACE, spec, first.progress)
    const asked: string[] = []
    const everySlow: SlowHost = async (_provider, host) => {
      asked.push(host.id)
      return true
    }
    return { fake: first.fake, runtime: first.runtime, handle, asked, ...watching(everySlow) }
  }

  test('a server that has started before keeps its volume, though its host is known to be slow', async () => {
    const { fake, runtime, handle, progress, seen, asked } = await onSlowHost()
    await runtime.stop(handle)
    const again = await runtime.ensureProvisioned(KEY, PLACE, spec, progress, null, { held: handle })
    expect(decodeHandle(again).volumeId).toBe(decodeHandle(handle).volumeId)
    expect(seen.marks).toEqual(['not_asleep'])
    expect({ zones: held(fake).zones, asked }).toEqual({ zones: ['z1'], asked: [] })
  })

  test('a server back from the trash, its machine new and its volume kept, keeps the volume', async () => {
    const { fake, runtime, handle, progress, asked } = await onSlowHost()
    await runtime.decommission(handle)
    const again = await runtime.ensureProvisioned(KEY, PLACE, spec, progress, null, { held: handle })
    expect(decodeHandle(again).volumeId).toBe(decodeHandle(handle).volumeId)
    expect({ zones: held(fake).zones, asked }).toEqual({ zones: ['z1'], asked: [] })
  })

  test('a server that held storage and has none at Fly gets a volume once, wherever it lands', async () => {
    const { fake, runtime, handle, progress, seen, asked } = await onSlowHost()
    await runtime.release(handle)
    await runtime.ensureProvisioned(KEY, PLACE, spec, progress, null, { held: handle })
    expect(seen.marks).toEqual(['no_compute'])
    expect({ zones: held(fake).zones, asked }).toEqual({ zones: ['z2'], asked: [] })
  })

  test('a restore, a rebuild and a move make their volume once, wherever it lands', async () => {
    const { fake, runtime, handle, progress, seen, asked } = await onSlowHost()
    const { snapshot } = await runtime.snapshot(handle)
    const restored = await runtime.restore(handle, { kind: 'snapshot', snapshot }, spec, progress)
    const { snapshot: later } = await runtime.snapshot(restored)
    await runtime.relocate(restored, PLACE, spec, progress, later, { keepStorage: true })
    expect(seen.marks.filter((mark) => mark.startsWith('slow_host'))).toEqual([])
    // The restore's volume, and the rebuild's beside the one it kept.
    expect({ zones: held(fake).zones, asked }).toEqual({ zones: ['z2', 'z3'], asked: [] })
  }, 60_000)
})

describe('making a new server’s volume again fails', () => {
  test('where what is known of hosts can’t be read: it keeps its volume, and starts', async () => {
    const run = setup(hosts('z1', 'z2'), ['z1'])
    const unread = watching(() => Promise.reject(new Error('the database went away')))
    const handle = await run.runtime.ensureProvisioned(KEY, PLACE, spec, unread.progress)
    expect(held(run.fake)).toEqual({ machines: ['started'], zones: ['z1'] })
    expect(unread.seen.handles).toEqual([handle])
    expect(run.calls(VOLUMES_MADE)).toHaveLength(1)
  })

  test('where Fly makes no second volume: it keeps the first, and starts on it', async () => {
    const run = setup(hosts('z1', 'z2'), ['z1'], { refused: { call: VOLUMES_MADE, nth: 2 } })
    const handle = await run.runtime.ensureProvisioned(KEY, PLACE, spec, run.progress)
    expect(held(run.fake)).toEqual({ machines: ['started'], zones: ['z1'] })
    expect(run.calls(VOLUMES_DELETED)).toHaveLength(0)
    expect(run.seen.marks).toEqual(['no_compute'])
    expect(await run.runtime.clearLeftovers(handle, false)).toEqual([])
  })

  test('where Fly won’t let go of the first volume: it starts on the second, makes no third, and the sweep clears the first', async () => {
    const run = setup(hosts('z1', 'z2', 'z3'), ['z1', 'z2'])
    run.fake.heldDeletes = 1
    const handle = await run.runtime.ensureProvisioned(KEY, PLACE, spec, run.progress)
    expect(zoneOf(run.fake, handle)).toBe('z2')
    expect(held(run.fake)).toEqual({ machines: ['started'], zones: ['z1', 'z2'] })
    expect(run.calls(VOLUMES_MADE)).toHaveLength(2)
    expect(run.calls(MACHINES_MADE)).toHaveLength(1)
    expect(await run.runtime.clearLeftovers(handle, false)).toHaveLength(1)
    expect(held(run.fake).zones).toEqual(['z2'])
  })

  test('where the delete itself can’t be asked: the same, and the sweep clears the first', async () => {
    const run = setup(hosts('z1', 'z2'), ['z1'], { refused: { call: VOLUMES_DELETED, nth: 1 } })
    const handle = await run.runtime.ensureProvisioned(KEY, PLACE, spec, run.progress)
    expect(held(run.fake)).toEqual({ machines: ['started'], zones: ['z1', 'z2'] })
    expect(await run.runtime.clearLeftovers(handle, false)).toHaveLength(1)
    expect(held(run.fake).zones).toEqual(['z2'])
  })

  test('where the host it left can’t be marked: the start fails, and its next try starts on the volume it kept', async () => {
    const run = setup(hosts('z1', 'z2', 'z3'), ['z1'])
    const unmarked: ProgressSink = {
      ...run.progress,
      mark: () => Promise.reject(new Error('the database went away')),
    }
    const failed = await run.runtime.ensureProvisioned(KEY, PLACE, spec, unmarked).then(
      () => null,
      (error: unknown) => error,
    )
    expect(String(failed)).toContain('the database went away')
    expect(held(run.fake)).toEqual({ machines: [], zones: ['z2'] })

    const handle = await run.runtime.ensureProvisioned(KEY, PLACE, spec, run.progress)
    expect(held(run.fake)).toEqual({ machines: ['started'], zones: ['z2'] })
    expect(run.calls(VOLUMES_MADE)).toHaveLength(2)
    expect(await run.runtime.clearLeftovers(handle, false)).toEqual([])
  })
})
