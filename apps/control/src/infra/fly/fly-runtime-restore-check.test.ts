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
import {
  RESTORE_VARIABLE as GAME_RESTORE_VARIABLE,
  RESTORED_MARK as GAME_RESTORED_MARK,
} from '../../minecraft/restore-step.ts'
import { recordingTarget } from '../../testing/archive-target.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { decodeHandle } from './handle.ts'
import { RESTORE_VARIABLE, RESTORED_MARK, restoreInMachine } from './machine-config.ts'

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
  // A request the test answers itself, where `answers` says; every other goes to the fake.
  const answers: { first?: (request: Request) => Promise<Response | null> } = {}
  const fetch = async (request: Request) => (await answers.first?.(request)) ?? fake.fetch(request)
  const client = flyClient('token', { fetch: fetch as never, pace: { perSecond: 1000, burst: 1000 } })
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
  return { fake, runtime, progress, answers, handle: await runtime.release(handle) }
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

test('a copy with no sha256 recorded is filled by the helper, checked as it can be; a sha256 that isn’t one is refused', async () => {
  const { fake, runtime, progress, handle } = await resting()
  const download = { url: 'https://bucket.example/upload.tgz' }
  await runtime.restore(handle, { kind: 'archive', download, sha256: null }, spec, progress, {
    bootsAtOnce: true,
  })
  expect(fake.jobScripts.some((script) => script.includes('upload.tgz'))).toBe(true)
  expect(machineEnvs(fake).some((env) => RESTORE_VARIABLE in env)).toBe(false)
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

/** The server machine on the volume `handle` names, as the fake holds it. */
const machineOf = (fake: FakeFly, handle: string) => {
  const { volumeId } = decodeHandle(handle as never)
  return [...fake.machines.values()]
    .flat()
    .find((machine) => (machine.config as { mounts?: { volume: string }[] }).mounts?.[0]?.volume === volumeId)
}
const envOf = (machine: ReturnType<typeof machineOf>) =>
  ((machine?.config as { env?: Record<string, string> } | undefined)?.env ?? {}) as Record<string, string>

test('an apply before the world is back keeps the restore on its machine, and a move to another volume never takes it', async () => {
  const { fake, runtime, progress, handle } = await resting()
  const download = { url: 'https://bucket.example/rest.tgz?sig=1' }
  const sha256 = 'c0ffee'.padEnd(64, '0')
  const woke = await runtime.restore(handle, { kind: 'archive', download, sha256 }, spec, progress, {
    bootsAtOnce: true,
  })
  // The owner saves a setting while it wakes: the spec writes a new config for the same volume.
  const applied = await runtime.apply(woke, { ...spec, env: { ...spec.env, MOTD: 'saved meanwhile' } })
  const env = envOf(machineOf(fake, applied))
  expect(env.MOTD).toBe('saved meanwhile')
  expect(env[RESTORE_VARIABLE]).toBe(`${sha256} https://bucket.example/rest.tgz?sig=1`)
  const snapshot = (await runtime.snapshot(applied)).snapshot
  const moved = await runtime.restore(applied, { kind: 'snapshot', snapshot }, spec, progress)
  expect(envOf(machineOf(fake, moved))[RESTORE_VARIABLE]).toBeUndefined()
}, 20_000)

test('a rest of a volume its machine was to fill archives nothing until the restore says it was done', async () => {
  const { fake, runtime, progress, answers, handle } = await resting()
  const sha256 = 'c0ffee'.padEnd(64, '0')
  const download = { url: 'https://bucket.example/rest.tgz' }
  const woke = await runtime.restore(handle, { kind: 'archive', download, sha256 }, spec, progress, {
    bootsAtOnce: true,
  })
  // The volume holds no mark that its world came back: the export job says so.
  answers.first = async (request) => {
    const asked = String(await request.clone().text())
    const marked = (fake.jobScripts.at(-1) ?? '').includes('echo unrestored')
    return asked.includes('cat /tmp/job.result') && marked
      ? Response.json({ exit_code: 0, stdout: 'ok unrestored\n', stderr: '' })
      : null
  }
  const target = recordingTarget()
  await expect(runtime.exportSnapshot((await runtime.snapshot(woke)).snapshot, target)).rejects.toThrow(
    `Nothing archived from server ${KEY}`,
  )
  expect(fake.jobScripts.at(-1)).toContain(`if [ ! -e /data/${RESTORED_MARK} ]; then echo unrestored; else`)
}, 20_000)

test('a rest of any other volume archives as it did, with no mark asked for', async () => {
  const { fake, runtime, progress, handle } = await resting()
  const download = { url: 'https://bucket.example/moved.tgz' }
  const back = await runtime.restore(handle, { kind: 'archive', download, sha256: null }, spec, progress)
  await runtime.exportSnapshot((await runtime.snapshot(back)).snapshot, recordingTarget())
  expect(fake.jobScripts.at(-1)).not.toContain('unrestored')
}, 20_000)

test('the mark is the one the game’s own restore step writes', () => {
  expect(RESTORED_MARK).toBe(GAME_RESTORED_MARK)
})
