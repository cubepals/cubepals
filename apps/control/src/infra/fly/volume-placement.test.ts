// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Game volume placement carries the exact guest used by provisioning, restore and relocation; refused copies preserve storage. */
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  RuntimeAtLimit,
  type RuntimeKey,
  type RuntimeSpec,
  RuntimeUnsupported,
} from '../../app/ports/runtime.ts'
import { type FlySchemas, flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { ensureVolume } from './fly-runtime/volumes.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { decodeHandle } from './handle.ts'

function fixture() {
  const fake = new FakeFly(),
    volumes: Array<FlySchemas['CreateVolumeRequest']> = [],
    steps: string[] = []
  const client = flyClient('test', {
    pace: { perSecond: 1000, burst: 1000 },
    fetch: (async (request: Request) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/volumes'))
        volumes.push((await request.clone().json()) as FlySchemas['CreateVolumeRequest'])
      return fake.fetch(request)
    }) as never,
  })
  const runtime = new FlyRuntime({
    client,
    org: 'blockly',
    deploymentId: 'placement-test',
    regionMap: { here: 'fra', there: 'iad' },
    snapshotRetentionDays: 30,
    machineLimit: 50,
    platformMachines: 6,
    roomWait: { firstMs: 5, maxMs: 10, forMs: 100 },
  })
  const spec: RuntimeSpec = {
    image: 'test-image',
    env: { VERSION: '26.3' },
    secrets: {},
    resources: { memoryMb: 8192 },
    storage: { mountPath: '/data', sizeGb: 5 },
    ports: [],
    stop: { signal: 'SIGTERM', timeoutSeconds: 90 },
    labels: {},
  }
  const progress = {
    step: async (step: string) => {
      steps.push(step)
    },
    handle: async () => {},
  }
  const key = randomUUID() as RuntimeKey
  return { fake, runtime, spec, progress, key, volumes, steps, client }
}

test('every game allocation requests the same compute as its machine, without replacing existing storage', async () => {
  const f = fixture()
  let handle = await f.runtime.ensureProvisioned(f.key, { regionKey: 'here' }, f.spec, f.progress)
  const app = decodeHandle(handle).app
  const agrees = () =>
    expect(
      f.fake.machines.get(app)?.find((machine) => machine.id === decodeHandle(handle).machineId)?.config
        .guest,
    ).toEqual(f.volumes.at(-1)?.compute)
  agrees()
  const first = decodeHandle(handle).volumeId
  await f.runtime.ensureProvisioned(f.key, { regionKey: 'here' }, f.spec, f.progress)
  expect(f.volumes).toHaveLength(1)
  expect(decodeHandle(handle).volumeId).toBe(first)
  const { snapshot } = await f.runtime.snapshot(handle)
  expect(f.runtime.owns(handle)).toBe(true)
  expect(f.runtime.ownsSnapshot(snapshot)).toBe(true)
  expect(await f.runtime.capacity()).toBeNull()
  expect(await f.runtime.hasRoom({ regionKey: 'here' }, { memoryMb: 8192, storageGb: 5 })).toBe(true)
  expect(await f.runtime.hasRoom({ regionKey: 'missing' }, { memoryMb: 8192, storageGb: 5 })).toBe(false)
  await expect(f.runtime.deleteSnapshot(snapshot)).rejects.toBeInstanceOf(RuntimeUnsupported)
  expect((await f.runtime.exec(handle, ['echo', 'placement'], 30)).exitCode).toBe(0)
  handle = await f.runtime.restore(handle, { kind: 'snapshot', snapshot }, f.spec, f.progress)
  agrees()
  handle = await f.runtime.restore(
    handle,
    { kind: 'archive', download: { url: 'https://archive.test/world.tar.gz' } },
    f.spec,
    f.progress,
  )
  agrees()
  handle = await f.runtime.relocate(handle, { regionKey: 'there' }, f.spec, f.progress)
  agrees()
  handle = await f.runtime.relocate(handle, { regionKey: 'here' }, f.spec, f.progress, snapshot)
  agrees()
  expect(f.volumes).toHaveLength(5)
}, 30_000)

test('an archive restore refused for capacity cleans its empty copy and keeps the running world', async () => {
  const f = fixture()
  const handle = await f.runtime.ensureProvisioned(f.key, { regionKey: 'here' }, f.spec, f.progress)
  const app = decodeHandle(handle).app,
    before = f.fake.volumes.get(app)?.map((volume) => volume.id)
  const vacant = await f.runtime.adopt(randomUUID() as RuntimeKey, { regionKey: 'here' }, f.spec)
  expect(decodeHandle(vacant).machineId).toBeNull()
  f.fake.machineLimit = 1
  await expect(
    f.runtime.restore(
      handle,
      { kind: 'archive', download: { url: 'https://archive.test/world.tar.gz' } },
      f.spec,
      f.progress,
    ),
  ).rejects.toBeInstanceOf(RuntimeAtLimit)
  expect(f.steps).toContain('waiting_for_room')
  expect(f.fake.volumes.get(app)?.map((volume) => volume.id)).toEqual(before)
  expect((await f.runtime.observe(handle)).state).toBe('running')
})

test('volume discovery without placement hints keeps and grows the existing world disk', async () => {
  const f = fixture()
  const handle = await f.runtime.ensureProvisioned(f.key, { regionKey: 'here' }, f.spec, f.progress)
  const { app, volumeId } = decodeHandle(handle)
  if (volumeId === null) throw new Error('The running server has no world volume')
  const volume = await ensureVolume(f.client, app, 'fra', 10, 30)
  expect(volume.id).toEqual(volumeId)
  expect(f.fake.volumes.get(app)).toHaveLength(1)
  expect(f.volumes).toHaveLength(1)
  expect(f.fake.volumes.get(app)?.[0]?.size_gb).toBe(10)
  expect((await f.runtime.observe(handle)).state).toBe('running')
})
