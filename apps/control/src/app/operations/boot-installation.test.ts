// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Boot verifies installed jars before admitting players and retries a bad download once. */
import { expect, test } from 'bun:test'
import { defaultSettings } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { diskName } from '../../minecraft/jars.ts'
import { bootedWith, bootMismatch } from '../../minecraft/logs.ts'
import { PORT_NAMES } from '../../minecraft/runtime-spec.ts'
import { bootCommands } from '../../minecraft/settings.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type AccessReconciler, AccessReseedFailed } from '../access/reconciler.ts'
import type { ArtifactService } from '../artifacts/service.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import { BootSequence, NotReady } from './boot.ts'
import type { OperationContext } from './runner.ts'

const mod = new Cdn().publish('verified-mod')
const revision = { loader: 'fabric' as const, loaderVersion: '0.16.14', gameVersion: '26.3', mods: [mod] }
const handle = 'installation-runtime' as RuntimeHandle
const server = { id: 'installation-server' } as MinecraftServer

function fixture(
  hashes: string[],
  exitCode = 0,
  options: {
    restartAccess?: boolean
    accessError?: Error
    printed?: readonly string[]
  } = {},
) {
  const details = {
    stops: 0,
    access: [] as unknown[][],
    console: [] as unknown[][],
    endpoints: [] as Parameters<Runtimes['endpoint']>[],
    notLoaded: [] as unknown[][],
  }
  const lines = () => (options.printed ?? []).map((text) => ({ at: new Date(), text }))
  const seen = {
    checks: 0,
    refreshes: [] as string[],
    restarts: 0,
    access: 0,
    steps: [] as string[],
    marks: [] as string[],
  }
  const runtime = {
    waitRunning: async () => {},
    endpoint: (...args: Parameters<Runtimes['endpoint']>) => {
      details.endpoints.push(args)
      return { host: 'installation.test', port: 25565 }
    },
    stop: async () => {
      details.stops++
    },
    exec: async () => ({
      exitCode,
      stderr: '  disk unavailable  ',
      stdout: `${hashes[Math.min(seen.checks++, hashes.length - 1)]}  ${diskName(mod.artifact)}\n`,
    }),
    restart: async () => {
      seen.restarts++
    },
  } as unknown as Runtimes
  const boot = new BootSequence({
    runtime,
    probe: { ping: async () => ({ online: 0, max: 20, version: '26.3' }) },
    access: {
      reconcile: async (...args: unknown[]) => {
        details.access.push(args)
        seen.access++
        if (options.accessError) throw options.accessError
        return { restart: options.restartAccess === true && seen.access === 1 }
      },
    } as unknown as AccessReconciler,
    artifacts: {
      refresh: async (id: string) => {
        seen.refreshes.push(id)
      },
    } as unknown as ArtifactService,
    logs: {
      recent: async () => lines(),
      async *tail() {
        yield* lines()
      },
    },
    timeouts: { runningMs: 100, readyMs: 0 },
    console: {
      run: async () => '',
      runAll: async (...args: unknown[]) => {
        details.console.push(args)
        return []
      },
    },
    rconPasswords: () => ['fixture-password'],
    notLoaded: async (...args: unknown[]) => {
      details.notLoaded.push(args)
    },
  })
  const ctx = {
    server,
    op: { id: 'installation-operation', kind: 'provision' },
    reached: () => null,
    step: async (step: string) => {
      seen.steps.push(step)
    },
    mark: async (mark: string) => {
      seen.marks.push(mark)
    },
    stillApplies: async () => true,
  } as OperationContext
  return {
    seen,
    details,
    run: (next: Parameters<BootSequence['run']>[3] = revision) => boot.run(ctx, server, handle, next),
  }
}

test('matching jar hashes are verified once before access is restored', async () => {
  const { run, seen } = fixture([mod.artifact.sha512])
  await run()
  expect(seen).toEqual({
    checks: 1,
    refreshes: [],
    restarts: 0,
    access: 1,
    steps: ['booting', 'verifying', 'access'],
    marks: ['let_in'],
  })
})

