// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A world volume is made for its machine's guest, and Fly's refusal of one placed wrong is "no room". */
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { constants as HTTP } from 'node:http2'
import { HostFull, RuntimeFull, type RuntimeKey, type RuntimeSpec } from '../../app/ports/runtime.ts'
import { type FlySchemas, flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { launched } from './fly-runtime/responses.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { decodeHandle } from './handle.ts'
import { VOLUME_PLACEMENT_CAPACITY_STATUS } from './refusals.ts'

/** Fly's answer on staging to a machine whose existing volume's host had no room for it. */
const PLACEMENT_REFUSED = {
  error:
    "failed_precondition: insufficient resources to create new machine with existing volume 'vol_vly7wl5lxlp3d7p4'",
  status: 'volume_placement_capacity',
}

test('a volume placement refusal is a host with no room, not a failure', async () => {
  const endpoint = Bun.serve({
    port: 0,
    fetch: () => Response.json(PLACEMENT_REFUSED, { status: HTTP.HTTP_STATUS_PRECONDITION_FAILED }),
  })
  try {
    const client = flyClient('test', { baseUrl: endpoint.url.toString() })
    const result = await client.POST('/v1/apps/{app_name}/machines', {
      params: { path: { app_name: 'capacity-test' } },
      body: {},
    })
    expect(result.error).toMatchObject({ status: VOLUME_PLACEMENT_CAPACITY_STATUS })
    expect(() => launched(result, 'creating the machine')).toThrow(RuntimeFull)
    expect(() => launched(result, 'starting its machine', true)).toThrow(HostFull)
  } finally {
    endpoint.stop(true)
  }
})

test('every world volume asks for the guest of the machine it is made for', async () => {
  const fake = new FakeFly()
  const asked: Array<FlySchemas['CreateVolumeRequest']> = []
  const client = flyClient('test', {
    pace: { perSecond: 1000, burst: 1000 },
    fetch: (async (request: Request) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/volumes'))
        asked.push((await request.clone().json()) as FlySchemas['CreateVolumeRequest'])
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
  const progress = { step: async () => {}, handle: async () => {} }
  let handle = await runtime.ensureProvisioned(
    randomUUID() as RuntimeKey,
    { regionKey: 'here' },
    spec,
    progress,
  )
  const agrees = () => {
    const { app, machineId } = decodeHandle(handle)
    const guest = fake.machines.get(app)?.find((machine) => machine.id === machineId)?.config.guest
    expect(guest).toBeDefined()
    expect(guest).toEqual(asked.at(-1)?.compute)
  }
  agrees()
  const { snapshot } = await runtime.snapshot(handle)
  handle = await runtime.restore(handle, { kind: 'snapshot', snapshot }, spec, progress)
  agrees()
  handle = await runtime.restore(
    handle,
    { kind: 'archive', download: { url: 'https://archive.test/world.tar.gz' } },
    spec,
    progress,
  )
  agrees()
  handle = await runtime.relocate(handle, { regionKey: 'there' }, spec, progress)
  agrees()
  handle = await runtime.relocate(handle, { regionKey: 'here' }, spec, progress, snapshot)
  agrees()
  expect(asked).toHaveLength(5)
}, 30_000)
