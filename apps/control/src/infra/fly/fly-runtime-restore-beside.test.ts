// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FlyRuntime's restore fills its new volume while the world it replaces is still being saved, and
 * makes no machine on it, stops nothing and deletes nothing until that world is kept. If it isn't,
 * the new volume goes and the server's machine and volume are as they were.
 */

import { describe, expect, test } from 'bun:test'
import type { ProgressSink, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { decodeHandle } from './handle.ts'

const KEY = '9a3e7c51-2b4d-4e8f-a1c6-5d7b9e0f2a34' as RuntimeKey
const APP = 'bly-test-9a3e7c512b4d4e8fa1c65d7b9e0f2a34'

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
  const { snapshot } = await runtime.snapshot(handle)
  return { fake, runtime, handle, progress, from: { kind: 'snapshot' as const, snapshot } }
}

/** A promise settled when the test says, as a save still being taken is. */
function pending() {
  let keep = () => {}
  let lose = (_error: Error) => {}
  const kept = new Promise<void>((resolve, reject) => {
    keep = resolve
    lose = reject
  })
  return { kept, keep, lose }
}

const volumeIds = (fake: FakeFly) => (fake.volumes.get(APP) ?? []).map((v) => v.id)
const machinesMade = (fake: FakeFly, since: number) =>
  fake.calls.slice(since).filter((call) => call === `POST /v1/apps/${APP}/machines`)

describe('FlyRuntime restoring beside the world it replaces', () => {
  test('fills the new volume at once, and replaces nothing until the old world is kept', async () => {
    const { fake, runtime, handle, progress, from } = await provisioned()
    const old = decodeHandle(handle)
    const mark = fake.calls.length
    const save = pending()
    const restoring = runtime.restore(handle, from, spec, progress, { kept: save.kept })
    for (let i = 0; i < 100 && volumeIds(fake).length < 2; i++) await Bun.sleep(5)
    await Bun.sleep(50)
    expect(volumeIds(fake)).toHaveLength(2)
    expect(machinesMade(fake, mark)).toEqual([])
    expect(fake.calls.slice(mark).some((call) => call.includes('/stop') || call.startsWith('DELETE'))).toBe(
      false,
    )

    save.keep()
    const next = decodeHandle(await restoring)
    expect(machinesMade(fake, mark)).toHaveLength(1)
    expect(volumeIds(fake)).toEqual([next.volumeId ?? 'none'])
    expect(next.volumeId).not.toBe(old.volumeId)
  })

  test('a world that is not kept leaves the server as it was, the new volume gone', async () => {
    const { fake, runtime, handle, progress, from } = await provisioned()
    const old = decodeHandle(handle)
    const mark = fake.calls.length
    const save = pending()
    const restoring = runtime.restore(handle, from, spec, progress, { kept: save.kept })
    for (let i = 0; i < 100 && volumeIds(fake).length < 2; i++) await Bun.sleep(5)
    save.lose(new Error('the snapshot failed'))

    await expect(restoring).rejects.toThrow('the snapshot failed')
    expect(volumeIds(fake)).toEqual([old.volumeId ?? 'none'])
    expect(machinesMade(fake, mark)).toEqual([])
    expect((fake.machines.get(APP) ?? []).map((m) => m.id)).toEqual([old.machineId ?? 'none'])
  })
})
