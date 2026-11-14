// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The host a server's machine runs on, as FlyRuntime reads it: its CPU's model and clock from the
 * machine's own `/proc/cpuinfo`, and which host it is from its volume's zone; nothing where
 * neither can be read, or the server has no machine.
 */

import { describe, expect, test } from 'bun:test'
import type { ProgressSink, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { flyClient } from './client.ts'
import { FakeFly } from './fake-fly.ts'
import { type FakeHost, hostsOf, onHosts } from './fake-fly-hosts.ts'
import { parseCpuinfo } from './fly-runtime/host-cpu.ts'
import { FlyRuntime } from './fly-runtime.ts'

const KEY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' as RuntimeKey
const PLACE = { regionKey: 'eu-central' }
const quiet: ProgressSink = { step: async () => {}, handle: async () => {} }

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

/** A runtime on a fake Fly whose new volumes land on these hosts, in order. */
const runtimeOn = (hosts: FakeHost[]) =>
  new FlyRuntime({
    client: flyClient('token', {
      fetch: onHosts(new FakeFly(), hosts) as never,
      pace: { perSecond: 1000, burst: 1000 },
    }),
    org: 'blockly',
    deploymentId: 'test',
    regionMap: { 'eu-central': 'fra' },
    snapshotRetentionDays: 30,
    machineLimit: 50,
    platformMachines: 7,
  })

describe('the CPU a machine reads', () => {
  test('is the first processor’s model and clock, as Linux writes them', () => {
    const one = [
      'processor\t: 0',
      'model name\t: AMD EPYC',
      'cpu MHz\t\t: 2000.000',
      'cache size\t: 512 KB',
      '',
    ]
    const text = [...one, 'processor\t: 1', 'model name\t: Another', 'cpu MHz\t\t: 3000.000'].join('\n')
    expect(parseCpuinfo(text)).toEqual({ model: 'AMD EPYC', mhz: 2000 })
  })

  test('is read as far as it goes: a clock with no name, and nothing where it has neither', () => {
    expect(parseCpuinfo('processor\t: 0\ncpu MHz\t\t: 2499.998\n')).toEqual({ model: null, mhz: 2499.998 })
    // An ARM machine's file has neither line.
    expect(parseCpuinfo('processor\t: 0\nBogoMIPS\t: 50.00\nCPU implementer\t: 0x41\n')).toBeNull()
    expect(parseCpuinfo('')).toBeNull()
  })
})

describe('the host of a server on Fly', () => {
  test('is read from its machine and its volume: the CPU, the region and the zone', async () => {
    const runtime = runtimeOn(hostsOf(3000))
    const handle = await runtime.ensureProvisioned(KEY, PLACE, spec, quiet)
    expect(await runtime.hostCpu(handle)).toEqual({
      model: 'AMD EPYC',
      mhz: 3000,
      host: { region: 'fra', id: 'z1' },
    })
  })

  test('is each volume’s own: a restore’s lands on another', async () => {
    const runtime = runtimeOn(hostsOf(3000, 2000))
    const first = await runtime.ensureProvisioned(KEY, PLACE, spec, quiet)
    const { snapshot } = await runtime.snapshot(first)
    const restored = await runtime.restore(first, { kind: 'snapshot', snapshot }, spec, quiet)
    await runtime.start(restored)
    expect(await runtime.hostCpu(restored)).toMatchObject({ mhz: 2000, host: { region: 'fra', id: 'z2' } })
  }, 60_000)

  test('is read as far as it goes: a zone whose machine says nothing of its CPU, and nothing at all', async () => {
    const named = runtimeOn([{ zone: 'z1' }])
    expect(await named.hostCpu(await named.ensureProvisioned(KEY, PLACE, spec, quiet))).toEqual({
      model: null,
      mhz: null,
      host: { region: 'fra', id: 'z1' },
    })
    const unnamed = runtimeOn([])
    const handle = await unnamed.ensureProvisioned(KEY, PLACE, spec, quiet)
    expect(await unnamed.hostCpu(handle)).toBeNull()
    expect(await unnamed.hostCpu(await unnamed.release(handle))).toBeNull()
  })
})
