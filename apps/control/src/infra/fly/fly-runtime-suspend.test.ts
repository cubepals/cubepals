// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FlyRuntime putting a server to sleep with Fly's suspend, and waking it, against an in-memory Fly
 * that takes a moment to finish a suspend as the real one does (5 to 17 s): what a
 * sleep sends, what a wake skips, what a stop, a change or a second call does to a machine asleep.
 */

import { describe, expect, test } from 'bun:test'
import { HostFull, type ProgressSink, type RuntimeKey, type RuntimeSpec } from '../../app/ports/runtime.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { FlyRuntime } from './fly-runtime.ts'
import { NO_MEMORY_SAID } from './refusals.ts'

const KEY = '6276d3d7-5c80-4bd4-9d00-12818b8a4d38' as RuntimeKey
const APP = 'bly-test-6276d3d75c804bd49d0012818b8a4d38'

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

/** `flipped` is the admin's switch, which a test flips between sleeps. */
async function running(options: { suspend?: boolean; switchless?: boolean; spec?: RuntimeSpec } = {}) {
  const flipped = { on: options.suspend ?? true }
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
    ...(options.switchless ? {} : { suspend: async () => flipped.on }),
  })
  const steps: string[] = []
  const marks: string[] = []
  const progress: ProgressSink = {
    step: async (step) => void steps.push(step),
    handle: async () => {},
    mark: async (mark) => void marks.push(mark),
  }
  const handle = await runtime.ensureProvisioned(
    KEY,
    { regionKey: 'eu-central' },
    options.spec ?? spec,
    progress,
  )
  const machine = fake.machines.get(APP)?.[0]
  if (machine === undefined) throw new Error('no machine')
  steps.length = 0
  marks.length = 0
  fake.calls.length = 0
  fake.startedFrom.length = 0
  // Writing 3 GB of memory out takes a while: a few reads see it still suspending.
  fake.suspendReads = 2
  const sleep = (h = handle) => {
    if (runtime.sleep === undefined) throw new Error('This runtime does not suspend')
    return runtime.sleep(h)
  }
  return { fake, runtime, handle, machine, steps, marks, progress, sleep, flipped }
}

/** Once Fly has the suspend: the machine is writing its memory out. */
async function suspending(machine: { state: string }) {
  while (machine.state === 'started') await new Promise((resolve) => setTimeout(resolve, 1))
}

describe('FlyRuntime putting a server to sleep with Fly’s suspend', () => {
  test('a sleep suspends the machine under its lease and returns once it is suspended', async () => {
    const { fake, machine, sleep } = await running()
    expect(await sleep()).toBe('suspended')
    expect(machine.state).toBe('suspended')
    expect(fake.calls).toContain(`POST /v1/apps/${APP}/machines/${machine.id}/lease`)
    expect(fake.count(`POST /v1/apps/${APP}/machines/${machine.id}/suspend`)).toBe(1)
    // Nothing stopped it: what it held in memory is kept for the wake.
    expect(fake.count(`POST /v1/apps/${APP}/machines/${machine.id}/stop`)).toBe(0)
    expect(fake.leases.size).toBe(0)
  })

  test('without a switch it has no sleep at all, so the control plane stops it', async () => {
    const { runtime } = await running({ switchless: true })
    expect(runtime.sleep).toBeUndefined()
  })

  test('with the switch off a sleep stops the machine, and asks again at the next sleep', async () => {
    const { fake, runtime, handle, machine, sleep, flipped } = await running({ suspend: false })
    expect(await sleep()).toBe('stopped')
    expect(machine.state).toBe('stopped')
    expect(fake.stopSignals).toEqual(['SIGTERM'])
    expect(fake.count(`POST /v1/apps/${APP}/machines/${machine.id}/suspend`)).toBe(0)

    flipped.on = true
    await runtime.start(handle)
    expect(await sleep()).toBe('suspended')
    expect(machine.state).toBe('suspended')
    expect(fake.count(`POST /v1/apps/${APP}/machines/${machine.id}/suspend`)).toBe(1)
  })

  test('a suspend Fly refuses becomes a stop, so a sleep never fails for want of it', async () => {
    const { fake, machine, sleep } = await running()
    fake.suspendRefusal = { error: 'failed_precondition: machine is not eligible for suspend' }
    expect(await sleep()).toBe('stopped')
    expect(machine.state).toBe('stopped')
    expect(fake.stopSignals).toEqual(['SIGTERM'])
  })

  test('a machine not running is stopped, never suspended', async () => {
    const { fake, runtime, handle, machine, sleep } = await running()
    await runtime.stop(handle)
    fake.calls.length = 0
    expect(await sleep()).toBe('stopped')
    expect(machine.state).toBe('stopped')
    expect(fake.count(`POST /v1/apps/${APP}/machines/${machine.id}/suspend`)).toBe(0)
  })

  test('a second sleep, after or during the first, finds it asleep and sends nothing more', async () => {
    const { fake, machine, sleep } = await running()
    fake.suspendReads = 6
    expect(await Promise.all([sleep(), sleep()])).toEqual(['suspended', 'suspended'])
    expect(await sleep()).toBe('suspended')
    expect(machine.state).toBe('suspended')
    expect(fake.count(`POST /v1/apps/${APP}/machines/${machine.id}/stop`)).toBe(0)
  })

  test('a sleep while a stop is under way ends stopped', async () => {
    const { fake, machine, sleep } = await running()
    machine.state = 'stopping'
    machine.stopReadsLeft = 2
    expect(await sleep()).toBe('stopped')
    expect(machine.state).toBe('stopped')
    expect(fake.count(`POST /v1/apps/${APP}/machines/${machine.id}/suspend`)).toBe(0)
  })
})

