// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FlyRuntime clearing world volumes nothing uses. A wake from the archive that failed had its
 * fresh volume deleted, and Fly went on holding it past the two minutes a delete waits: the volume
 * stayed in the app and billed, and the next wake made another beside it (2026-10-11).
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { ProgressSink, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { decodeHandle, encodeHandle } from './handle.ts'

const KEY = '0b8f5c1e-6d2a-4f3b-9c7e-2a1d4e5f6a7b' as RuntimeKey
const APP = 'bly-test-0b8f5c1e6d2a4f3b9c7e2a1d4e5f6a7b'

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
const archive = { kind: 'archive' as const, download: { url: 'https://bucket.example/rest.tgz' } }

async function provisioned() {
  const fake = new FakeFly()
  const client = flyClient('token', { fetch: fake.fetch as never, pace: { perSecond: 1000, burst: 1000 } })
  const runtime = new FlyRuntime({
    client,
    org: 'blockly',
    deploymentId: 'test',
    regionMap: { 'eu-central': 'fra' },
    snapshotRetentionDays: 30,
    machineLimit: 50,
    platformMachines: 7,
  })
  const progress: ProgressSink = { step: async () => {}, handle: async () => {} }
  const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
  return { fake, runtime, handle, progress }
}

/** A world volume beside the server's, as a restore that failed partway leaves one. */
function leftover(fake: FakeFly, id: string, attached?: string) {
  fake.volumes.set(APP, [
    ...(fake.volumes.get(APP) ?? []),
    {
      id,
      name: 'minecraft_data',
      region: 'fra',
      size_gb: 5,
      state: 'created',
      hydrateReadsLeft: 0,
      ...(attached === undefined ? {} : { attached_machine_id: attached }),
    },
  ])
}

const volumeIds = (fake: FakeFly) => (fake.volumes.get(APP) ?? []).map((v) => v.id)

describe('FlyRuntime clearing leftover volumes', () => {
  let clock: ReturnType<typeof spyOn> | null = null
  afterEach(() => {
    clock?.mockRestore()
    clock = null
  })

  test('a failed wake’s volume Fly held past the delete’s wait goes on the next sweep', async () => {
    const { fake, runtime, handle, progress } = await provisioned()
    const resting = await runtime.release(handle)
    // The wake's helper ends without filling the volume: the wake fails, its volume stays.
    fake.jobGone = true
    await expect(runtime.restore(resting, archive, spec, progress)).rejects.toThrow('without a result')
    fake.jobGone = false
    const made = volumeIds(fake)[0] ?? ''
    expect(made).not.toBe('')
    // Putting the world back to rest: Fly holds the volume past the two minutes a delete waits.
    fake.heldDeletes = 1_000
    // A minute passes at every look at the clock, then time runs on as before from there.
    const realNow = Date.now.bind(Date)
    let skew = 0
    let passing = true
    clock = spyOn(Date, 'now').mockImplementation(() => {
      if (passing) skew += 61_000
      return realNow() + skew
    })
    await expect(runtime.release(resting)).rejects.toThrow('currently bound')
    passing = false
    expect(volumeIds(fake)).toEqual([made])
    // A sweep while Fly still holds it deletes nothing and waits for nothing.
    const refused = fake.boundDeletes
    expect(await runtime.clearLeftovers(resting, true)).toEqual([])
    expect(fake.boundDeletes).toBe(refused + 1)
    expect(volumeIds(fake)).toEqual([made])
    // Once Fly lets go, the next one does.
    fake.heldDeletes = 0
    expect(await runtime.clearLeftovers(resting, true)).toEqual([made])
    expect(volumeIds(fake)).toEqual([])
  }, 20_000)

  test('a wake that succeeds after one that failed leaves only the volume its machine mounts', async () => {
    const { fake, runtime, handle, progress } = await provisioned()
    const resting = await runtime.release(handle)
    fake.jobGone = true
    await expect(runtime.restore(resting, archive, spec, progress)).rejects.toThrow('without a result')
    fake.jobGone = false
    fake.heldDeletes = 1
    await expect(runtime.clearLeftovers(resting, true)).resolves.toEqual([])
    const earlier = volumeIds(fake)[0] ?? ''
    expect(earlier).not.toBe('')
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    let back: ReturnType<typeof decodeHandle>
    try {
      back = decodeHandle(await runtime.restore(resting, archive, spec, progress))
      expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(
        `fly: deleted ${earlier}, left beside ${APP}'s world`,
      )
    } finally {
      warn.mockRestore()
    }
    expect(volumeIds(fake)).toEqual([back.volumeId ?? ''])
    expect(fake.machines.get(APP)?.map((m) => m.id)).toEqual([back.machineId ?? ''])
    expect(await runtime.clearLeftovers(encodeHandle(back), false)).toEqual([])
  })

  test('a volume a machine mounts, or Fly says is attached, is never deleted', async () => {
    const { fake, runtime, handle } = await provisioned()
    const world = volumeIds(fake)[0] ?? ''
    const machine = fake.machines.get(APP)?.[0]?.id ?? ''
    leftover(fake, 'vol_attached', machine)
    leftover(fake, 'vol_left')
    // Attached to a machine Fly has destroyed, as the claim that failed a wake named none.
    leftover(fake, 'vol_claimed', '\u0000'.repeat(14))
    // Even asked as for a resting world, the server's own volume stays: its machine mounts it.
    expect(await runtime.clearLeftovers(handle, true)).toEqual(['vol_left', 'vol_claimed'])
    expect(volumeIds(fake)).toEqual([world, 'vol_attached'])
    expect(fake.boundDeletes).toBe(0)
  })

  test('a helper filling a volume keeps it, and a volume the handle names stays', async () => {
    const { fake, runtime, handle } = await provisioned()
    const world = volumeIds(fake)[0] ?? ''
    const [server] = fake.machines.get(APP) ?? []
    if (server === undefined) throw new Error('no machine')
    leftover(fake, 'vol_filling')
    fake.machines.set(APP, [
      server,
      {
        ...server,
        id: 'm_helper',
        config: {
          mounts: [{ volume: 'vol_filling', path: '/data' }],
          metadata: { blockly_deployment: 'test', blockly_role: 'helper' },
        },
      },
    ])
    expect(await runtime.clearLeftovers(handle, false)).toEqual([])
    expect(volumeIds(fake)).toEqual([world, 'vol_filling'])
  })

  test('volumes in another deployment’s app are refused', async () => {
    const { runtime, handle } = await provisioned()
    const other = { ...decodeHandle(handle), app: 'bly-prod-0b8f5c1e6d2a4f3b9c7e2a1d4e5f6a7b' }
    await expect(runtime.clearLeftovers(encodeHandle(other), true)).rejects.toThrow('does not belong')
  })
})
