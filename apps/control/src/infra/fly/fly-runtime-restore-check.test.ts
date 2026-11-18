// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FlyRuntime restoring from an archive: its helper checks the bytes against the sha256 the archive
 * was recorded with, and a wake booted at once makes no helper, its own machine bringing the world
 * back with the same check (`minecraft/restore-step.ts`).
 */

import { expect, test } from 'bun:test'
import type { ProgressSink, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { RESTORE_VARIABLE as GAME_RESTORE_VARIABLE } from '../../minecraft/restore-step.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { RESTORE_VARIABLE, restoreInMachine } from './machine-config.ts'

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
  expect(script).toContain('tar -xf - -C /data')
  expect(script).not.toContain('sha256sum')
}, 20_000)

/** The env of every server machine the fake holds, as made. */
const machineEnvs = (fake: FakeFly) =>
  [...fake.machines.values()]
    .flat()
    .map(
      (machine) => ((machine.config as { env?: Record<string, string> }).env ?? {}) as Record<string, string>,
    )

test('a wake booted at once brings its world back in its own machine: no helper, the link and sha256 on that machine', async () => {
  const { fake, runtime, progress, handle } = await resting()
  const sha256 = 'C0FFEE'.padEnd(64, '0')
  const download = { url: 'https://bucket.example/rest.tgz?sig=1' }
  const helpersBefore = fake.jobScripts.length
  await runtime.restore(handle, { kind: 'archive', download, sha256 }, spec, progress, { bootsAtOnce: true })
  expect(fake.jobScripts.length).toBe(helpersBefore)
  const restoring = machineEnvs(fake).filter((env) => RESTORE_VARIABLE in env)
  expect(restoring.map((env) => env[RESTORE_VARIABLE])).toEqual([
    `${sha256.toLowerCase()} https://bucket.example/rest.tgz?sig=1`,
  ])
  expect(restoring[0]?.VERSION).toBe('26.3')
}, 20_000)

test('one with none recorded is brought back unchecked; a sha256 that isn’t one is refused before anything is made', async () => {
  const { fake, runtime, progress, handle } = await resting()
  const download = { url: 'https://bucket.example/upload.tgz' }
  await runtime.restore(handle, { kind: 'archive', download, sha256: null }, spec, progress, {
    bootsAtOnce: true,
  })
  expect(
    machineEnvs(fake)
      .map((env) => env[RESTORE_VARIABLE])
      .filter(Boolean),
  ).toEqual(['- https://bucket.example/upload.tgz'])
  expect(() => restoreInMachine('https://bucket.example/a.tgz', 'abc; rm -rf /')).toThrow("isn't a sha256")
}, 20_000)

test('a restore not booted at once, as a move’s, still fills the volume with a helper first', async () => {
  const { fake, runtime, progress, handle } = await resting()
  const download = { url: 'https://bucket.example/moved.tgz' }
  await runtime.restore(handle, { kind: 'archive', download, sha256: null }, spec, progress)
  expect(fake.jobScripts.some((script) => script.includes('moved.tgz'))).toBe(true)
  expect(machineEnvs(fake).some((env) => RESTORE_VARIABLE in env)).toBe(false)
}, 20_000)

test('the variable is the one the game’s own restore step reads', () => {
  expect(RESTORE_VARIABLE).toBe(GAME_RESTORE_VARIABLE)
})
