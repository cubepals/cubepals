// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What is kept of each host from the boots that read it (`hosts.ts`), against Postgres. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { HOUR_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { flyClient } from '../../infra/fly/client.ts'
import { FakeFly } from '../../infra/fly/fake-fly.ts'
import { type FakeHost, onHosts } from '../../infra/fly/fake-fly-hosts.ts'
import { FlyRuntime } from '../../infra/fly/fly-runtime.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { serverBinding } from '../operations/handlers/binding.ts'
import type { OperationContext } from '../operations/runner.ts'
import type { ProgressSink, RuntimeSpec } from '../ports/runtime.ts'
import { runtimeKey } from '../ports/runtime.ts'
import { installTuning, tuning } from '../tuning.ts'
import { hostSeen, knownSlow } from './hosts.ts'

const hosts = schema.runtimeHosts
const at = (hours: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + hours * HOUR_MS)
const reading = (id: string, mhz: number | null, model: string | null = 'AMD EPYC') => ({
  model,
  mhz,
  host: { region: 'fra', id },
})

describe.skipIf(!hasDatabase)('the hosts servers booted on', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  const kept = async (provider: string, id: string) =>
    (
      await h.db
        .select()
        .from(hosts)
        .where(and(eq(hosts.provider, provider), eq(hosts.host, id)))
    )[0]

  test('a first reading of a host is kept as its clock, its model and when', async () => {
    await hostSeen(h.db, 'fly', reading('first', 2500), at(1))
    expect(await kept('fly', 'first')).toEqual({
      provider: 'fly',
      region: 'fra',
      host: 'first',
      model: 'AMD EPYC',
      mhz: 2500,
      mhzMin: 2500,
      mhzMax: 2500,
      readings: 1,
      firstSeenAt: at(1),
      lastSeenAt: at(1),
    })
  })

  test('later readings keep the last clock, the least and the most, how many, and when', async () => {
    await hostSeen(h.db, 'fly', reading('again', 2500), at(1))
    await hostSeen(h.db, 'fly', reading('again', 3000), at(2))
    await hostSeen(h.db, 'fly', reading('again', 2000, null), at(3))
    expect(await kept('fly', 'again')).toMatchObject({
      // The last machine named no model: the one before it stays.
      model: 'AMD EPYC',
      mhz: 2000,
      mhzMin: 2000,
      mhzMax: 3000,
      readings: 3,
      firstSeenAt: at(1),
      lastSeenAt: at(3),
    })
  })

  test('a host is one provider’s, in one region: the same name elsewhere is another', async () => {
    await hostSeen(h.db, 'fly', reading('shared', 2000), at(1))
    await hostSeen(h.db, 'other', reading('shared', 3000), at(1))
    await hostSeen(h.db, 'fly', { model: null, mhz: 2500, host: { region: 'iad', id: 'shared' } }, at(1))
    const rows = await h.db.select().from(hosts).where(eq(hosts.host, 'shared'))
    expect(rows.map((row) => [row.provider, row.region, row.mhz, row.readings]).sort()).toEqual([
      ['fly', 'fra', 2000, 1],
      ['fly', 'iad', 2500, 1],
      ['other', 'fra', 3000, 1],
    ])
  })

  test('a reading that names no host, or no clock, is not kept', async () => {
    await hostSeen(h.db, 'fly', { model: 'AMD EPYC', mhz: 3000, host: null }, at(1))
    await hostSeen(h.db, 'fly', reading('silent', null), at(1))
    expect(await kept('fly', 'silent')).toBeUndefined()
  })
})

/** The floor these tests judge by, between the clocks they read. */
const FLOOR = 2500
const host = (id: string) => ({ region: 'fra', id })

