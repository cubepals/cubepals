import { describe, expect, test } from 'bun:test'
import {
  type ProgressSink,
  RuntimeFull,
  type RuntimeHandle,
  type RuntimeKey,
  type RuntimeSpec,
} from '../../app/ports/runtime.ts'
import { longestSnapshotNeedDays } from '../../domain/account/entitlements.ts'
import { recordingTarget } from '../../testing/archive-target.ts'
import { FlyApiError, flyClient } from './client.ts'
import { FakeFly, type Json } from './fake-fly.ts'
import { FlyRuntime, keyFromApp, observationOf, serverCeilingOf, stateOf } from './fly-runtime.ts'
import { decodeHandle, decodeSnapshot, encodeHandle } from './handle.ts'
import { guestFor } from './machine-config.ts'

const MIB = 1024 ** 2

// ─── fixtures ──────────────────────────────────────────────────────────────────────────────

const KEY = '6276d3d7-5c80-4bd4-9d00-12818b8a4d38' as RuntimeKey
const APP = 'bly-test-6276d3d75c804bd49d0012818b8a4d38'

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

/** An organization with Fly's default machine limit, and the platform's own seven machines in it. */
const ORG_MACHINES = { machineLimit: 50, platformMachines: 7 }

function setup(fake = new FakeFly(), snapshotRetentionDays = longestSnapshotNeedDays()) {
  const runtime = new FlyRuntime({
    client: flyClient('token', { fetch: fake.fetch as never, pace: { perSecond: 1000, burst: 1000 } }),
    org: 'blockly',
    deploymentId: 'test',
    regionMap: { 'eu-central': 'fra', 'us-east': 'iad' },
    snapshotRetentionDays,
    ...ORG_MACHINES,
  })
  const steps: string[] = []
  const handles: RuntimeHandle[] = []
  const progress: ProgressSink = {
    step: async (name) => void steps.push(name),
    handle: async (handle) => void handles.push(handle),
  }
  return { fake, runtime, steps, handles, progress }
}

const provisioned = async () => {
  const s = setup()
  const handle = await s.runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec(), s.progress)
  return { ...s, handle }
}

// ─── tests ─────────────────────────────────────────────────────────────────────────────────

describe('FlyRuntime provisioning', () => {
  test('creates an app on its own network, a Flycast address, secrets, a volume and a started machine', async () => {
    const { fake, handle, steps, handles } = await provisioned()
    expect(fake.apps.get(APP)).toEqual({
      name: APP,
      network: APP,
      org: 'blockly',
      idempotency: `test:${KEY}`,
    })
    expect(fake.ips.get(APP)).toEqual([expect.objectContaining({ type: 'private_v6', org_slug: 'blockly' })])
    expect(fake.secrets.get(APP)).toEqual({ RCON_PASSWORD: 'secret' })
    const [volume] = fake.volumes.get(APP) ?? []
    // Snapshots last as long as the longest plan needs one: 14 kept plus 30 days of trash.
    expect(volume).toMatchObject({
      name: 'minecraft_data',
      region: 'fra',
      size_gb: 5,
      snapshot_retention: 44,
    })
    const [machine] = fake.machines.get(APP) ?? []
    expect(machine?.state).toBe('started')
    expect(machine?.config).toMatchObject({
      image: 'itzg/minecraft-server:2026.9.1-java25',
      env: { EULA: 'TRUE', VERSION: '26.3' },
      guest: { cpu_kind: 'performance', cpus: 1, memory_mb: 2048 },
      mounts: [{ volume: volume?.id, path: '/data' }],
      restart: { policy: 'on-failure', max_retries: 3 },
      stop_config: { signal: 'SIGTERM', timeout: '90s' },
      services: [
        {
          protocol: 'tcp',
          internal_port: 25565,
          ports: [{ port: 25565 }],
          autostart: false,
          autostop: 'off',
        },
        {
          protocol: 'tcp',
          internal_port: 25575,
          ports: [{ port: 25575 }],
          autostart: false,
          autostop: 'off',
        },
      ],
    })
    expect(JSON.stringify(machine?.config)).not.toContain('secret')
    expect(steps).toEqual(['allocating', 'storage', 'compute', 'booting'])
    expect(handles).toEqual([handle])
  })

  test('running it again creates nothing', async () => {
    const { fake, runtime, progress, handle } = await provisioned()
    const again = await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec(), progress)
    expect(again).toBe(handle)
    expect(fake.calls.filter((c) => c === 'POST /v1/apps').length).toBe(1)
    expect(fake.calls.filter((c) => c === `POST /v1/apps/${APP}/volumes`).length).toBe(1)
    expect(fake.calls.filter((c) => c === `POST /v1/apps/${APP}/machines`).length).toBe(1)
  })

  test('a changed spec updates the machine under a lease, and a larger disk grows the volume', async () => {
    const { fake, runtime, progress } = await provisioned()
    await runtime.ensureProvisioned(
      KEY,
      { regionKey: 'eu-central' },
      spec({ env: { VERSION: '26.4' }, storage: { mountPath: '/data', sizeGb: 10 } }),
      progress,
    )
    expect(fake.machines.get(APP)?.[0]?.config.env).toEqual({ VERSION: '26.4' })
    expect(fake.volumes.get(APP)?.[0]?.size_gb).toBe(10)
    expect(fake.leases.size).toBe(0)
  })

  test('a new machine is started once Fly has prepared it, not refused and retried', async () => {
    const s = setup()
    s.fake.prepareReads = 4
    await s.runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec(), s.progress)
    expect(s.fake.machines.get(APP)?.[0]?.state).toBe('started')
    expect(s.fake.refusedStarts).toBe(0)
    expect(s.fake.calls.filter((c) => c.endsWith('/wait')).length).toBeGreaterThan(0)
  })

  test('both audiences reach a port on the app’s Flycast address', async () => {
    const { runtime, handle } = await provisioned()
    expect(runtime.endpoint(handle, 'game', 'edge')).toEqual({ host: `${APP}.flycast`, port: 25565 })
    expect(runtime.endpoint(handle, 'rcon', 'control')).toEqual({ host: `${APP}.flycast`, port: 25575 })
  })

  test('an unmapped region is refused before anything is created', async () => {
    const { fake, runtime, progress } = setup()
    await expect(runtime.ensureProvisioned(KEY, { regionKey: 'mars' }, spec(), progress)).rejects.toThrow(
      'has no Fly placement',
    )
    expect(fake.calls).toEqual([])
  })
})

