// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's app runs the machine its handle names, and only that one. A restore or a move that
 * stopped after making its new machine leaves a second, which the next one clears as soon as its
 * own handle is saved, and the leftover sweep clears when nothing is in flight. A wake boots the
 * handle's machine, never one on a host Fly can't reach.
 */

import { describe, expect, test } from 'bun:test'
import type { ProgressSink, RuntimeHandle, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { decodeHandle, encodeHandle } from './handle.ts'

const KEY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' as RuntimeKey
const APP = 'bly-test-7a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d'
const PLACE = { regionKey: 'eu-central' }

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

function runtimeOn(fake: FakeFly) {
  return new FlyRuntime({
    client: flyClient('token', { fetch: fake.fetch as never, pace: { perSecond: 1000, burst: 1000 } }),
    org: 'blockly',
    deploymentId: 'test',
    regionMap: { 'eu-central': 'fra' },
    snapshotRetentionDays: 30,
    machineLimit: 50,
    platformMachines: 7,
  })
}

const serverMachines = (fake: FakeFly) =>
  (fake.machines.get(APP) ?? []).filter(
    (m) => (m.config.metadata as Record<string, string>).blockly_role === 'minecraft',
  )
const worldVolumes = (fake: FakeFly) =>
  (fake.volumes.get(APP) ?? []).filter((v) => v.name === 'minecraft_data')

/** A restore whose old machine's stop Fly refuses once, after its new machine is made. */
async function restoreStoppedPartway(fake: FakeFly, runtime: FlyRuntime, original: RuntimeHandle) {
  const { snapshot } = await runtime.snapshot(original)
  const saved: RuntimeHandle[] = []
  const progress: ProgressSink = { step: async () => {}, handle: async (h) => void saved.push(h) }
  const m1 = decodeHandle(original).machineId as string
  fake.leases.set(m1, 'someone-else')
  const failed = await runtime.restore(original, { kind: 'snapshot', snapshot }, spec, progress).then(
    () => 'restored',
    (error: unknown) => String(error),
  )
  fake.leases.delete(m1)
  expect(failed).toContain('taking the machine lease')
  expect(saved).toEqual([])
  return snapshot
}

describe('FlyRuntime keeping one server machine per app', () => {
  test('a restore tried again after one that stopped partway leaves one machine, which the next wake boots', async () => {
    const fake = new FakeFly()
    const runtime = runtimeOn(fake)
    const progress: ProgressSink = { step: async () => {}, handle: async () => {} }
    const original = await runtime.ensureProvisioned(KEY, PLACE, spec, progress)
    const snapshot = await restoreStoppedPartway(fake, runtime, original)
    expect(serverMachines(fake)).toHaveLength(2)

    // The operation's retry restores from the handle the database still names.
    const restored = await runtime.restore(original, { kind: 'snapshot', snapshot }, spec, progress)
    const wanted = decodeHandle(restored)
    expect(serverMachines(fake).map((m) => m.id)).toEqual([wanted.machineId as string])
    expect(worldVolumes(fake).map((v) => v.id)).toEqual([wanted.volumeId as string])
    expect(await runtime.clearLeftovers(restored, false)).toEqual([])

    // The server sleeps, then a player joins.
    await runtime.stop(restored)
    const woke = decodeHandle(await runtime.ensureProvisioned(KEY, PLACE, spec, progress))
    expect({ machine: woke.machineId, volume: woke.volumeId }).toEqual({
      machine: wanted.machineId,
      volume: wanted.volumeId,
    })
  }, 60_000)

  test('after a lost host is rebuilt elsewhere, the next wake boots the rebuilt machine', async () => {
    const fake = new FakeFly()
    const runtime = runtimeOn(fake)
    const progress: ProgressSink = { step: async () => {}, handle: async () => {} }
    const handle = await runtime.ensureProvisioned(KEY, PLACE, spec, progress)
    const { snapshot } = await runtime.snapshot(handle)
    const before = decodeHandle(handle)
    const lost = fake.machines.get(APP)?.[0]
    if (!lost || !before.machineId || !before.volumeId) throw new Error('not provisioned')
    // Its host stops answering (as fly-runtime.test.ts models it); Fly still lists what it last knew.
    lost.host_status = 'unreachable'
    fake.unreachable.add(before.machineId)
    fake.unreachable.add(before.volumeId)
    const rebuilt = decodeHandle(await runtime.relocate(handle, PLACE, spec, progress, snapshot))
    await runtime.stop(encodeHandle(rebuilt))
    const woke = decodeHandle(await runtime.ensureProvisioned(KEY, PLACE, spec, progress))
    expect(woke.machineId).toBe(rebuilt.machineId)
  }, 60_000)

  test('a wake given its handle boots the machine it names, whichever Fly lists first', async () => {
    const fake = new FakeFly()
    const runtime = runtimeOn(fake)
    const progress: ProgressSink = { step: async () => {}, handle: async () => {} }
    const original = await runtime.ensureProvisioned(KEY, PLACE, spec, progress)
    await restoreStoppedPartway(fake, runtime, original)
    await runtime.stop(original)
    const [first, second] = serverMachines(fake)
    if (!first || !second) throw new Error('expected two server machines')
    // The later machine listed first: Fly's order is not the handle's.
    fake.machines.set(APP, [second, first])
    const woke = decodeHandle(
      await runtime.ensureProvisioned(KEY, PLACE, spec, progress, null, { held: original }),
    )
    expect(woke.machineId).toBe(decodeHandle(original).machineId)
  }, 60_000)

  test('the leftover sweep destroys a server machine no handle names, then its volume', async () => {
    const fake = new FakeFly()
    const runtime = runtimeOn(fake)
    const progress: ProgressSink = { step: async () => {}, handle: async () => {} }
    const original = await runtime.ensureProvisioned(KEY, PLACE, spec, progress)
    await restoreStoppedPartway(fake, runtime, original)
    const ref = decodeHandle(original)
    const stray = serverMachines(fake).find((m) => m.id !== ref.machineId)
    const strayVolume = worldVolumes(fake).find((v) => v.id !== ref.volumeId)
    if (!stray || !strayVolume) throw new Error('expected a stray machine and volume')

    // The machine goes first, and its volume once Fly lets go of it.
    expect(await runtime.clearLeftovers(original, false)).toContain(stray.id)
    for (let pass = 0; pass < 5 && worldVolumes(fake).length > 1; pass++)
      await runtime.clearLeftovers(original, false)
    expect(serverMachines(fake).map((m) => m.id)).toEqual([ref.machineId as string])
    expect(worldVolumes(fake).map((v) => v.id)).toEqual([ref.volumeId as string])
  }, 60_000)
})
