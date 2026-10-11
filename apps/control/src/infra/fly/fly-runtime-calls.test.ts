// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { ProgressSink, RuntimeHandle, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { recordingTarget } from '../../testing/archive-target.ts'
import { flyClient } from './client.ts'
import { FakeFly, type Json } from './fake-fly.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { decodeHandle, decodeSnapshot } from './handle.ts'

// The calls FlyRuntime makes of Fly, in order, and what it sends: the order of side effects that
// leases, cleanup and capacity checks depend on, pinned flow by flow against the in-memory Fly.

const MIB = 1024 ** 2
const KEY = '6276d3d7-5c80-4bd4-9d00-12818b8a4d38' as RuntimeKey
const APP = 'bly-test-6276d3d75c804bd49d0012818b8a4d38'
const at = (path = '') => `/v1/apps/${APP}${path}`

const spec = (overrides: Partial<RuntimeSpec> = {}): RuntimeSpec => ({
  image: 'itzg/minecraft-server:2026.9.1-java25',
  env: { EULA: 'TRUE', VERSION: '26.3' },
  secrets: { RCON_PASSWORD: 'secret' },
  resources: { memoryMb: 2048 },
  storage: { mountPath: '/data', sizeGb: 5 },
  ports: [
    { name: 'game', port: 25565, protocol: 'tcp', audience: ['edge'] },
    { name: 'rcon', port: 25575, protocol: 'tcp', audience: ['control'] },
  ],
  stop: { signal: 'SIGTERM', timeoutSeconds: 90 },
  labels: {},
  ...overrides,
})

interface Sent {
  call: string
  body: Json | null
  nonce: string | null
}

/**
 * A runtime on a fresh in-memory Fly, every request recorded on its way there; `rewrite` may change
 * what Fly answers.
 */
function setup(rewrite?: (call: string, response: Response) => Promise<Response>) {
  const fake = new FakeFly()
  const sent: Sent[] = []
  const fetch = async (request: Request): Promise<Response> => {
    const call = `${request.method} ${new URL(request.url).pathname}`
    const body = ['POST', 'PUT', 'PATCH'].includes(request.method)
      ? ((await request
          .clone()
          .json()
          .catch(() => null)) as Json | null)
      : null
    sent.push({ call, body, nonce: request.headers.get('fly-machine-lease-nonce') })
    const response = await fake.fetch(request)
    return rewrite ? rewrite(call, response) : response
  }
  const runtime = new FlyRuntime({
    client: flyClient('token', { fetch: fetch as never, pace: { perSecond: 1000, burst: 1000 } }),
    org: 'blockly',
    deploymentId: 'test',
    regionMap: { 'eu-central': 'fra', 'us-east': 'iad' },
    snapshotRetentionDays: 44,
    machineLimit: 50,
    platformMachines: 7,
  })
  const progress: ProgressSink = { step: async () => {}, handle: async () => {} }
  /** The calls made since `mark`. */
  const callsSince = (mark: number) => fake.calls.slice(mark)
  return { fake, runtime, progress, sent, callsSince }
}

async function provisioned(rewrite?: (call: string, response: Response) => Promise<Response>) {
  const s = setup(rewrite)
  const handle = await s.runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec(), s.progress)
  return { ...s, handle, mark: s.fake.calls.length }
}