describe('FlyRuntime power', () => {
  test('an update of a started machine waits for its new run, past the old run stopping', async () => {
    const { fake, runtime, handle } = await provisioned()
    fake.replaceReads = 1
    const next = await runtime.apply(handle, spec({ env: { EULA: 'TRUE', VERSION: '26.3.1' } }))
    await runtime.waitRunning(next, AbortSignal.timeout(5_000))
    expect(fake.machines.get(APP)?.[0]?.state).toBe('started')
    expect((await runtime.observe(next)).state).toBe('running')
  })

  test('a new run that exits on its own after an update still fails its start', async () => {
    const { fake, runtime, handle } = await provisioned()
    const next = await runtime.apply(handle, spec({ env: { EULA: 'TRUE', VERSION: '26.3.1' } }))
    const machine = fake.machines.get(APP)?.[0]
    if (machine === undefined) throw new Error('no machine')
    // The new run's events start afresh: its own exit follows no update.
    machine.state = 'stopped'
    machine.events = [
      {
        type: 'exit',
        timestamp: Date.now() + 1_000,
        request: { exit_event: { exit_code: 0, requested_stop: false } },
      },
      { type: 'start', timestamp: Date.now() },
    ]
    await expect(runtime.waitRunning(next, AbortSignal.timeout(5_000))).rejects.toThrow(
      'The machine exited with code 0',
    )
  })

  test('stop holds the lease, sends the configured signal and waits for stopped', async () => {
    const { fake, runtime, handle } = await provisioned()
    await runtime.stop(handle)
    expect(fake.machines.get(APP)?.[0]?.state).toBe('stopped')
    expect(fake.count(`POST /v1/apps/${APP}/machines/m_`)).toBeGreaterThan(0)
    expect(fake.leases.size).toBe(0)
    const before = fake.calls.length
    await runtime.stop(handle)
    expect(fake.calls.length - before).toBe(1)
    expect((await runtime.observe(handle)).state).toBe('stopped')
  })

  test('a forced stop is a stop with SIGKILL, under the lease, waited for; a stopped machine is left alone', async () => {
    const { fake, runtime, handle } = await provisioned()
    await runtime.forceStop(handle)
    expect(fake.machines.get(APP)?.[0]?.state).toBe('stopped')
    expect(fake.stopSignals.at(-1)).toBe('SIGKILL')
    expect(fake.count(`POST /v1/apps/${APP}/machines/m_`)).toBeGreaterThan(0)
    expect(fake.leases.size).toBe(0)
    const before = fake.calls.length
    await runtime.forceStop(handle)
    expect(fake.calls.length - before).toBe(1)
  })

  test('apply on a running machine restarts it on the new config, and keeps it stopped when stopped', async () => {
    const { fake, runtime, handle } = await provisioned()
    const next = await runtime.apply(
      handle,
      spec({ ports: [{ name: 'game', port: 25566, protocol: 'tcp', audience: ['edge'] }] }),
    )
    expect(runtime.endpoint(next, 'game', 'edge').port).toBe(25566)
    expect(fake.machines.get(APP)?.[0]?.state).toBe('started')
    await runtime.stop(next)
    await runtime.apply(next, spec())
    expect(fake.machines.get(APP)?.[0]?.state).toBe('stopped')
  })

  test('a machine that exits on its own reads as crashed, at the time it exited', () => {
    const at = Date.now() - 90_000
    const machine = {
      state: 'stopped',
      events: [
        {
          type: 'exit',
          timestamp: at,
          request: { exit_event: { exit_code: 137, oom_killed: true, requested_stop: false } },
        },
      ],
    }
    expect(observationOf(machine as never)).toMatchObject({
      state: 'crashed',
      exit: { code: 137, oom: true },
      at: new Date(at),
    })
    const asked = {
      state: 'stopped',
      events: [
        { type: 'exit', timestamp: at, request: { exit_event: { exit_code: 0, requested_stop: true } } },
      ],
    }
    expect(observationOf(asked as never).state).toBe('stopped')
    expect(observationOf(null).state).toBe('absent')
  })

  test('a machine Fly started again after it failed says when it failed', () => {
    const at = Date.now() - 20_000
    const exit = (code: number, requested: boolean) => ({
      type: 'exit',
      timestamp: at,
      request: { exit_event: { exit_code: code, requested_stop: requested } },
    })
    expect(observationOf({ state: 'started', events: [exit(1, false)] } as never)).toMatchObject({
      state: 'running',
      failedAt: new Date(at),
    })
    expect(observationOf({ state: 'started', events: [exit(0, true)] } as never).failedAt).toBeUndefined()
    expect(observationOf({ state: 'started', events: [exit(143, true)] } as never).failedAt).toBeUndefined()
  })

  test('a start its host has no room for is RuntimeFull, as on any full runtime, and the next one can work', async () => {
    const { fake, runtime, handle } = await provisioned()
    await runtime.stop(handle)
    fake.refusal = {
      error:
        'aborted: could not reserve resource for machine: insufficient CPUs available to fulfill request',
    }
    // The port's own error: the server goes back to sleep, and the next join or press tries again.
    const refused = runtime.start(handle)
    await expect(refused).rejects.toBeInstanceOf(RuntimeFull)
    await expect(refused).rejects.toThrow('insufficient CPUs available')
    fake.refusal = null
    await runtime.start(handle)
    expect(fake.machines.get(APP)?.[0]?.state).toBe('started')
  })

  test('a machine Fly can’t make for want of room on the host is RuntimeFull; any other refusal is Fly’s', async () => {
    const { fake, runtime, progress } = setup()
    const make = () => runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec(), progress)
    fake.refusal = {
      error:
        'insufficient resources available to fulfill request: insufficient memory available to fulfill request',
    }
    await expect(make()).rejects.toBeInstanceOf(RuntimeFull)
    // Or said by the error's status alone.
    fake.refusal = { error: 'could not reserve resource for machine', status: 'insufficient_capacity' }
    await expect(make()).rejects.toBeInstanceOf(RuntimeFull)
    fake.refusal = { error: 'invalid config.guest: memory must be a multiple of 256' }
    const refused = make()
    await expect(refused).rejects.toBeInstanceOf(FlyApiError)
    await expect(refused).rejects.not.toBeInstanceOf(RuntimeFull)
    fake.refusal = null
    await make()
    expect(fake.machines.get(APP)?.[0]?.state).toBe('started')
  })

  test('a machine its host has no room to resize is RuntimeFull, and keeps the size it had', async () => {
    const { fake, runtime, handle } = await provisioned()
    const before = fake.machines.get(APP)?.[0]?.config
    fake.refusal = {
      error:
        'insufficient resources available to fulfill request: insufficient memory available to fulfill request',
    }
    const bigger = spec({ resources: { memoryMb: 8192 } })
    const refused = runtime.apply(handle, bigger)
    await expect(refused).rejects.toBeInstanceOf(RuntimeFull)
    expect(fake.machines.get(APP)?.[0]?.config).toEqual(before as Json)
    // The lease went with the refusal: the next change can be made.
    fake.refusal = null
    await runtime.apply(handle, bigger)
    expect(fake.machines.get(APP)?.[0]?.config).not.toEqual(before as Json)
  })

  test('a 429 waits out Retry-After and tries again', async () => {
    const { fake, runtime, handle } = await provisioned()
    fake.throttleOnce = true
    expect((await runtime.observe(handle)).state).toBe('running')
  })
})

