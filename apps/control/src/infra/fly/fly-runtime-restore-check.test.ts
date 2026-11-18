// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** FlyRuntime restoring from an archive hands its helper the sha256 the archive was recorded with. */

import { expect, test } from 'bun:test'
import type { ProgressSink, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { FlyRuntime } from './fly-runtime.ts'

const KEY = '0b8f5c1e-6d2a-4f3b-9c7e-2a1d4e5f6a7c' as RuntimeKey

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

async function resting() {
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
  return { fake, runtime, progress, handle: await runtime.release(handle) }
}

test('a wake from an archive with a recorded sha256 has its helper check the bytes against it', async () => {
  const { fake, runtime, progress, handle } = await resting()
  const sha256 = 'c0ffee'.padEnd(64, '0')
  const download = { url: 'https://bucket.example/rest.tgz' }
  await runtime.restore(handle, { kind: 'archive', download, sha256 }, spec, progress)
  const script = fake.jobScripts.find((s) => s.includes('rest.tgz')) ?? ''
  expect(script).toContain(`!= '${sha256}' ]`)
}, 20_000)

test('one with none recorded, as an upload has, is restored unchecked', async () => {
  const { fake, runtime, progress, handle } = await resting()
  const download = { url: 'https://bucket.example/upload.tgz' }
  await runtime.restore(handle, { kind: 'archive', download, sha256: null }, spec, progress)
  const script = fake.jobScripts.find((s) => s.includes('upload.tgz')) ?? ''
  expect(script).toContain('tar -xzf -')
  expect(script).not.toContain('sha256sum')
}, 20_000)