describe('FlyRuntime calls, in order', () => {
  test('a first provision and start', async () => {
    const { fake } = await provisioned()
    expect(fake.calls).toEqual([
      `GET ${at('/machines')}`,
      'POST /v1/platform/placements',
      `GET ${at()}`,
      'POST /v1/apps',
      `GET ${at('/ip_assignments')}`,
      `POST ${at('/ip_assignments')}`,
      `POST ${at('/secrets')}`,
      `GET ${at('/volumes')}`,
      `POST ${at('/volumes')}`,
      `GET ${at('/machines')}`,
      `POST ${at('/machines')}`,
      `GET ${at('/machines/m_2')}`,
      `GET ${at('/machines/m_2/wait')}`,
      `GET ${at('/machines/m_2')}`,
      `POST ${at('/machines/m_2/start')}`,
    ])
  })

  test('a stop', async () => {
    const { runtime, handle, mark, callsSince } = await provisioned()
    await runtime.stop(handle)
    expect(callsSince(mark)).toEqual([
      `GET ${at('/machines/m_2')}`,
      `POST ${at('/machines/m_2/lease')}`,
      `POST ${at('/machines/m_2/stop')}`,
      `DELETE ${at('/machines/m_2/lease')}`,
      `GET ${at('/machines/m_2')}`,
    ])
  })

  test('a forced stop', async () => {
    const { runtime, handle, mark, callsSince } = await provisioned()
    await runtime.forceStop(handle)
    expect(callsSince(mark)).toEqual([
      `GET ${at('/machines/m_2')}`,
      `POST ${at('/machines/m_2/lease')}`,
      `POST ${at('/machines/m_2/stop')}`,
      `DELETE ${at('/machines/m_2/lease')}`,
      `GET ${at('/machines/m_2')}`,
    ])
  })

  test('a start of a stopped machine', async () => {
    const { runtime, handle, callsSince } = await provisioned()
    await runtime.stop(handle)
    const mark = callsSince(0).length
    await runtime.start(handle)
    expect(callsSince(mark)).toEqual([`GET ${at('/machines/m_2')}`, `POST ${at('/machines/m_2/start')}`])
  })

  test('an apply that grows the volume and changes the running machine', async () => {
    const { runtime, handle, mark, callsSince } = await provisioned()
    await runtime.apply(
      handle,
      spec({ env: { VERSION: '26.4' }, storage: { mountPath: '/data', sizeGb: 10 } }),
    )
    expect(callsSince(mark)).toEqual([
      `POST ${at('/secrets')}`,
      `GET ${at('/volumes/vol_1')}`,
      `PUT ${at('/volumes/vol_1/extend')}`,
      `GET ${at('/machines/m_2')}`,
      `POST ${at('/machines/m_2/lease')}`,
      `POST ${at('/machines/m_2')}`,
      `DELETE ${at('/machines/m_2/lease')}`,
    ])
  })

  test('a snapshot', async () => {
    const { runtime, handle, mark, callsSince } = await provisioned()
    await runtime.snapshot(handle)
    expect(callsSince(mark)).toEqual([
      `GET ${at('/volumes/vol_1/snapshots')}`,
      `POST ${at('/volumes/vol_1/snapshots')}`,
      `GET ${at('/volumes/vol_1/snapshots')}`,
      `GET ${at('/volumes/vol_1')}`,
    ])
  })

  test('an export in one PUT', async () => {
    const { runtime, handle, callsSince } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    const mark = callsSince(0).length
    await runtime.exportSnapshot(snapshot, recordingTarget())
    expect(callsSince(mark)).toEqual([
      `POST ${at('/volumes')}`,
      `GET ${at('/volumes/vol_4')}`,
      `GET ${at('/volumes/vol_4')}`,
      `POST ${at('/machines')}`,
      `GET ${at('/machines/m_5')}`,
      `POST ${at('/machines/m_5/exec')}`,
      `POST ${at('/machines/m_5/exec')}`,
      `DELETE ${at('/machines/m_5')}`,
      `GET ${at('/machines/m_5')}`,
      `DELETE ${at('/volumes/vol_4')}`,
    ])
  })

  test('an export in parts', async () => {
    const { fake, runtime, handle, callsSince } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    fake.archiveBytes = 100 * MIB
    const mark = callsSince(0).length
    await runtime.exportSnapshot(snapshot, recordingTarget({ maxPutBytes: 64 * MIB, partSize: 8 * MIB }))
    expect(callsSince(mark)).toEqual([
      `POST ${at('/volumes')}`,
      `GET ${at('/volumes/vol_4')}`,
      `GET ${at('/volumes/vol_4')}`,
      `POST ${at('/machines')}`,
      `GET ${at('/machines/m_5')}`,
      `POST ${at('/machines/m_5/exec')}`,
      `POST ${at('/machines/m_5/exec')}`,
      `DELETE ${at('/machines/m_5')}`,
      `GET ${at('/machines/m_5')}`,
      `POST ${at('/machines')}`,
      `GET ${at('/machines/m_6')}`,
      `POST ${at('/machines/m_6/exec')}`,
      `POST ${at('/machines/m_6/exec')}`,
      `DELETE ${at('/machines/m_6')}`,
      `GET ${at('/machines/m_6')}`,
      `POST ${at('/machines')}`,
      `GET ${at('/machines/m_7')}`,
      `POST ${at('/machines/m_7/exec')}`,
      `POST ${at('/machines/m_7/exec')}`,
      `DELETE ${at('/machines/m_7')}`,
      `GET ${at('/machines/m_7')}`,
      `DELETE ${at('/volumes/vol_4')}`,
    ])
  })

  test('a restore from a snapshot into a new volume', async () => {
    const { runtime, handle, progress, callsSince } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    const mark = callsSince(0).length
    await runtime.restore(handle, { kind: 'snapshot', snapshot }, spec(), progress)
    expect(callsSince(mark)).toEqual([
      `POST ${at('/volumes')}`,
      `GET ${at('/machines/m_2')}`,
      `GET ${at('/machines/m_2')}`,
      `POST ${at('/machines/m_2/lease')}`,
      `POST ${at('/machines/m_2/stop')}`,
      `DELETE ${at('/machines/m_2/lease')}`,
      `GET ${at('/machines/m_2')}`,
      `POST ${at('/secrets')}`,
      `POST ${at('/machines')}`,
      `GET ${at('/volumes/vol_4')}`,
      `GET ${at('/volumes/vol_4')}`,
      `DELETE ${at('/machines/m_2')}`,
      `GET ${at('/machines/m_2')}`,
      `DELETE ${at('/volumes/vol_1')}`,
      `GET ${at('/machines/m_6')}`,
      `GET ${at('/machines/m_6/wait')}`,
      `GET ${at('/machines/m_6')}`,
      `POST ${at('/machines/m_6/start')}`,
    ])
  })

  test('a move to another region', async () => {
    const { runtime, handle, progress, mark, callsSince } = await provisioned()
    await runtime.relocate(handle, { regionKey: 'us-east' }, spec(), progress)
    expect(callsSince(mark)).toEqual([
      'POST /v1/platform/placements',
      `GET ${at('/machines/m_2')}`,
      `POST ${at('/machines/m_2/lease')}`,
      `POST ${at('/machines/m_2/stop')}`,
      `DELETE ${at('/machines/m_2/lease')}`,
      `GET ${at('/machines/m_2')}`,
      `GET ${at('/volumes/vol_1')}`,
      `POST ${at('/volumes')}`,
      `GET ${at('/machines/m_2')}`,
      `GET ${at('/machines/m_2')}`,
      `POST ${at('/secrets')}`,
      `POST ${at('/machines')}`,
      `GET ${at('/volumes/vol_4')}`,
      `GET ${at('/volumes/vol_4')}`,
      `DELETE ${at('/machines/m_2')}`,
      `GET ${at('/machines/m_2')}`,
      `DELETE ${at('/volumes/vol_1')}`,
    ])
  })

  test('a destroy', async () => {
    const { runtime, mark, callsSince } = await provisioned()
    await runtime.destroy(KEY)
    expect(callsSince(mark)).toEqual([`DELETE ${at()}`])
  })
})

