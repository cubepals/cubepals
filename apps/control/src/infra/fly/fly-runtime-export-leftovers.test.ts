// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An export's volume and its helper machine go even when the export doesn't clear them itself:
 * interrupted by a control-plane restart, or with its final delete refused past its wait. The
 * export still counts once its archive is up; `release` lets go of both, the leftover sweep
 * deletes an export volume no machine mounts, and destroys a helper past its lifetime.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { ProgressSink, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { recordingTarget } from '../../testing/archive-target.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { HELPER_LIFETIME_MS } from './fly-runtime/helper-machine.ts'
import { FlyRuntime } from './fly-runtime.ts'

const KEY = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' as RuntimeKey
const APP = 'bly-test-1c2d3e4f5a6b4c7d8e9f0a1b2c3d4e5f'

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

function runtimeOn(fetch: (request: Request) => Promise<Response>) {
  return new FlyRuntime({
    client: flyClient('token', { fetch: fetch as never, pace: { perSecond: 1000, burst: 1000 } }),
    org: 'blockly',
    deploymentId: 'test',
    regionMap: { 'eu-central': 'fra' },
    snapshotRetentionDays: 30,
    machineLimit: 50,
    platformMachines: 7,
  })
}
const progress: ProgressSink = { step: async () => {}, handle: async () => {} }
const exportsLeft = (fake: FakeFly) =>
  (fake.volumes.get(APP) ?? [])
    .filter((v) => v.name === 'blockly_export')
    .map((v) => `${v.id} ${v.size_gb} GB`)
const helpersLeft = (fake: FakeFly) =>
  (fake.machines.get(APP) ?? [])
    .filter((m) => (m.config.metadata as Record<string, string>).blockly_role === 'helper')
    .map((m) => `${m.id} ${m.state}`)

describe('FlyRuntime clearing what an export left', () => {
  let clock: ReturnType<typeof spyOn> | null = null
  afterEach(() => {
    clock?.mockRestore()
    clock = null
  })

  test('after a control plane restart mid-export, release lets go of its volume and helper', async () => {
    const fake = new FakeFly()
    // The process dies once the helper runs its job: every request after that never returns.
    let dead = false
    const dying = (request: Request): Promise<Response> => {
      if (dead) return new Promise(() => {})
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/exec')) dead = true
      return fake.fetch(request)
    }
    const before = runtimeOn(dying)
    const handle = await before.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
    const { snapshot } = await before.snapshot(handle)
    void before.exportSnapshot(snapshot, recordingTarget())
    while (!dead) await new Promise((resolve) => setTimeout(resolve, 10))

    // The control plane comes back. Its sweeps run over the server, and later it goes to rest.
    const after = runtimeOn(fake.fetch)
    expect(exportsLeft(fake)).toHaveLength(1)
    expect(helpersLeft(fake)).toHaveLength(1)
    // A young helper may still be working: the sweep leaves it, and the volume it mounts.
    expect(await after.clearLeftovers(handle, false)).toEqual([])
    const released = await after.release(handle)
    expect(released).toBeDefined()
    // What release promises: what is let go is everything that bills.
    expect(exportsLeft(fake)).toEqual([])
    expect(helpersLeft(fake)).toEqual([])
  })

  test('an export whose final delete Fly refuses past its wait succeeds, and the sweep deletes the volume', async () => {
    const fake = new FakeFly()
    const runtime = runtimeOn(fake.fetch)
    const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
    const { snapshot } = await runtime.snapshot(handle)
    // Fly goes on holding the volume for the helper it destroyed, as it held a wake's (2026-10-10).
    const realDelete = fake.fetch
    let held = false
    const fetch = async (request: Request) => {
      const url = new URL(request.url)
      if (request.method === 'DELETE' && url.pathname.includes('/machines/')) held = true
      if (held && request.method === 'DELETE' && url.pathname.includes('/volumes/') && !clock) {
        const realNow = Date.now.bind(Date)
        let skew = 0
        clock = spyOn(Date, 'now').mockImplementation(() => {
          skew += 61_000
          return realNow() + skew
        })
        fake.heldDeletes = 1_000
      }
      return realDelete(request)
    }
    const exporting = runtimeOn(fetch)
    const outcome = await exporting.exportSnapshot(snapshot, recordingTarget()).then(
      () => 'exported',
      (error: unknown) => String(error),
    )
    clock?.mockRestore()
    clock = null
    fake.heldDeletes = 0
    expect(outcome).toBe('exported')
    expect(exportsLeft(fake)).toHaveLength(1)
    // Fly lets go; the next sweep deletes it, and keeps the world.
    const left = (fake.volumes.get(APP) ?? []).find((v) => v.name === 'blockly_export')?.id
    if (left === undefined) throw new Error('no export volume')
    expect(await runtime.clearLeftovers(handle, false)).toEqual([left])
    expect(exportsLeft(fake)).toEqual([])
    expect((fake.volumes.get(APP) ?? []).map((v) => v.name)).toEqual(['minecraft_data'])
  }, 30_000)

  test('the sweep destroys a helper past its lifetime, then the export volume it mounted', async () => {
    const fake = new FakeFly()
    let dead = false
    const dying = (request: Request): Promise<Response> => {
      if (dead) return new Promise(() => {})
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/exec')) dead = true
      return fake.fetch(request)
    }
    const before = runtimeOn(dying)
    const handle = await before.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
    const { snapshot } = await before.snapshot(handle)
    void before.exportSnapshot(snapshot, recordingTarget())
    while (!dead) await new Promise((resolve) => setTimeout(resolve, 10))
    const helper = (fake.machines.get(APP) ?? []).find(
      (m) => (m.config.metadata as Record<string, string>).blockly_role === 'helper',
    )
    if (!helper) throw new Error('no helper')
    // Fly hasn't destroyed it by itself past its lifetime and then some.
    helper.created_at = new Date(Date.now() - HELPER_LIFETIME_MS * 2).toISOString()

    const after = runtimeOn(fake.fetch)
    expect(await after.clearLeftovers(handle, false)).toContain(helper.id)
    for (let pass = 0; pass < 5 && exportsLeft(fake).length > 0; pass++)
      await after.clearLeftovers(handle, false)
    expect(helpersLeft(fake)).toEqual([])
    expect(exportsLeft(fake)).toEqual([])
    expect((fake.volumes.get(APP) ?? []).map((v) => v.name)).toEqual(['minecraft_data'])
  })
})
