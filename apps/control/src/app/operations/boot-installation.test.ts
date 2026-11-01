// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Boot verifies installed jars before admitting players and retries a bad download once. */
import { expect, test } from 'bun:test'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { diskName } from '../../minecraft/jars.ts'
import { Cdn } from '../../testing/cdn.ts'
import type { AccessReconciler } from '../access/reconciler.ts'
import type { ArtifactService } from '../artifacts/service.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import { BootSequence } from './boot.ts'
import type { OperationContext } from './runner.ts'

const mod = new Cdn().publish('verified-mod')
const revision = { loader: 'fabric' as const, loaderVersion: '0.16.14', gameVersion: '26.3', mods: [mod] }
const handle = 'installation-runtime' as RuntimeHandle
const server = { id: 'installation-server' } as MinecraftServer

function fixture(hashes: string[], exitCode = 0) {
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
    endpoint: () => ({ host: 'installation.test', port: 25565 }),
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
      reconcile: async () => {
        seen.access++
        return { restart: false }
      },
    } as unknown as AccessReconciler,
    artifacts: {
      refresh: async (id: string) => {
        seen.refreshes.push(id)
      },
    } as unknown as ArtifactService,
    logs: { recent: async () => [], async *tail() {} },
    timeouts: { runningMs: 100, readyMs: 0 },
    console: { run: async () => '', runAll: async () => [] },
    rconPasswords: () => [],
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
  return { seen, run: () => boot.run(ctx, server, handle, revision) }
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