test('a damaged jar is downloaded again and verified before players are admitted', async () => {
  const { run, seen } = fixture(['0'.repeat(128), mod.artifact.sha512])
  await run()
  expect(seen).toEqual({
    checks: 2,
    refreshes: [server.id],
    restarts: 1,
    access: 1,
    steps: ['booting', 'verifying', 'booting', 'access'],
    marks: ['let_in'],
  })
})

test('a repeated checksum mismatch refuses boot without restoring access', async () => {
  const { run, seen } = fixture(['0'.repeat(128)])
  await expect(run()).rejects.toThrow(
    `${mod.name} didn't install as chosen, even downloaded again. The published file may have changed.`,
  )
  expect(seen).toMatchObject({ checks: 2, refreshes: [server.id], restarts: 1, access: 0, marks: [] })
})

test('a failed disk check retains the real command failure rather than retrying a download', async () => {
  const { run, seen } = fixture([mod.artifact.sha512], 1)
  await expect(run()).rejects.toThrow('Checking the installed jars failed: disk unavailable')
  expect(seen).toMatchObject({ checks: 1, refreshes: [], restarts: 0, access: 0, marks: [] })
})

test('access that needs a restart is reconciled again after the next boot', async () => {
  const { run, seen, details } = fixture([mod.artifact.sha512], 0, { restartAccess: true })
  await run()
  expect(seen).toMatchObject({ restarts: 1, access: 2, marks: ['let_in'] })
  expect(details.access.map((args) => args.slice(2))).toEqual([['full', { mayRestart: true }], ['full']])
  expect(seen.steps).toEqual(['booting', 'verifying', 'access', 'booting', 'access'])
})

for (const reseed of [true, false])
  test(`a ${reseed ? 'reseed' : 'temporary'} access failure retains its cause`, async () => {
    const error = reseed ? new AccessReseedFailed('fixture refusal') : new Error('console unavailable')
    const { run, seen, details } = fixture([mod.artifact.sha512], 0, { accessError: error })
    await expect(run()).rejects.toBe(error)
    expect(details.stops).toBe(reseed ? 1 : 0)
    expect(seen.marks).toEqual([])
    expect(details.console).toEqual([])
  })

test('startup settings use the control RCON endpoint and current passwords', async () => {
  const settings = defaultSettings({ name: 'Fixture', gameMode: 'survival', maxPlayers: 8 })
  const { run, details } = fixture([mod.artifact.sha512])
  await run({ ...revision, settings })
  expect(details.console).toEqual([
    [
      { endpoint: { host: 'installation.test', port: 25565 }, passwords: ['fixture-password'] },
      bootCommands(settings, revision.gameVersion),
    ],
  ])
  expect(details.endpoints).toContainEqual([handle, PORT_NAMES.rcon, 'control'])
  expect(details.endpoints).toContainEqual([handle, PORT_NAMES.game, 'control'])
  expect(details.notLoaded).toEqual([[server.id, []]])
})

test('a different Minecraft and loader build cannot be admitted as the pinned revision', async () => {
  const printed = ['[11:37:10] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.14.23']
  const { run, seen } = fixture([mod.artifact.sha512], 0, { printed })
  const refusal = bootMismatch(revision, bootedWith(printed))
  expect(refusal).not.toBeNull()
  await expect(run()).rejects.toThrow(refusal ?? '')
  expect(seen.access).toBe(0)
  expect(seen.marks).toEqual([])
})

test('a boot that is not ready retains its identity and underlying cause', () => {
  const cause = new Error('provider refused the start')
  const error = new NotReady('Could not start', { cause })
  expect(error.name).toBe('NotReady')
  expect(error.message).toBe('Could not start')
  expect(error.cause).toBe(cause)
})