describe('FlyRuntime calls, in order, for a resting world', () => {
  test('a release of a running server', async () => {
    const { runtime, handle, mark, callsSince } = await provisioned()
    await runtime.release(handle)
    expect(callsSince(mark)).toEqual([
      `GET ${at('/machines/m_2')}`,
      `POST ${at('/machines/m_2/lease')}`,
      `POST ${at('/machines/m_2/stop')}`,
      `DELETE ${at('/machines/m_2/lease')}`,
      `GET ${at('/machines/m_2')}`,
      `DELETE ${at('/machines/m_2')}`,
      `GET ${at('/machines/m_2')}`,
      `GET ${at('/machines')}`,
      `DELETE ${at('/volumes/vol_1')}`,
      `GET ${at('/volumes')}`,
    ])
  })

  test('a released world restored from its archive', async () => {
    const { runtime, handle, progress, callsSince } = await provisioned()
    const released = await runtime.release(handle)
    const mark = callsSince(0).length
    await runtime.restore(
      released,
      { kind: 'archive', download: { url: 'https://bucket.example/rest.tgz?sig=1' } },
      spec(),
      progress,
    )
    expect(callsSince(mark)).toEqual([
      'POST /v1/platform/placements',
      `GET ${at()}`,
      `GET ${at('/ip_assignments')}`,
      `POST ${at('/volumes')}`,
      `GET ${at('/volumes/vol_4')}`,
      `POST ${at('/machines')}`,
      `GET ${at('/machines/m_5')}`,
      `POST ${at('/machines/m_5/exec')}`,
      `POST ${at('/machines/m_5/exec')}`,
      `DELETE ${at('/machines/m_5')}`,
      `GET ${at('/machines/m_5')}`,
      `POST ${at('/secrets')}`,
      `POST ${at('/machines')}`,
      `GET ${at('/volumes/vol_4')}`,
      `GET ${at('/volumes')}`,
    ])
  })
})