describe('FlyRuntime with a server asleep: waking it, or stopping it', () => {
  test('a wake on the configuration it slept on resumes it, posting and changing nothing first', async () => {
    const { fake, runtime, handle, machine, steps, marks, progress, sleep } = await running()
    await sleep()
    fake.calls.length = 0
    const woken = await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
    expect(woken).toBe(handle)
    expect(steps).toEqual(['resuming'])
    expect(marks).toEqual([])
    expect(fake.startedFrom).toEqual(['suspended'])
    expect(machine.state).toBe('started')
    // Only the listing that found it asleep, and the start: no secrets, app, address or update.
    expect(fake.calls.filter((call) => call.startsWith('POST'))).toEqual([
      `POST /v1/apps/${APP}/machines/${machine.id}/start`,
    ])
  })

  test('a wake while it is still suspending waits for the suspend, then resumes it', async () => {
    const { fake, runtime, handle, machine } = await running()
    fake.suspendReads = 4
    const sleeping = runtime.sleep?.(handle)
    await suspending(machine)
    await runtime.start(handle)
    expect(await sleeping).toBe('suspended')
    expect(fake.refusedStarts).toBe(0)
    expect(fake.startedFrom).toEqual(['suspended'])
    expect(machine.state).toBe('started')
  })

  test('a wake that finds it still suspending waits for the suspend, then resumes it as it was', async () => {
    const { fake, runtime, machine, steps, progress } = await running()
    fake.suspendReads = 4
    const sleeping = runtime.sleep?.(
      await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress),
    )
    await suspending(machine)
    steps.length = 0
    fake.calls.length = 0
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
    // The sleep it overtook never stops what the wake started.
    expect(await sleeping).toBe('suspended')
    expect(machine.state).toBe('started')
    expect(fake.stopSignals).toEqual([])
    expect(steps).toEqual(['resuming'])
    expect(fake.count(`POST /v1/apps/${APP}/secrets`)).toBe(0)
    expect(fake.startedFrom).toEqual(['suspended'])
  })

  // Staging, 2026-10-11: a start a moment after the suspend finished, 409.
  test('a wake Fly refuses while it still finishes the suspend is asked again', async () => {
    const { fake, runtime, handle, machine, sleep } = await running()
    await sleep()
    fake.suspendedStarts = 2
    await runtime.start(handle)
    expect(machine.state).toBe('started')
    expect(fake.refusedStarts).toBe(2)
  })

  test('a wake on a new configuration drops the memory it kept and boots that configuration', async () => {
    const { fake, runtime, machine, steps, marks, progress, sleep } = await running()
    await sleep()
    const changed = { ...spec, env: { ...spec.env, VERSION: '26.4' } }
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, changed, progress)
    expect(steps).toEqual(['allocating', 'storage', 'compute', 'booting'])
    // Kept on the record: it booted because it slept on another configuration.
    expect(marks).toEqual(['other_spec'])
    expect(fake.count(`POST /v1/apps/${APP}/secrets`)).toBe(1)
    expect(fake.startedFrom).toEqual(['stopped'])
    expect((machine.config.env as Record<string, string>).VERSION).toBe('26.4')
  })

  test('a wake of a machine stopped rather than asleep boots it, and says it was not asleep', async () => {
    const { runtime, handle, steps, marks, progress } = await running()
    await runtime.stop(handle)
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
    expect(steps).toContain('booting')
    expect(marks).toEqual(['not_asleep'])
  })

  test('a stop, a kill or a decommission of a machine asleep stops it for real', async () => {
    const { fake, runtime, handle, machine, sleep } = await running()
    await sleep()
    await runtime.stop(handle)
    expect(machine.state).toBe('stopped')
    expect(fake.stopSignals).toEqual(['SIGTERM'])

    await sleep()
    machine.state = 'started'
    await sleep()
    await runtime.forceStop(handle)
    expect(machine.state).toBe('stopped')
    expect(fake.stopSignals).toEqual(['SIGTERM', 'SIGKILL'])

    machine.state = 'started'
    await sleep()
    await runtime.decommission(handle)
    expect(fake.machines.get(APP) ?? []).toHaveLength(0)
  })

  test('a stop while it is still suspending lets the suspend finish, then stops it', async () => {
    const { fake, runtime, handle, machine } = await running()
    fake.suspendReads = 4
    const sleeping = runtime.sleep?.(handle)
    await suspending(machine)
    await runtime.stop(handle)
    await sleeping
    expect(machine.state).toBe('stopped')
    expect(fake.stopSignals).toEqual(['SIGTERM'])
  })

  test('a machine asleep is observed stopped, as one stopped is', async () => {
    const { runtime, handle, sleep } = await running()
    await sleep()
    expect((await runtime.observe(handle)).state).toBe('stopped')
  })
})