describe('FlyRuntime storage', () => {
  test('a snapshot is handed back once Fly has finished writing it, not when it is first listed', async () => {
    const { fake, runtime, handle } = await provisioned()
    fake.snapshotReads = 1
    const taken = await runtime.snapshot(handle)
    const [written] = fake.snapshots.get(decodeHandle(handle).volumeId ?? '') ?? []
    expect(written?.status).toBe('created')
    expect(taken.sizeBytes).toBe(1234)
  })

  test('a snapshot an earlier attempt asked for is the one used, when Fly refuses another', async () => {
    const { fake, runtime, handle } = await provisioned()
    const volumeId = decodeHandle(handle).volumeId ?? ''
    const earlier = {
      id: 'vs_earlier',
      size: 1234,
      created_at: new Date().toISOString(),
      status: 'pending',
      readsLeft: 1,
    }
    fake.snapshots.set(volumeId, [earlier])
    const taken = await runtime.snapshot(handle)
    expect(fake.snapshots.get(volumeId)?.map((snap) => snap.id)).toEqual(['vs_earlier'])
    expect(decodeSnapshot(taken.snapshot).snapshotId).toBe('vs_earlier')
  })

  test('a snapshot is found by being new, and is not gone', async () => {
    const { runtime, handle } = await provisioned()
    const taken = await runtime.snapshot(handle)
    expect(taken.sizeBytes).toBe(1234)
    expect(await runtime.goneSnapshots([taken.snapshot])).toEqual(new Set())
  })

  test('a snapshot outlives its volume growing, and its volume being replaced', async () => {
    const { runtime, handle, progress } = await provisioned()
    const first = await runtime.snapshot(handle)
    // A bigger server grows the volume: the snapshot is the same one, whatever size it's listed at.
    const grown = await runtime.apply(handle, spec({ storage: { mountPath: '/data', sizeGb: 10 } }))
    const second = await runtime.snapshot(grown)
    expect(await runtime.goneSnapshots([first.snapshot, second.snapshot])).toEqual(new Set())
    // A restore puts the server on a new volume and deletes the old one, whose snapshots stay.
    await runtime.restore(grown, { kind: 'snapshot', snapshot: first.snapshot }, spec(), progress)
    expect(await runtime.goneSnapshots([first.snapshot, second.snapshot])).toEqual(new Set())
  })

  test('an existing volume keeps snapshots as long as the plans need now, from its next change', async () => {
    const { fake, handle } = await provisioned()
    expect(fake.volumes.get(APP)?.[0]?.snapshot_retention).toBe(longestSnapshotNeedDays())
    // The plans changed since the volume was made: the next apply brings it up to date.
    const later = setup(fake, 30)
    await later.runtime.apply(handle, spec())
    expect(fake.volumes.get(APP)?.[0]?.snapshot_retention).toBe(30)
  })

  test('a snapshot Fly no longer holds is gone; one it can say nothing about is not', async () => {
    const { fake, runtime, handle } = await provisioned()
    const kept = await runtime.snapshot(handle)
    const expired = await runtime.snapshot(handle)
    const volumeId = decodeHandle(handle).volumeId as string
    const expiredId = (fake.snapshots.get(volumeId) ?? []).at(-1)?.id
    fake.snapshots.set(
      volumeId,
      (fake.snapshots.get(volumeId) ?? []).filter((s) => s.id !== expiredId),
    )
    const foreign = 'docker-snap:v1:somewhere' as typeof kept.snapshot
    expect(await runtime.goneSnapshots([kept.snapshot, expired.snapshot, foreign])).toEqual(
      new Set([expired.snapshot]),
    )
  })

  test('restore puts a new machine on a volume from the snapshot, then removes the old pair', async () => {
    const { fake, runtime, handle, progress, handles } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    const before = decodeHandle(handle)
    const next = await runtime.restore(handle, { kind: 'snapshot', snapshot }, spec(), progress)
    const after = decodeHandle(next)
    expect(after.machineId).not.toBe(before.machineId)
    expect(after.volumeId).not.toBe(before.volumeId)
    expect(after.volumeId).not.toBeNull()
    expect(after.machineId).not.toBeNull()
    expect(fake.volumes.get(APP)?.map((v) => v.id)).toEqual([after.volumeId as string])
    expect(fake.volumes.get(APP)?.[0]).toMatchObject({ state: 'created' })
    expect(fake.machines.get(APP)?.map((m) => m.id)).toEqual([after.machineId as string])
    expect(fake.machines.get(APP)?.[0]?.state).toBe('started')
    expect(handles.at(-1)).toBe(next)
    expect(runtime.endpoint(next, 'game', 'edge')).toEqual(runtime.endpoint(handle, 'game', 'edge'))
  })

  test('a machine on an unreachable host is observed as lost, and rebuilt from a snapshot elsewhere', async () => {
    const { fake, runtime, handle, progress } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    const before = decodeHandle(handle)
    const machine = fake.machines.get(APP)?.[0]
    if (!machine || !before.machineId || !before.volumeId) throw new Error('not provisioned')
    machine.host_status = 'unreachable'
    fake.unreachable.add(before.machineId)
    fake.unreachable.add(before.volumeId)
    expect(await runtime.observe(handle)).toMatchObject({ state: 'unknown', hostLost: true })

    const stops = fake.count(`POST /v1/apps/${APP}/machines/${before.machineId}/stop`)
    const next = decodeHandle(
      await runtime.relocate(handle, { regionKey: 'eu-central' }, spec(), progress, snapshot),
    )
    // Nothing asked of the lost host, and what it holds is left for Fly to clear.
    expect(fake.count(`POST /v1/apps/${APP}/machines/${before.machineId}/stop`)).toBe(stops)
    expect(next.machineId).not.toBe(before.machineId)
    expect(next.volumeId).not.toBe(before.volumeId)
    expect(next.region).toBe('fra')
    const rebuilt = fake.volumes.get(APP)?.find((v) => v.id === next.volumeId)
    expect(rebuilt).toMatchObject({ region: 'fra', state: 'created' })
    expect(fake.volumes.get(APP)?.some((v) => v.id === before.volumeId)).toBe(true)
    // Clearing the lost host's machine and volume was tried, each retried as a 503 is, then left.
  }, 40_000)

  test('a handle is placed while its region maps where its machine is', async () => {
    const { fake, runtime, handle } = await provisioned()
    expect(runtime.isPlaced(handle, { regionKey: 'eu-central' })).toBe(true)
    expect(runtime.isPlaced(handle, { regionKey: 'us-east' })).toBe(false)
    // The region's Fly region was deprecated and remapped: the machine is no longer where it maps.
    const remapped = new FlyRuntime({
      client: flyClient('token', { fetch: fake.fetch as never, pace: { perSecond: 1000, burst: 1000 } }),
      org: 'blockly',
      deploymentId: 'test',
      regionMap: { 'eu-central': 'ams', 'us-east': 'iad' },
      snapshotRetentionDays: longestSnapshotNeedDays(),
      ...ORG_MACHINES,
    })
    expect(remapped.isPlaced(handle, { regionKey: 'eu-central' })).toBe(false)
  })

  test('relocate forks the volume into the new region; the same region is a no-op', async () => {
    const { fake, runtime, handle, progress } = await provisioned()
    expect(await runtime.relocate(handle, { regionKey: 'eu-central' }, spec(), progress)).toBe(handle)
    const moved = decodeHandle(await runtime.relocate(handle, { regionKey: 'us-east' }, spec(), progress))
    expect(moved.region).toBe('iad')
    expect(fake.volumes.get(APP)).toEqual([
      expect.objectContaining({
        id: moved.volumeId,
        region: 'iad',
        source_volume_id: decodeHandle(handle).volumeId,
      }),
    ])
  })

  test('a full region is refused before anything is made; with room, it provisions (§8)', async () => {
    const { fake, runtime, progress } = setup()
    fake.full.add('fra')
    // The port's own error, so the owner is told there was no room, not what Fly said.
    const refused = runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec(), progress)
    await expect(refused).rejects.toBeInstanceOf(RuntimeFull)
    await expect(refused).rejects.toThrow('nothing placeable for 2048 MB and 5 GB in fra')
    expect(fake.apps.size).toBe(0)
    expect(fake.placements.at(-1)).toMatchObject({
      org_slug: 'blockly',
      region: 'fra',
      count: 1,
      compute: { cpu_kind: 'performance', cpus: 1, memory_mb: 2048 },
      volume_size_bytes: 5 * 2 ** 30,
    })
    fake.full.delete('fra')
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec(), progress)
    // Running it again makes nothing, so asks for no room.
    const asked = fake.placements.length
    expect(await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec(), progress)).toBe(handle)
    expect(fake.placements.length).toBe(asked)
  })

  test('a move to a full region is refused while the server is untouched', async () => {
    const { fake, runtime, handle, progress } = await provisioned()
    fake.full.add('iad')
    await expect(runtime.relocate(handle, { regionKey: 'us-east' }, spec(), progress)).rejects.toThrow(
      'in iad',
    )
    expect(fake.machines.get(APP)?.[0]?.state).toBe('started')
    expect(fake.volumes.get(APP)?.map((v) => v.region)).toEqual(['fra'])
  })

  test('a region only paid plans may use must take the organization’s machines (§2)', async () => {
    const fake = new FakeFly()
    const runtime = new FlyRuntime({
      client: flyClient('t', { fetch: fake.fetch as never, pace: { perSecond: 1000, burst: 1000 } }),
      org: 'blockly',
      deploymentId: 'test',
      regionMap: { 'eu-central': 'fra', 'south-asia': 'bom' },
      snapshotRetentionDays: 44,
      ...ORG_MACHINES,
    })
    await expect(runtime.checkRegions()).rejects.toThrow('south-asia → bom needs a paid Fly plan')
    fake.paidPlan = true
    await runtime.checkRegions()
  })

  test('export runs the archive job on a temporary volume from the snapshot, then cleans up', async () => {
    const { fake, runtime, handle } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    const target = recordingTarget()
    const result = await runtime.exportSnapshot(snapshot, target)
    expect(result).toEqual({ sha256: '0123abcd', sizeBytes: 4096 })
    expect(fake.jobScripts[0]).toContain(
      "curl -fsS -X PUT --upload-file .blockly-export.tgz  'https://bucket.example/world.tgz?sig=1'",
    )
    expect(target.log.asked).toEqual([])
    expect(fake.machines.get(APP)?.map((m) => m.name)).toEqual(['minecraft'])
    expect(fake.volumes.get(APP)?.map((v) => v.name)).toEqual(['minecraft_data'])
  })

  test('an archive larger than one PUT carries waits on its volume while jobs send it in parts', async () => {
    const { fake, runtime, handle } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    fake.archiveBytes = 100 * MIB
    // Parts of 8 MiB: thirteen of them, more than one job sends.
    const target = recordingTarget({ maxPutBytes: 64 * MIB, partSize: 8 * MIB })
    expect(await runtime.exportSnapshot(snapshot, target)).toEqual({
      sha256: '0123abcd',
      sizeBytes: 100 * MIB,
    })
    expect(target.log.asked).toEqual([{ sizeBytes: 100 * MIB, most: 8 }])
    // The export packs and leaves it; then a job for parts 1 to 8, and one for 9 to 13, all on the
    // same volume, every part 8 MiB but the last.
    expect(fake.jobScripts).toHaveLength(3)
    expect(fake.jobScripts[0]).toContain(`-gt ${64 * MIB} ]`)
    expect(fake.jobScripts[1]).toContain(
      `  put_part 1 0 ${8 * MIB} 'https://bucket.example/world.tgz?sig=1&part=1' &&`,
    )
    expect(fake.jobScripts[1]).toContain(`  put_part 8 56 ${8 * MIB} `)
    expect(fake.jobScripts[1]).not.toContain('put_part 9 ')
    expect(fake.jobScripts[2]).toContain(`  put_part 9 64 ${8 * MIB} `)
    expect(fake.jobScripts[2]).toContain(
      `  put_part 13 96 ${4 * MIB} 'https://bucket.example/world.tgz?sig=1&part=13' &&`,
    )
    expect(target.log.completed).toEqual([
      Array.from({ length: 13 }, (_, index) => ({ number: index + 1, etag: `"etag-${index + 1}"` })),
    ])
    expect(target.log.aborted).toBe(0)
    expect(fake.machines.get(APP)?.map((m) => m.name)).toEqual(['minecraft'])
    expect(fake.volumes.get(APP)?.map((v) => v.name)).toEqual(['minecraft_data'])
  })

  test('a part that never goes drops the upload in parts, and the volume still goes', async () => {
    const { fake, runtime, handle } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    fake.archiveBytes = 100 * MIB
    fake.partsFail = true
    const target = recordingTarget({ maxPutBytes: 64 * MIB })
    await expect(runtime.exportSnapshot(snapshot, target)).rejects.toThrow()
    expect(target.log.completed).toEqual([])
    expect(target.log.aborted).toBe(1)
    expect(fake.machines.get(APP)?.map((m) => m.name)).toEqual(['minecraft'])
    expect(fake.volumes.get(APP)?.map((v) => v.name)).toEqual(['minecraft_data'])
  })

  test('a helper job that ends without a result fails at once, and its machine and volume go', async () => {
    const { fake, runtime, handle } = await provisioned()
    const { snapshot } = await runtime.snapshot(handle)
    fake.jobGone = true
    await expect(
      runtime.exportSnapshot(snapshot, recordingTarget({ url: 'https://bucket.example/world.tgz' })),
    ).rejects.toThrow('stopped without a result')
    expect(fake.machines.get(APP)?.map((m) => m.name)).toEqual(['minecraft'])
    expect(fake.volumes.get(APP)?.map((v) => v.name)).toEqual(['minecraft_data'])
  })
})

