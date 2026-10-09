import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeRuntime } from '../../infra/fake/fake-runtime.ts'
import type { ConsoleTarget, ReadinessProbe, ServerConsole } from '../ports/minecraft.ts'
import type { LogSource } from '../ports/platform.ts'
import {
  type ProgressSink,
  type RuntimeHandle,
  type RuntimeSpec,
  RuntimeUnsupported,
  runtimeKey,
} from '../ports/runtime.ts'
import { RoutedAdapters, RuntimeRouter } from './router.ts'

const spec: RuntimeSpec = {
  image: 'example/minecraft',
  env: {},
  secrets: {},
  resources: { memoryMb: 3072 },
  storage: { mountPath: '/data', sizeGb: 5 },
  ports: [
    { name: 'game', port: 25565, protocol: 'tcp', audience: ['edge'] },
    { name: 'rcon', port: 25575, protocol: 'tcp', audience: ['control'] },
  ],
  stop: { signal: 'SIGTERM', timeoutSeconds: 30 },
  labels: {},
}
const quiet: ProgressSink = { step: async () => {}, handle: async () => {} }
const place = { regionKey: 'local' }

describe('the runtime router', () => {
  let root: string
  let fly: FakeRuntime
  let fleet: FakeRuntime
  let router: RuntimeRouter

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'blockly-router-'))
    const make = (provider: string, ceiling: number | null) =>
      new FakeRuntime({
        provider,
        deploymentId: 'test',
        root,
        regionMap: { local: 'here' },
        serverCeiling: ceiling,
      })
    fly = make('fake-fly', 10)
    fleet = make('fake-fleet', null)
    router = new RuntimeRouter([fly, fleet])
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('each runtime is reached only through handles it issued', async () => {
    const a = await router.ensureProvisioned('fake-fly', runtimeKey('a'), place, spec, quiet)
    const b = await router.ensureProvisioned('fake-fleet', runtimeKey('b'), place, spec, quiet)
    expect(router.providerOf(a)).toBe('fake-fly')
    expect(router.providerOf(b)).toBe('fake-fleet')
    expect(fly.machine('a')?.state).toBe('running')
    expect(fleet.machine('a')).toBeNull()
    await router.stop(b)
    expect(fleet.machine('b')?.state).toBe('stopped')
    expect(fly.machine('a')?.state).toBe('running')
    // Compute on two runtimes is never the same compute, whatever the keys.
    expect(router.sameCompute(a, b)).toBe(false)
    expect(router.sameCompute(a, a)).toBe(true)
    expect(() => router.observe('nobody:v1:e30' as RuntimeHandle)).toThrow(/No runtime this deployment runs/)
  })

  test('an endpoint carries the runtime that issued it, for the console and probe that speak to it', async () => {
    const a = await router.ensureProvisioned('fake-fly', runtimeKey('c'), place, spec, quiet)
    expect(router.endpoint(a, 'rcon', 'control')).toMatchObject({ port: 25575, provider: 'fake-fly' })
    const said: string[] = []
    const consoleOf = (name: string): ServerConsole => ({
      run: async (_target: ConsoleTarget, command: string) => {
        said.push(`${name}:${command}`)
        return ''
      },
      runAll: async () => [],
    })
    const probeOf = (name: string): ReadinessProbe => ({
      ping: async () => ({ online: 0, max: 0, version: name }),
    })
    const logsOf = (name: string): LogSource => ({
      recent: async () => [{ at: new Date(0), text: name }],
      tail: async function* () {},
    })
    const routed = new RoutedAdapters(
      router,
      new Map([
        ['fake-fly', { console: consoleOf('fly'), probe: probeOf('fly'), logs: logsOf('fly') }],
        ['fake-fleet', { console: consoleOf('fleet'), probe: probeOf('fleet'), logs: logsOf('fleet') }],
      ]),
    )
    const b = await router.ensureProvisioned('fake-fleet', runtimeKey('d'), place, spec, quiet)
    await routed.console.run({ endpoint: router.endpoint(b, 'rcon', 'control'), passwords: [] }, 'list')
    await routed.console.run({ endpoint: router.endpoint(a, 'rcon', 'control'), passwords: [] }, 'list')
    expect(said).toEqual(['fleet:list', 'fly:list'])
    expect(
      (await routed.probe.ping(router.endpoint(b, 'game', 'control'), AbortSignal.timeout(1000))).version,
    ).toBe('fleet')
    expect((await routed.logs.recent(a, 1))[0]?.text).toBe('fly')
  })

  test('a snapshot is restored, exported and deleted only by the runtime that took it', async () => {
    const a = await router.ensureProvisioned('fake-fly', runtimeKey('e'), place, spec, quiet)
    const b = await router.ensureProvisioned('fake-fleet', runtimeKey('f'), place, spec, quiet)
    const taken = await router.snapshot(a)
    expect(router.snapshotLifetimeDays(taken.snapshot)).toBeNull()
    await expect(
      router.restore(b, { kind: 'snapshot', snapshot: taken.snapshot }, spec, quiet),
    ).rejects.toThrow(RuntimeUnsupported)
    const gone = await router.goneSnapshots([taken.snapshot, 'other-snap:v1:x' as never])
    expect(gone.size).toBe(0)
    await router.deleteSnapshot(taken.snapshot)
    expect((await router.goneSnapshots([taken.snapshot])).has(taken.snapshot)).toBe(true)
    await expect(router.deleteSnapshot('other-snap:v1:x' as never)).rejects.toThrow(RuntimeUnsupported)
  })

  test('listings read every runtime, and a ceiling is the sum or none', async () => {
    const keys = new Set<string>()
    for await (const item of router.inventory()) keys.add(`${router.providerOf(item.handle)}:${item.key}`)
    expect(keys.has('fake-fly:a')).toBe(true)
    expect(keys.has('fake-fleet:b')).toBe(true)
    expect(router.serverCeiling).toBeNull()
    expect(router.ceilingOf('fake-fly')).toBe(10)
    expect(new RuntimeRouter([fly]).serverCeiling).toBe(10)
    expect(() => new RuntimeRouter([fly, fly])).toThrow(/Two runtimes call themselves fake-fly/)
    expect(router.runs('fake-fleet')).toBe(true)
    expect(router.runs('fly')).toBe(false)
  })

  test('a runtime adopts a server it never held, and a restore from an archive is what fills it', async () => {
    const adopted = await router.adopt('fake-fleet', runtimeKey('g'), place, spec)
    expect(router.providerOf(adopted)).toBe('fake-fleet')
    expect(fleet.machine('g')).toMatchObject({ released: true, compute: false })
    expect(await router.adopt('fake-fleet', runtimeKey('g'), place, spec)).toBe(adopted)
    expect(router.endpoint(adopted, 'game', 'edge').port).toBe(25565)
    await router.destroy('fake-fleet', runtimeKey('g'))
    expect(fleet.machine('g')).toBeNull()
  })

  test('room is the runtime’s own to say', async () => {
    expect(await router.hasRoom('fake-fleet', place, { memoryMb: 3072, storageGb: 5 })).toBe(true)
    fleet.fill('local')
    expect(await router.hasRoom('fake-fleet', place, { memoryMb: 3072, storageGb: 5 })).toBe(false)
    await expect(router.ensureProvisioned('fake-fleet', runtimeKey('h'), place, spec, quiet)).rejects.toThrow(
      /no room/,
    )
    expect(await router.hasRoom('fake-fly', place, { memoryMb: 3072, storageGb: 5 })).toBe(true)
    fleet.fill('local', false)
    expect(await router.hasRoom('fake-fly', { regionKey: 'mars' }, { memoryMb: 3072, storageGb: 5 })).toBe(
      false,
    )
  })
})