describe.skipIf(!hasDatabase)('a host known to be slow', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  test('is one whose every reading is under the floor', async () => {
    await hostSeen(h.db, 'fly', reading('slow', 2000), at(1))
    await hostSeen(h.db, 'fly', reading('slow', 2400), at(2))
    expect(await knownSlow(h.db, 'fly', host('slow'), FLOOR)).toBe(true)
  })

  test('is not one at the floor or over it, nor one never read', async () => {
    await hostSeen(h.db, 'fly', reading('fast', 3000), at(1))
    await hostSeen(h.db, 'fly', reading('at-the-floor', FLOOR), at(1))
    expect(await knownSlow(h.db, 'fly', host('fast'), FLOOR)).toBe(false)
    expect(await knownSlow(h.db, 'fly', host('at-the-floor'), FLOOR)).toBe(false)
    expect(await knownSlow(h.db, 'fly', host('never-read'), FLOOR)).toBe(false)
  })

  test('is not one read on both sides of the floor, in whichever order: it is not known', async () => {
    await hostSeen(h.db, 'fly', reading('slow-then-fast', 2000), at(1))
    await hostSeen(h.db, 'fly', reading('slow-then-fast', 3000), at(2))
    await hostSeen(h.db, 'fly', reading('fast-then-slow', 3000), at(1))
    await hostSeen(h.db, 'fly', reading('fast-then-slow', 2000), at(2))
    await hostSeen(h.db, 'fly', reading('fast-then-slow', 2000), at(3))
    expect(await knownSlow(h.db, 'fly', host('slow-then-fast'), FLOOR)).toBe(false)
    expect(await knownSlow(h.db, 'fly', host('fast-then-slow'), FLOOR)).toBe(false)
  })

  test('is judged by the floor asked with, and is one provider’s in one region', async () => {
    await hostSeen(h.db, 'fly', reading('middling', 2400), at(1))
    expect(await knownSlow(h.db, 'fly', host('middling'), 2000)).toBe(false)
    expect(await knownSlow(h.db, 'fly', host('middling'), 3000)).toBe(true)
    expect(await knownSlow(h.db, 'other', host('middling'), 3000)).toBe(false)
    expect(await knownSlow(h.db, 'fly', { region: 'iad', id: 'middling' }, 3000)).toBe(false)
  })

  test('is what a start is told when it asks, under the deployment’s floor; with none, nothing is offered to ask', async () => {
    const before = tuning()
    const sinkOf = () =>
      serverBinding({ db: h.db, runtime: {} as never, jobs: {} as never }).progressSink(
        {} as OperationContext,
        {} as MinecraftServer,
      )
    try {
      // The floor is 0 until a deployment sets one: nothing to ask, so the table is never read.
      expect(sinkOf().slowHost).toBeUndefined()
      installTuning({ ...before, slowHostMhz: FLOOR })
      expect(await sinkOf().slowHost?.('fly', host('slow'))).toBe(true)
      expect(await sinkOf().slowHost?.('fly', host('fast'))).toBe(false)
    } finally {
      installTuning(before)
    }
  })
})

describe.skipIf(!hasDatabase)('what boots read of hosts, and where new servers land', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  const spec: RuntimeSpec = {
    image: 'example/minecraft',
    env: {},
    secrets: {},
    resources: { memoryMb: 2048 },
    storage: { mountPath: '/data', sizeGb: 5 },
    ports: [{ name: 'game', port: 25565, protocol: 'tcp', audience: ['edge'] }],
    stop: { signal: 'SIGTERM', timeoutSeconds: 30 },
    labels: {},
  }
  /** A start that asks the table which hosts are slow, under `floorMhz`; with 0, one with nobody to ask. */
  const asking = (floorMhz: number): ProgressSink => ({
    step: async () => {},
    handle: async () => {},
    ...(floorMhz > 0 ? { slowHost: (provider, host) => knownSlow(h.db, provider, host, floorMhz) } : {}),
  })
  const key = (n: number) => runtimeKey(`7a1b2c3d-4e5f-4a6b-8c7d-00000000000${n}`)

  /** A Fly runtime on these hosts. */
  const flyOn = (placed: FakeHost[]) =>
    new FlyRuntime({
      client: flyClient('token', {
        fetch: onHosts(new FakeFly(), placed) as never,
        pace: { perSecond: 1000, burst: 1000 },
      }),
      org: 'blockly',
      deploymentId: 'test',
      regionMap: { local: 'ams' },
      snapshotRetentionDays: 30,
      machineLimit: 50,
      platformMachines: 7,
    })
  /** A new server started, and what its boot reads of its host kept, as the boot keeps it. */
  const started = async (runtime: FlyRuntime, n: number, floorMhz: number) => {
    const handle = await runtime.ensureProvisioned(key(n), { regionKey: 'local' }, spec, asking(floorMhz))
    const cpu = await runtime.hostCpu(handle)
    if (cpu !== null) await hostSeen(h.db, runtime.provider, cpu)
    return cpu?.host?.id
  }

  test('a host one server’s boot read as slow is one the next new server’s volume is moved off', async () => {
    const dull = { zone: 'dull', mhz: 2000 }
    const runtime = flyOn([dull, dull, { zone: 'quick', mhz: 3000 }, { zone: 'quick', mhz: 3000 }])
    // Nothing is known of it yet: the first server stays, and its boot reads it.
    expect(await started(runtime, 1, FLOOR)).toBe('dull')
    // The second lands there too, and is given another volume before its machine is made.
    expect(await started(runtime, 2, FLOOR)).toBe('quick')
    // A host read as fast is kept.
    expect(await started(runtime, 3, FLOOR)).toBe('quick')
  }, 60_000)

  test('with a floor of 0 every new server keeps the volume Fly made, whatever was read there', async () => {
    const plain = { zone: 'plain', mhz: 2000 }
    const runtime = flyOn([plain, plain])
    expect(await started(runtime, 4, 0)).toBe('plain')
    expect(await started(runtime, 5, 0)).toBe('plain')
  }, 60_000)
})
