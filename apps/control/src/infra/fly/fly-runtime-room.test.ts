// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FlyRuntime against an in-memory Fly whose organization is at its machine limit: work that needs
 * one more machine for a while waits for one, says so, and leaves the server as it was meanwhile;
 * a new server's own machine is refused at once, so placement can look elsewhere.
 */

import { describe, expect, spyOn, test } from 'bun:test'
import {
  type ProgressSink,
  RuntimeAtLimit,
  RuntimeFull,
  type RuntimeKey,
  type RuntimeSpec,
  RuntimeUnsupported,
} from '../../app/ports/runtime.ts'
import { recordingTarget } from '../../testing/archive-target.ts'
import { type FlySchemas, flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { createVolume, VOLUME_NAME } from './fly-runtime/volumes.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { decodeHandle, encodeHandle } from './handle.ts'

const KEY = '6276d3d7-5c80-4bd4-9d00-12818b8a4d38' as RuntimeKey
const OTHER = '0c0e2f4a-7a51-4b8e-9d7e-4f1d2b3c4a5e' as RuntimeKey
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

/** A running server in an organization that holds no machine more than it has. */
async function atTheLimit(forMs = 5000) {
  const fake = new FakeFly()
  const client = flyClient('token', { fetch: fake.fetch as never, pace: { perSecond: 1000, burst: 1000 } })
  const runtime = new FlyRuntime({
    client,
    org: 'blockly',
    deploymentId: 'test',
    regionMap: { 'eu-central': 'fra' },
    snapshotRetentionDays: 30,
    machineLimit: 50,
    platformMachines: 6,
    roomWait: { firstMs: 10, maxMs: 40, forMs },
  })
  const steps: string[] = []
  /** What the server's machine was doing when the work began to wait. */
  let whileWaiting: string | undefined
  const progress: ProgressSink = {
    step: async (step) => {
      steps.push(step)
      if (step === 'waiting_for_room') whileWaiting = fake.machines.get(APP)?.[0]?.state
    },
    handle: async () => {},
  }
  const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
  fake.machineLimit = 1
  steps.length = 0
  return { fake, runtime, handle, progress, steps, whileWaiting: () => whileWaiting }
}

/** Another server's machine going, a moment after the work began to wait. */
const freesSoon = (fake: FakeFly) =>
  setTimeout(() => {
    fake.machineLimit = 2
  }, 50)

describe('FlyRuntime at the organization’s machine limit', () => {
  test('a restore waits for a machine, saying so, with the server running, then runs once one frees', async () => {
    const { fake, runtime, handle, progress, steps, whileWaiting } = await atTheLimit()
    const { snapshot } = await runtime.snapshot(handle)
    freesSoon(fake)
    const next = decodeHandle(await runtime.restore(handle, { kind: 'snapshot', snapshot }, spec, progress))
    expect(steps).toEqual(['storage', 'compute', 'waiting_for_room'])
    expect(whileWaiting()).toBe('started')
    expect(fake.machines.get(APP)?.map((m) => [m.id, m.state])).toEqual([
      [next.machineId as string, 'started'],
    ])
    expect(fake.volumes.get(APP)?.map((v) => v.id)).toEqual([next.volumeId as string])
    const place = { regionKey: 'eu-central' }
    const other = await runtime.ensureProvisioned(OTHER, place, spec, progress)
    const from = { kind: 'snapshot' as const, snapshot }
    await expect(runtime.restore(other, from, spec, progress)).rejects.toThrow()
    await expect(runtime.relocate(other, place, spec, progress, snapshot)).rejects.toThrow()
    const api = flyClient('token', { fetch: fake.fetch as never })
    const data = { name: VOLUME_NAME, region: 'fra', size_gb: spec.storage.sizeGb }
    await Promise.all([1, 2, 3, 4].map(() => createVolume(api, APP, data, 30)))
    await expect(runtime.release(encodeHandle(next))).rejects.toThrow()
  })

  test('Fly’s limit is asked again until a machine frees, never a failure', async () => {
    const { fake, runtime, handle, progress } = await atTheLimit()
    const { snapshot } = await runtime.snapshot(handle)
    freesSoon(fake)
    const creates = () =>
      fake.count(`POST /v1/apps/${APP}/machines`) - fake.count(`POST /v1/apps/${APP}/machines/`)
    const before = creates()
    await runtime.restore(handle, { kind: 'snapshot', snapshot }, spec, progress)
    expect(creates() - before).toBeGreaterThan(1)
  })

  test('an export’s helper waits for a machine too', async () => {
    const { fake, runtime, handle } = await atTheLimit()
    const { snapshot } = await runtime.snapshot(handle)
    freesSoon(fake)
    expect(await runtime.exportSnapshot(snapshot, recordingTarget())).toMatchObject({ sizeBytes: 4096 })
    expect(fake.volumes.get(APP)).toHaveLength(1)
  })

  test('with no machine freed in all the wait, the server is as it was and the work is refused as no room', async () => {
    const { fake, runtime, handle, progress } = await atTheLimit(100)
    const before = decodeHandle(handle)
    const { snapshot } = await runtime.snapshot(handle)
    const refused = await runtime
      .restore(handle, { kind: 'snapshot', snapshot }, spec, progress)
      .catch((e) => e)
    expect(refused).toBeInstanceOf(RuntimeAtLimit)
    expect(fake.machines.get(APP)?.map((m) => [m.id, m.state])).toEqual([
      [before.machineId as string, 'started'],
    ])
    expect(fake.volumes.get(APP)?.map((v) => v.id)).toEqual([before.volumeId as string])
  })

  test('a new server’s own machine is refused at once, as a full runtime, for placement to look elsewhere', async () => {
    const { runtime, progress, steps } = await atTheLimit()
    const refused = await runtime
      .ensureProvisioned(OTHER, { regionKey: 'eu-central' }, spec, progress)
      .catch((e) => e)
    expect(refused).toBeInstanceOf(RuntimeFull)
    expect(steps).not.toContain('waiting_for_room')
  })
})

test('validation runtime ownership and a refused archive restore preserve the original world', async () => {
  const { fake, runtime, handle, progress, steps } = await atTheLimit(100)
  const { snapshot } = await runtime.snapshot(handle)
  expect(runtime.owns(handle)).toBe(true)
  expect(runtime.ownsSnapshot(snapshot)).toBe(true)
  expect(await runtime.capacity()).toBeNull()
  expect(await runtime.hasRoom({ regionKey: 'eu-central' }, { memoryMb: 2048, storageGb: 5 })).toBe(true)
  expect(await runtime.hasRoom({ regionKey: 'missing' }, { memoryMb: 2048, storageGb: 5 })).toBe(false)
  expect(runtime.owns(await runtime.adopt(OTHER, { regionKey: 'eu-central' }, spec))).toBe(true)
  await expect(runtime.deleteSnapshot(snapshot)).rejects.toBeInstanceOf(RuntimeUnsupported)
  expect((await runtime.exec(handle, ['echo', 'validation'], 30)).exitCode).toBe(0)
  const stop = spyOn(runtime, 'stop').mockRejectedValueOnce(new Error('graceful stop unavailable'))
  try {
    await runtime.restart(handle)
  } finally {
    stop.mockRestore()
  }
  await expect(
    runtime.restore(
      handle,
      { kind: 'archive', download: { url: 'https://archive.test/world.tar.gz' } },
      spec,
      progress,
    ),
  ).rejects.toBeInstanceOf(RuntimeAtLimit)
  expect(steps).toContain('waiting_for_room')
  expect(fake.volumes.get(APP)?.map((volume) => volume.id)).toEqual([decodeHandle(handle).volumeId as string])
  expect((await runtime.observe(handle)).state).toBe('running')
}, 15_000)

test('a decommissioned runtime keeps its regionless world volume for reprovisioning', async () => {
  const { fake, runtime, handle, progress } = await atTheLimit()
  const volume = fake.volumes.get(APP)?.[0]
  if (!volume) throw new Error('The fixture volume is missing')
  await runtime.decommission(handle)
  const released = encodeHandle({ ...decodeHandle(handle), machineId: null })
  await runtime.decommission(released)
  await runtime.stop(released)
  await expect(runtime.exec(released, ['echo'], 1)).rejects.toThrow('This server has no machine')
  const publicVolume: FlySchemas['Volume'] = volume
  delete publicVolume.region
  const replacement = await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
  expect(decodeHandle(replacement).volumeId).toBe(decodeHandle(handle).volumeId)
  expect(fake.machines.get(APP)?.[0]?.region).toBe('fra')
  expect(fake.volumes.get(APP)?.map((kept) => kept.id)).toEqual([volume.id as string])
})