describe('FlyRuntime resting worlds', () => {
  test('release lets the machine and the volume go and keeps the app, its address and its secrets', async () => {
    const { fake, runtime, handle } = await provisioned()
    const released = await runtime.release(handle)
    expect(decodeHandle(released)).toMatchObject({ app: APP, region: 'fra', machineId: null, volumeId: null })
    // Nothing that bills is left.
    expect(
      fake.machines.get(APP)?.filter((m) => !['destroyed', 'destroying'].includes(m.state)) ?? [],
    ).toEqual([])
    expect(
      fake.volumes.get(APP)?.filter((v) => !['destroyed', 'pending_destroy'].includes(v.state)) ?? [],
    ).toEqual([])
    // The app and its Flycast address stay, so the edge's route never changes.
    expect(fake.apps.has(APP)).toBe(true)
    expect(runtime.endpoint(released, 'game', 'edge')).toEqual({ host: `${APP}.flycast`, port: 25565 })
    // Asked again, there is nothing more to let go.
    expect(decodeHandle(await runtime.release(released))).toMatchObject({ machineId: null, volumeId: null })
  })

  test('a released world comes back from its archive on a new volume and machine, at the same address', async () => {
    const { fake, runtime, handle, progress } = await provisioned()
    const released = await runtime.release(handle)
    const back = await runtime.restore(
      released,
      { kind: 'archive', download: { url: 'https://bucket.example/rest.tgz?sig=1' } },
      spec(),
      progress,
    )
    const ref = decodeHandle(back)
    expect(ref.machineId).not.toBeNull()
    expect(ref.volumeId).not.toBeNull()
    expect(fake.jobScripts.at(-1)).toContain(
      "curl -fsSL 'https://bucket.example/rest.tgz?sig=1' | tar -xzf - -C /data",
    )
    expect(runtime.endpoint(back, 'game', 'edge')).toEqual({ host: `${APP}.flycast`, port: 25565 })
  })

  test('a released world asks for room before anything is made', async () => {
    const { fake, runtime, handle, progress } = await provisioned()
    const released = await runtime.release(handle)
    fake.full.add('fra')
    const volumes = fake.volumes.get(APP)?.length ?? 0
    await expect(
      runtime.restore(
        released,
        { kind: 'archive', download: { url: 'https://bucket.example/rest.tgz' } },
        spec(),
        progress,
      ),
    ).rejects.toBeInstanceOf(RuntimeFull)
    expect(fake.volumes.get(APP)?.length ?? 0).toBe(volumes)
  })
})

