/**
 * FlyRuntime against an in-memory Fly that takes a moment to finish a stop or a destroy, as the
 * real one did on staging (2026-10-07): a start waits for the stop, and a volume for its machine.
 */

import { describe, expect, test } from 'bun:test'
import type { ProgressSink, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { decodeHandle, encodeHandle } from './handle.ts'

const KEY = '6276d3d7-5c80-4bd4-9d00-12818b8a4d38' as RuntimeKey
const APP = 'bly-test-6276d3d75c804bd49d0012818b8a4d38'

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

async function provisioned() {
  const fake = new FakeFly()
  const runtime = new FlyRuntime({
    client: flyClient('token', { fetch: fake.fetch as never, pace: { perSecond: 1000, burst: 1000 } }),
    org: 'blockly',
    deploymentId: 'test',
    regionMap: { 'eu-central': 'fra' },
    snapshotRetentionDays: 30,
    machineLimit: 50,
    platformMachines: 7,
  })
  const progress: ProgressSink = { step: async () => {}, handle: async () => {} }
  const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
  return { fake, runtime, handle }
}

describe('FlyRuntime waiting on Fly to finish', () => {
  test('a start waits for a stop still under way, not refused by Fly', async () => {
    const { fake, runtime, handle } = await provisioned()
    const machine = fake.machines.get(APP)?.[0]
    if (machine === undefined) throw new Error('no machine')
    // Stopped by another worker a moment ago: Fly refuses to start a machine still stopping.
    machine.state = 'stopping'
    machine.stopReadsLeft = 3
    await runtime.start(handle)
    expect(machine.state).toBe('started')
    expect(fake.refusedStarts).toBe(0)
  })

  test('a start Fly refuses as still active, though the machine reads stopped, is asked again', async () => {
    const { fake, runtime, handle } = await provisioned()
    await runtime.stop(handle)
    fake.activeStarts = 2
    await runtime.start(handle)
    expect(fake.machines.get(APP)?.[0]?.state).toBe('started')
    expect(fake.refusedStarts).toBe(2)
  })

  test('a restart starts once its stop has settled', async () => {
    const { fake, runtime, handle } = await provisioned()
    fake.stopReads = 3
    await runtime.restart(handle)
    expect(fake.machines.get(APP)?.[0]?.state).toBe('started')
    expect(fake.refusedStarts).toBe(0)
  })

  test('release deletes the volume once Fly has finished destroying the machine bound to it', async () => {
    const { fake, runtime, handle } = await provisioned()
    fake.destroyReads = 3
    expect(decodeHandle(await runtime.release(handle))).toMatchObject({ machineId: null, volumeId: null })
    expect(fake.boundDeletes).toBe(0)
    expect(fake.machines.get(APP)).toEqual([])
    expect(fake.volumes.get(APP)).toEqual([])
  })

  test('a volume Fly still lists a moment after deleting it counts as gone', async () => {
    const { fake, runtime, handle } = await provisioned()
    fake.deletedListReads = 5
    expect(decodeHandle(await runtime.release(handle))).toMatchObject({ machineId: null, volumeId: null })
    expect(fake.volumes.get(APP)).toEqual([])
  })

  test('a volume still bound to a machine Fly is destroying is deleted once it is free, not failed', async () => {
    const { fake, runtime, handle } = await provisioned()
    // An interrupted restore's machine, still being destroyed, holds the volume the handle names.
    const machine = fake.machines.get(APP)?.[0]
    if (machine === undefined) throw new Error('no machine')
    machine.state = 'destroying'
    machine.destroyReadsLeft = 2
    const released = await runtime.release(encodeHandle({ ...decodeHandle(handle), machineId: null }))
    expect(decodeHandle(released)).toMatchObject({ machineId: null, volumeId: null })
    expect(fake.boundDeletes).toBeGreaterThan(0)
    expect(fake.volumes.get(APP)).toEqual([])
  })
})