describe('FlyRuntime requests', () => {
  test('a stop takes the lease, stops with its nonce and the configured signal, and lets the lease go', async () => {
    const { runtime, handle, sent } = await provisioned()
    const from = sent.length
    await runtime.stop(handle)
    const [, lease, stop, release] = sent.slice(from)
    expect(lease?.body).toEqual({ ttl: 120, description: 'blockly test' })
    expect(stop?.body).toEqual({ signal: 'SIGTERM', timeout: '90s' })
    expect(stop?.nonce).toStartWith('nonce_')
    expect(release?.call).toBe(`DELETE ${at(`/machines/${decodeHandle(handle).machineId}/lease`)}`)
    expect(release?.nonce).toBe(stop?.nonce ?? '')
  })

  test('a forced stop is SIGKILL with a second to go, under the lease', async () => {
    const { runtime, handle, sent } = await provisioned()
    const from = sent.length
    await runtime.forceStop(handle)
    const [, lease, stop, release] = sent.slice(from)
    expect(lease?.body).toEqual({ ttl: 120, description: 'blockly test' })
    expect(stop?.body).toEqual({ signal: 'SIGKILL', timeout: '1s' })
    expect(release?.nonce).toBe(stop?.nonce ?? '')
  })

  test('an update goes with the lease’s nonce and the secrets version machines must see', async () => {
    const { runtime, handle, sent } = await provisioned()
    const from = sent.length
    await runtime.apply(handle, spec({ env: { VERSION: '26.4' } }))
    const update = sent
      .slice(from)
      .find((s) => s.call === `POST ${at(`/machines/${decodeHandle(handle).machineId}`)}`)
    expect(update?.nonce).toStartWith('nonce_')
    expect(update?.body).toMatchObject({ skip_launch: false, min_secrets_version: 2 })
  })

  test('volumes are made with Fly’s own backups off and the snapshot retention', async () => {
    const { runtime, handle, progress, sent } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    await runtime.exportSnapshot(snapshot, recordingTarget())
    await runtime.restore(handle, { kind: 'snapshot', snapshot }, spec(), progress)
    const snapshotId = decodeSnapshot(snapshot).snapshotId
    expect(sent.filter((s) => s.call === `POST ${at('/volumes')}`).map((s) => s.body)).toEqual([
      {
        auto_backup_enabled: false,
        snapshot_retention: 44,
        name: 'minecraft_data',
        region: 'fra',
        size_gb: 5,
      },
      {
        auto_backup_enabled: false,
        snapshot_retention: 44,
        name: 'blockly_export',
        region: 'fra',
        size_gb: 10,
        snapshot_id: snapshotId,
      },
      {
        auto_backup_enabled: false,
        snapshot_retention: 44,
        name: 'minecraft_data',
        region: 'fra',
        size_gb: 5,
        snapshot_id: snapshotId,
      },
    ])
  })

  test('machines are made with skip_launch, the server’s name, and the secrets version', async () => {
    const { runtime, handle, progress, sent } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    await runtime.restore(handle, { kind: 'snapshot', snapshot }, spec(), progress)
    const made = sent.filter((s) => s.call === `POST ${at('/machines')}`).map((s) => s.body)
    expect(made).toEqual([
      expect.objectContaining({
        name: 'minecraft',
        region: 'fra',
        skip_launch: true,
        min_secrets_version: 1,
      }),
      expect.objectContaining({
        name: expect.stringMatching(/^minecraft-[0-9a-z]+$/),
        region: 'fra',
        skip_launch: true,
        min_secrets_version: 2,
      }),
    ])
  })

  test('a helper machine is the curl image on the smallest shared machine, and never restarts', async () => {
    const { runtime, handle, sent } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    const from = sent.length
    await runtime.exportSnapshot(snapshot, recordingTarget())
    const volume = sent.slice(from).find((s) => s.call === `POST ${at('/volumes')}`)
    const helper = sent.slice(from).find((s) => s.call === `POST ${at('/machines')}`)
    expect(helper?.body).toEqual({
      name: expect.stringMatching(/^helper-[0-9a-z]+$/),
      region: 'fra',
      config: {
        image: 'curlimages/curl:8.22.0',
        init: { exec: ['/bin/sleep', '86400'] },
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
        mounts: [{ volume: expect.stringMatching(/^vol_/), path: '/data' }],
        restart: { policy: 'no' },
        auto_destroy: true,
        metadata: { blockly_deployment: 'test', blockly_role: 'helper' },
      },
    })
    expect(volume).toBeDefined()
    // The job's launch and each poll of its result are execs of thirty seconds.
    const execs = sent.slice(from).filter((s) => s.call.endsWith('/exec'))
    expect(execs.map((s) => s.body?.timeout)).toEqual([30, 30])
    expect(((execs[0]?.body?.command ?? []) as string[]).slice(0, 3)).toEqual([
      'sh',
      '-c',
      'printf "%s" "$0" > /tmp/job.sh && { nohup sh /tmp/job.sh > /tmp/job.log 2>&1 & echo $! > /tmp/job.pid; }',
    ])
  })
})