describe('FlyRuntime inventory and removal', () => {
  test('inventory and changes list only this deployment’s servers', async () => {
    const { fake, runtime, handle } = await provisioned()
    fake.apps.set('bly-other-00000000000000000000000000000000', {
      name: 'bly-other-00000000000000000000000000000000',
      network: '',
      org: '',
      idempotency: '',
    })
    fake.apps.set('some-unrelated-app', { name: 'some-unrelated-app', network: '', org: '', idempotency: '' })
    const found = []
    for await (const item of runtime.inventory()) found.push(item)
    expect(found.map((f) => f.key)).toEqual([KEY])
    expect(decodeHandle(found[0]?.handle ?? '')).toEqual(decodeHandle(handle))
    const changed = []
    for await (const item of runtime.observeChanged(new Date(0))) changed.push(item)
    expect(changed.map((c) => [c.key, c.observation.state])).toEqual([[KEY, 'running']])
  })

  test('changes come from one org list, a minute wider than asked, with destroyed machines gone', async () => {
    const { fake, runtime, handle, progress } = await provisioned()
    const since = new Date()
    await Bun.sleep(5)
    await runtime.stop(handle)
    const changed = []
    for await (const item of runtime.observeChanged(since)) changed.push(item)
    expect(changed.map((c) => [c.key, c.observation.state])).toEqual([[KEY, 'stopped']])
    expect(runtime.sameCompute(changed[0]?.handle ?? handle, handle)).toBe(true)
    const query = fake.orgLists.at(-1)
    expect(query?.get('include_deleted')).toBe('true')
    expect(Date.parse(query?.get('updated_after') ?? '')).toBe(since.getTime() - 60_000)
    // A move replaces the machine: the one it replaced is listed gone, and is not the server's any more.
    // Read once Fly has prepared the new one; until then it lists as created, which reads as starting.
    fake.prepareReads = 0
    const moved = await runtime.relocate(handle, { regionKey: 'us-east' }, spec(), progress)
    const after = []
    for await (const item of runtime.observeChanged(since)) after.push(item)
    const gone = after.filter((c) => c.observation.state === 'absent')
    expect(gone.map((c) => runtime.sameCompute(c.handle, handle))).toEqual([true])
    expect(gone.map((c) => runtime.sameCompute(c.handle, moved))).toEqual([false])
    expect(after.filter((c) => runtime.sameCompute(c.handle, moved)).map((c) => c.observation.state)).toEqual(
      ['stopped'],
    )
  })

  test('a region the org list could not read fails the pass, after what it could read', async () => {
    const { fake, runtime } = await provisioned()
    fake.unreadRegions.push('iad')
    const changed: string[] = []
    const reading = (async () => {
      for await (const item of runtime.observeChanged(new Date(0))) changed.push(item.key)
    })()
    await expect(reading).rejects.toThrow("couldn't list the machines in iad")
    expect(changed).toEqual([KEY])
  })

  test('decommission removes the machine and keeps the volume; destroy removes the app', async () => {
    const { fake, runtime, handle } = await provisioned()
    await runtime.decommission(handle)
    expect(fake.machines.get(APP)).toEqual([])
    expect(fake.volumes.get(APP)?.length).toBe(1)
    await runtime.destroy(KEY)
    expect(fake.apps.has(APP)).toBe(false)
    await runtime.destroy(KEY)
  })

  test('destroy refuses another deployment’s app', async () => {
    const { runtime } = setup()
    const foreign =
      `fly:v1:${Buffer.from(JSON.stringify({ deployment: 'prod', serverId: KEY, app: 'bly-prod-x', region: 'fra', volumeId: 'v', machineId: 'm', ports: {} })).toString('base64url')}` as RuntimeHandle
    await expect(runtime.destroy(foreign)).rejects.toThrow('does not belong to deployment test')
  })

  test('checkRegions reads the live API’s `Regions` and refuses unmapped codes', async () => {
    const { runtime } = setup()
    await runtime.checkRegions()
    const wrong = new FlyRuntime({
      client: flyClient('t', { fetch: new FakeFly().fetch as never, pace: { perSecond: 1000, burst: 1000 } }),
      org: 'o',
      deploymentId: 'd',
      regionMap: { a: 'old' },
      snapshotRetentionDays: 90,
      ...ORG_MACHINES,
    })
    await expect(wrong.checkRegions()).rejects.toThrow('a → old')
    // Fly keeps snapshots for 60 days at most.
    expect(wrong.snapshotLifetimeDays).toBe(60)
  })
})

