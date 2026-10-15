// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FlyRuntime against an in-memory Fly that takes a moment to finish a stop or a destroy, as the
 * real one did on staging (2026-10-07): a start waits for the stop, and a volume for its machine;
 * and a new machine for its volume, which Fly can hold after the machine on it is gone (2026-10-11).
 * A snapshot is said to be taken before Fly has finished writing it. An update takes a moment to
 * put in place, reads gone meanwhile and refuses another (2026-10-14).
 */

import { describe, expect, test } from 'bun:test'
import type { ProgressSink, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { createMachine, updateMachine } from './fly-runtime/machines.ts'
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
  return { fake, client, runtime, handle, progress }
}

describe('FlyRuntime waiting on Fly to finish', () => {
  test('a snapshot is taken as Fly accepts it, before Fly has finished writing it', async () => {
    const { fake, runtime, handle } = await provisioned()
    fake.snapshotReads = 1
    const written = () => [...fake.snapshots.values()].flat().map((s) => s.status)
    let whenTaken: unknown[] = []
    await runtime.snapshot(handle, () => {
      whenTaken = written()
    })
    expect(whenTaken).toEqual(['pending'])
    expect(written()).toEqual(['created'])
  })

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

describe('FlyRuntime making a machine on a volume Fly still holds', () => {
  const archive = { kind: 'archive' as const, download: { url: 'https://bucket.example/rest.tgz' } }

  test('a wake waits for Fly to let go of the volume its helper filled, and comes up', async () => {
    const { fake, runtime, handle, progress } = await provisioned()
    const released = await runtime.release(handle)
    // The helper is destroyed and gone from the list, and Fly still refuses the volume, naming no
    // machine, as it did to a wake in production.
    fake.lingeringClaims = 3
    const back = decodeHandle(await runtime.restore(released, archive, spec, progress))
    expect(fake.claimedCreates).toBe(3)
    const machines = fake.machines.get(APP) ?? []
    expect(machines.map((m) => m.config.metadata)).toEqual([
      expect.objectContaining({ blockly_role: 'minecraft' }),
    ])
    expect(machines[0]?.id).toBe(back.machineId ?? '')
    expect(fake.volumes.get(APP)?.map((v) => v.id)).toEqual([back.volumeId ?? ''])
  }, 20_000)

  test('a helper left on the volume is destroyed, and the machine made once Fly lets the volume go', async () => {
    const { fake, client } = await provisioned()
    const volumeId = fake.volumes.get(APP)?.[0]?.id ?? ''
    const [server] = fake.machines.get(APP) ?? []
    if (server === undefined) throw new Error('no machine')
    fake.machines.set(APP, [
      {
        ...server,
        id: 'm_helper',
        state: 'started',
        config: { ...server.config, metadata: { blockly_deployment: 'test', blockly_role: 'helper' } },
      },
    ])
    fake.destroyReads = 2
    const made = await createMachine(client, APP, 'fra', server.config as never, undefined, 'minecraft-next')
    expect(fake.claimedCreates).toBeGreaterThan(0)
    expect(fake.destroyed.map((m) => m.id)).toContain('m_helper')
    expect(fake.machines.get(APP)?.map((m) => m.id)).toEqual([made.id ?? ''])
    // The volume, which may hold the only copy of a world, is never touched.
    expect(fake.volumes.get(APP)?.map((v) => v.id)).toEqual([volumeId])
  })

  test('this deployment’s server machine already on the volume is the one used, not a second', async () => {
    const { fake, client } = await provisioned()
    const [server] = fake.machines.get(APP) ?? []
    if (server === undefined) throw new Error('no machine')
    const made = await createMachine(client, APP, 'fra', server.config as never, undefined, 'minecraft-next')
    expect(made.id).toBe(server.id)
    expect(fake.machines.get(APP)).toHaveLength(1)
    expect(fake.claimedCreates).toBe(1)
  })
})

describe('FlyRuntime while Fly puts an update in place', () => {
  test('an apply while Fly still puts the one before in place waits for it, then changes the machine', async () => {
    const { fake, runtime, handle } = await provisioned()
    fake.replacing = 3
    const first = await runtime.apply(handle, { ...spec, env: { ...spec.env, VERSION: '26.4' } })
    const second = await runtime.apply(first, { ...spec, env: { ...spec.env, VERSION: '26.5' } })
    const machine = fake.machines.get(APP)?.[0]
    expect(machine?.state).toBe('replacing')
    await runtime.waitRunning(second, AbortSignal.timeout(5_000))
    expect(machine?.state).toBe('started')
    expect(machine?.config.env).toMatchObject({ VERSION: '26.5' })
  })

  test('a machine Fly answers for as gone while it puts an update in place is waited for, and goes back', async () => {
    const { fake, runtime, handle } = await provisioned()
    fake.replacing = 3
    fake.replacingGone = true
    const changed = await runtime.apply(handle, { ...spec, env: { ...spec.env, VERSION: '26.4' } })
    // Fly's 404 mid-replace once failed this boot as a machine gone (staging, 2026-10-14).
    await runtime.waitRunning(changed, AbortSignal.timeout(5_000))
    // Going back, straight after the next update, as a rollback does.
    const next = await runtime.apply(changed, { ...spec, env: { ...spec.env, VERSION: '26.5' } })
    const back = await runtime.apply(next, spec)
    await runtime.waitRunning(back, AbortSignal.timeout(5_000))
    expect(decodeHandle(back).machineId).toBe(decodeHandle(handle).machineId)
    const machine = fake.machines.get(APP)?.[0]
    expect(machine?.config.env).toMatchObject({ VERSION: '26.3' })
  })

  test('an update Fly refuses while it puts the one before in place is asked again under the same lease', async () => {
    const { fake, client } = await provisioned()
    const machine = fake.machines.get(APP)?.[0]
    if (machine === undefined) throw new Error('no machine')
    // Another worker's update, its replace still under way, though reads came before it.
    Object.assign(machine, { replacingLeft: 2, replacedTo: 'started' })
    const leases = fake.count(`POST /v1/apps/${APP}/machines/${machine.id}/lease`)
    const config = { ...machine.config, env: { VERSION: '26.4' } }
    await updateMachine(client, 'test', APP, machine.id, config as never, undefined, false)
    expect(fake.count(`POST /v1/apps/${APP}/machines/${machine.id}/lease`)).toBe(leases + 1)
    expect(machine.config.env).toEqual({ VERSION: '26.4' })
    expect(fake.leases.size).toBe(0)
  })

  test('an apply on a machine Fly replaced under a new id changes that one, and names it', async () => {
    const { fake, runtime, handle } = await provisioned()
    const machine = fake.machines.get(APP)?.[0]
    if (machine === undefined) throw new Error('no machine')
    machine.id = 'm_replaced'
    const started = Date.now()
    const changed = await runtime.apply(handle, { ...spec, env: { ...spec.env, VERSION: '26.4' } })
    expect(decodeHandle(changed).machineId).toBe('m_replaced')
    expect(machine.config.env).toMatchObject({ VERSION: '26.4' })
    // Found at once: the app lists the machine in the old one's place.
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

// A resume Fly left starting: the boot's bound on it was up to ten seconds late, while the long
// poll it was in ran out.
describe('FlyRuntime waiting on a machine that never starts', () => {
  test('gives up when its signal says, mid long poll, not when the poll runs out', async () => {
    const { fake, runtime, handle } = await provisioned()
    const machine = fake.machines.get(APP)?.[0]
    if (machine === undefined) throw new Error('no machine')
    machine.state = 'starting'
    fake.holdWaits = true
    const asked = Date.now()
    await expect(runtime.waitRunning(handle, AbortSignal.timeout(300))).rejects.toThrow(
      'did not start in time',
    )
    expect(Date.now() - asked).toBeLessThan(2_000)
  })
})
