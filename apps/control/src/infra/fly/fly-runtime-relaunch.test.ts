// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FlyRuntime telling a resume Fly launched anew: Fly gives a machine a new version when it launches
 * it on a start rather than resuming its memory (production, 2026-11-18, a version minted 0.1 s into
 * the start), and the wake says so at once, so nobody waits on an answer from memory that can't come.
 */

import { expect, test } from 'bun:test'
import type { ProgressSink, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { FlyRuntime } from './fly-runtime.ts'

const KEY = '3c1d7a52-8e4f-4b6a-9d2c-7f0e5a1b3c4d' as RuntimeKey
const APP = 'bly-test-3c1d7a528e4f4b6a9d2c7f0e5a1b3c4d'

const spec: RuntimeSpec = {
  image: 'itzg/minecraft-server:2026.9.1-java25',
  env: { EULA: 'TRUE', VERSION: '26.3' },
  secrets: { RCON_PASSWORD: 'secret' },
  resources: { memoryMb: 3072 },
  storage: { mountPath: '/data', sizeGb: 5 },
  ports: [{ name: 'game', port: 25565, protocol: 'tcp', audience: ['edge'] }],
  stop: { signal: 'SIGTERM', timeoutSeconds: 90 },
  labels: {},
}

/** A server asleep with its memory, whose machine is at version `v1`; `launches` makes its next start a launch. */
async function asleep() {
  const fake = new FakeFly()
  const fly = { launches: false }
  const fetch = async (request: Request) => {
    const answer = await fake.fetch(request)
    // Fly's launch: a new version of the machine, made as it answers the start.
    if (fly.launches && request.method === 'POST' && new URL(request.url).pathname.endsWith('/start'))
      for (const machine of fake.machines.get(APP) ?? []) Object.assign(machine, { instance_id: 'v2' })
    return answer
  }
  const client = flyClient('token', { fetch: fetch as never, pace: { perSecond: 1000, burst: 1000 } })
  const runtime = new FlyRuntime({
    client,
    org: 'blockly',
    deploymentId: 'test',
    regionMap: { 'eu-central': 'fra' },
    snapshotRetentionDays: 30,
    machineLimit: 50,
    platformMachines: 7,
    suspend: async () => true,
  })
  const steps: string[] = []
  const marks: string[] = []
  const progress: ProgressSink = {
    step: async (step) => void steps.push(step),
    handle: async () => {},
    mark: async (mark) => void marks.push(mark),
  }
  const handle = await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
  for (const machine of fake.machines.get(APP) ?? []) Object.assign(machine, { instance_id: 'v1' })
  if (runtime.sleep === undefined) throw new Error('This runtime does not suspend')
  await runtime.sleep(handle)
  steps.length = 0
  marks.length = 0
  const wake = () => runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
  return { fly, steps, marks, wake }
}

test('a resume Fly launched anew is marked so, still a resume by its steps', async () => {
  const { fly, steps, marks, wake } = await asleep()
  fly.launches = true
  await wake()
  // Still `resuming`: it runs the configuration it slept on, which the start records as such.
  expect(steps).toEqual(['resuming'])
  expect(marks).toEqual(['started_from:suspended', 'relaunched'])
})

test('a resume that keeps its version is no launch', async () => {
  const { steps, marks, wake } = await asleep()
  await wake()
  expect(steps).toEqual(['resuming'])
  expect(marks).toEqual(['started_from:suspended'])
})