describe('FlyRuntime tags', () => {
  const OTHER = '11111111-2222-4333-8444-555555555555' as RuntimeKey
  const metadataOf = (fake: FakeFly) => fake.machines.get(APP)?.[0]?.config.metadata as Record<string, string>

  test('writes whose server it is onto its machine, without restarting it, and only what changed', async () => {
    const { fake, runtime } = await provisioned()
    const machine = fake.machines.get(APP)?.[0]
    const tags = new Map([
      [KEY, { owner: 'alex@example.test', name: 'Weekend world', plan: 'plus' }],
      [OTHER, { owner: 'sam@example.test', name: 'Nowhere yet', plan: 'free' }],
    ])
    const changes = fake.count(`POST /v1/apps/${APP}/machines/`)
    expect(await runtime.tag(tags)).toBe(1)
    expect(metadataOf(fake)).toMatchObject({
      blockly_owner: 'alex@example.test',
      blockly_name: 'Weekend world',
      blockly_plan: 'plus',
      blockly_server: KEY,
    })
    // No update, stop or start: the metadata endpoint alone.
    expect(machine?.state).toBe('started')
    expect(fake.count(`POST /v1/apps/${APP}/machines/`)).toBe(changes)
    // Asked again with nothing new, it writes nothing: every server, every time, is cheap.
    const patches = fake.count('PATCH ')
    expect(await runtime.tag(tags)).toBe(0)
    expect(fake.count('PATCH ')).toBe(patches)
    // A rename is written; a tag no longer asked for goes.
    expect(await runtime.tag(new Map([[KEY, { owner: 'alex@example.test', name: 'Monday world' }]]))).toBe(1)
    expect(metadataOf(fake).blockly_name).toBe('Monday world')
    expect(metadataOf(fake)).not.toHaveProperty('blockly_plan')
    // Another deployment's machines, and its own keys, are never a tag's.
    await expect(runtime.tag(new Map([[KEY, { server: 'x' }]]))).rejects.toThrow("server can't be a tag")
  })

  test('a change or a restore keeps the tags, and the spec digest never sees them', async () => {
    const { fake, runtime, handle, progress } = await provisioned()
    await runtime.tag(new Map([[KEY, { owner: 'alex@example.test', name: 'Weekend world' }]]))
    const digest = metadataOf(fake).blockly_spec_digest
    const applied = await runtime.apply(handle, spec({ env: { EULA: 'TRUE', VERSION: '26.4' } }))
    expect(metadataOf(fake)).toMatchObject({
      blockly_owner: 'alex@example.test',
      blockly_name: 'Weekend world',
    })
    const { snapshot } = await runtime.snapshot(applied)
    await runtime.restore(applied, { kind: 'snapshot', snapshot }, spec(), progress)
    expect(metadataOf(fake)).toMatchObject({
      blockly_owner: 'alex@example.test',
      blockly_name: 'Weekend world',
    })
    expect(metadataOf(fake).blockly_spec_digest).toBe(digest)
    // Provisioning again finds nothing to change: tags are not drift.
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec(), progress)
    expect(metadataOf(fake).blockly_owner).toBe('alex@example.test')
  })

  test('a handle says where to look at Fly, and what an hour and a month cost there', async () => {
    const { runtime, handle } = await provisioned()
    const ref = decodeHandle(handle)
    expect(runtime.locate(handle)).toEqual({
      names: [
        { label: 'App', value: APP },
        { label: 'Machine', value: ref.machineId as string },
        { label: 'Volume', value: ref.volumeId as string },
        { label: 'Region', value: 'fra' },
      ],
      link: `https://fly.io/apps/${APP}/machines`,
    })
    const inIad = encodeHandle({ ...ref, region: 'iad' })
    const hour = (at: RuntimeHandle, memoryMb: number) =>
      runtime.prices(at, { memoryMb, storageGb: 5 }).runningHourCents
    // Fly's list of 1 October 2026: a 3 GB server is one performance core with a gigabyte more,
    // 4 GB two cores and 8 GB four, each with theirs.
    expect(hour(inIad, 3072)).toBeCloseTo(5.417, 3)
    expect(hour(inIad, 4096)).toBeCloseTo(9.167, 3)
    expect(hour(inIad, 8192)).toBeCloseTo(18.334, 3)
    expect(runtime.prices(inIad, { memoryMb: 3072, storageGb: 5 }).storageMonthCents).toBe(75)
    // Frankfurt costs more than Virginia.
    expect(hour(handle, 3072)).toBeCloseTo(6.251, 3)
    expect(hour(handle, 8192)).toBeCloseTo(21.155, 3)
  })
})