describe('FlyRuntime waking a server asleep on a change only a start reads', () => {
  // Production, 2026-10-14: a server's message changed while it slept, and its wake booted it.
  test('a wake on a change only a start reads resumes it as it slept, and its next boot takes the change', async () => {
    const labelled = { ...spec, resumesOn: 'as-before' }
    const { fake, runtime, handle, machine, steps, progress, sleep } = await running({ spec: labelled })
    await sleep()
    fake.calls.length = 0
    const message = { ...labelled, env: { ...spec.env, MOTD: 'Back soon' } }
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, message, progress)
    expect(steps).toEqual(['resuming'])
    expect(fake.startedFrom).toEqual(['suspended'])
    expect(fake.calls.filter((call) => call.startsWith('POST'))).toEqual([
      `POST /v1/apps/${APP}/machines/${machine.id}/start`,
    ])
    expect((machine.config.env as Record<string, string>).MOTD).toBeUndefined()

    await runtime.stop(handle)
    steps.length = 0
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, message, progress)
    expect(steps).toEqual(['allocating', 'storage', 'compute', 'booting'])
    expect((machine.config.env as Record<string, string>).MOTD).toBe('Back soon')
  })

  test('a machine asleep from before `resumesOn` resumes on the same configuration with it', async () => {
    const { fake, runtime, steps, progress, sleep } = await running()
    await sleep()
    const labelled = { ...spec, resumesOn: 'as-before' }
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, labelled, progress)
    expect(steps).toEqual(['resuming'])
    expect(fake.startedFrom).toEqual(['suspended'])
  })
})

describe('FlyRuntime with the switch flipped while a server sleeps', () => {
  test('a server suspended before the switch went off still resumes', async () => {
    const { fake, runtime, handle, machine, steps, progress, sleep, flipped } = await running()
    await sleep()
    flipped.on = false
    steps.length = 0
    expect(await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)).toBe(handle)
    expect(steps).toEqual(['resuming'])
    expect(fake.startedFrom).toEqual(['suspended'])
    expect(machine.state).toBe('started')
  })

  test('a server stopped before the switch went on still boots', async () => {
    const { fake, runtime, machine, steps, progress, sleep, flipped } = await running({ suspend: false })
    await sleep()
    flipped.on = true
    steps.length = 0
    await runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
    expect(steps).not.toContain('resuming')
    expect(fake.startedFrom).toEqual(['stopped'])
    expect(machine.state).toBe('started')
  })
})

// A host that filled while its server slept (community.fly.io/t/28766): the volume ties the
// machine to it, and only new storage made elsewhere from a snapshot gets it running.
describe('FlyRuntime waking a server whose host has no room left', () => {
  test('is HostFull, for its own host, not the region', async () => {
    const { fake, runtime, machine, progress, sleep } = await running()
    await sleep()
    fake.refusal = { error: NO_MEMORY_SAID }
    const woken = runtime.ensureProvisioned(KEY, { regionKey: 'eu-central' }, spec, progress)
    await expect(woken).rejects.toBeInstanceOf(HostFull)
    await expect(woken).rejects.toThrow(NO_MEMORY_SAID)
    expect(machine.state).toBe('suspended')
  })
})