describe('FlyRuntime failures', () => {
  test('a helper job too long to hand to Fly fails, and its machine still goes', async () => {
    const { fake, runtime, handle, progress, callsSince } = await provisioned()
    const released = await runtime.release(handle)
    const mark = callsSince(0).length
    const url = `https://bucket.example/rest.tgz?sig=${'x'.repeat(17_000)}`
    await expect(
      runtime.restore(released, { kind: 'archive', download: { url } }, spec(), progress),
    ).rejects.toThrow('The helper job is too long to hand to Fly')
    expect(callsSince(mark)).toEqual([
      'POST /v1/platform/placements',
      `GET ${at()}`,
      `GET ${at('/ip_assignments')}`,
      `POST ${at('/volumes')}`,
      `GET ${at('/volumes/vol_4')}`,
      `POST ${at('/machines')}`,
      `GET ${at('/machines/m_5')}`,
      `DELETE ${at('/machines/m_5')}`,
      `GET ${at('/machines/m_5')}`,
    ])
    expect(fake.machines.get(APP)).toEqual([])
  })

  test('a release of another deployment’s server is refused before anything is asked of Fly', async () => {
    const { fake, runtime } = setup()
    const foreign =
      `fly:v1:${Buffer.from(JSON.stringify({ deployment: 'prod', serverId: KEY, app: 'bly-prod-x', region: 'fra', volumeId: 'v', machineId: 'm', ports: {} })).toString('base64url')}` as RuntimeHandle
    await expect(runtime.release(foreign)).rejects.toThrow('bly-prod-x does not belong to deployment test')
    expect(fake.calls).toEqual([])
  })

  test('a snapshot Fly could not write fails', async () => {
    const failing = async (call: string, response: Response) => {
      if (!call.startsWith('GET ') || !call.endsWith('/snapshots')) return response
      const listed = (await response.json()) as Json[]
      return Response.json(listed.map((s) => (s.status === 'pending' ? { ...s, status: 'failed' } : s)))
    }
    const { fake, runtime, handle, mark, callsSince } = await provisioned(failing)
    fake.snapshotReads = 1
    await expect(runtime.snapshot(handle)).rejects.toThrow('Fly could not take the snapshot')
    expect(callsSince(mark)).toEqual([
      `GET ${at('/volumes/vol_1/snapshots')}`,
      `POST ${at('/volumes/vol_1/snapshots')}`,
      `GET ${at('/volumes/vol_1/snapshots')}`,
    ])
  })
})