describe('Fly helpers', () => {
  test('servers run on performance cores, as many as the capacity research gave each size', () => {
    // Every shared size was throttled and crashed; one core carries up to 3 GB.
    expect(guestFor(2048)).toEqual({ cpu_kind: 'performance', cpus: 1, memory_mb: 2048 })
    expect(guestFor(3072)).toEqual({ cpu_kind: 'performance', cpus: 1, memory_mb: 3072 })
    expect(guestFor(4096)).toEqual({ cpu_kind: 'performance', cpus: 2, memory_mb: 4096 })
    // Four cores come with at least 8 GB: a 6 GB server gets them, and keeps its own heap.
    expect(guestFor(6144)).toEqual({ cpu_kind: 'performance', cpus: 4, memory_mb: 8192 })
    expect(guestFor(8192)).toEqual({ cpu_kind: 'performance', cpus: 4, memory_mb: 8192 })
    // Past four cores' 32 GB, eight; memory comes in whole gigabytes.
    expect(guestFor(40960)).toEqual({ cpu_kind: 'performance', cpus: 8, memory_mb: 40960 })
    expect(guestFor(2560)).toEqual({ cpu_kind: 'performance', cpus: 1, memory_mb: 3072 })
    expect(() => guestFor(256 * 1024)).toThrow()
  })

  test('the organization holds two machines a server beside the platform’s own, and the runtime says how many', () => {
    // A restore or a move makes its new machine before the old one goes; an export runs a helper.
    expect(serverCeilingOf(50, 7)).toBe(21)
    expect(serverCeilingOf(250, 7)).toBe(121)
    expect(serverCeilingOf(8, 7)).toBe(0)
    expect(setup().runtime.serverCeiling).toBe(21)
  })

  test('app names map back to server ids, and only this deployment’s', () => {
    expect(keyFromApp(APP, 'bly-test-')).toBe(KEY)
    expect(keyFromApp(APP, 'bly-prod-')).toBeNull()
    expect(keyFromApp('bly-test-nothex', 'bly-test-')).toBeNull()
  })

  test('machine states map onto the runtime port’s', () => {
    expect(
      ['started', 'created', 'stopping', 'stopped', 'destroyed', 'failed', 'weird'].map(stateOf),
    ).toEqual(['running', 'starting', 'stopping', 'stopped', 'absent', 'crashed', 'unknown'])
  })
})
