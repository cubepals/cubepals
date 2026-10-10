// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import type { AccessReconciler } from '../access/reconciler.ts'
import type { ArtifactService } from '../artifacts/service.ts'
import { DiagnosedFailure, PermanentFailure } from '../errors.ts'
import type { PackContents } from '../packs/contents.ts'
import type { LogLine } from '../ports/platform.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import { BootSequence, followBoot, stoppedWhile, stuckWhile } from './boot.ts'
import type { OperationRecord } from './persistence.ts'
import { NoLongerApplies, type OperationContext } from './runner.ts'

async function* printed(texts: readonly string[]): AsyncIterable<LogLine> {
  for (const text of texts) yield { at: new Date(), text }
}

const follow = async (lines: AsyncIterable<LogLine>, signal = new AbortController().signal) => {
  const steps: string[] = []
  await followBoot(lines, signal, async (step) => {
    steps.push(step)
  })
  return steps
}

// A vanilla 26.3 server's first start, as the image printed it on 2026-09-23.
describe('following a start', () => {
  test('the steps move on as the server gets there, and only forward', async () => {
    const steps = await follow(
      printed([
        '[init] Resolving type given VANILLA',
        '[init] Successfully setup vanilla Minecraft version 26.3',
        '[init] Starting the Minecraft server...',
        'WARNING: A restricted method in java.lang.System has been called',
        '[18:29:35] [Server thread/INFO]: Starting minecraft server version 26.3',
        '[18:29:35] [Server thread/INFO]: Preparing level "world"',
        '[18:29:35] [Server thread/INFO]: Starting remote control listener',
      ]),
    )
    expect(steps).toEqual(['starting', 'loading_world'])
  })

  test('a step it missed is skipped rather than shown late', async () => {
    const steps = await follow(printed(['[18:29:35] [Server thread/INFO]: Preparing level "world"']))
    expect(steps).toEqual(['loading_world'])
  })

  test('once the start is over, nothing it printed moves the steps', async () => {
    const reading = new AbortController()
    async function* lines(): AsyncIterable<LogLine> {
      yield { at: new Date(), text: '[init] Starting the Minecraft server...' }
      reading.abort()
      yield { at: new Date(), text: '[18:29:35] [Server thread/INFO]: Preparing level "world"' }
    }
    expect(await follow(lines(), reading.signal)).toEqual(['starting'])
  })

  test('a log that breaks off leaves the steps where they are', async () => {
    async function* lines(): AsyncIterable<LogLine> {
      yield { at: new Date(), text: '[init] Starting the Minecraft server...' }
      throw new Error('the log went away')
    }
    expect(await follow(lines())).toEqual(['starting'])
  })
})

describe('where a start stopped', () => {
  test('is said by how far it got, and the world only once it was opening', () => {
    expect(stoppedWhile('booting')).toBe('It stopped while being set up, before Minecraft started.')
    expect(stoppedWhile('starting')).toBe('It stopped while Minecraft was starting, before its world opened.')
    expect(stoppedWhile('loading_world')).toBe('The server stopped while loading its world.')
  })
})

describe('where a start kept hanging', () => {
  test('is said by how far it got, and that it was tried twice', () => {
    expect(stuckWhile('booting')).toBe('It never finished being set up, even on a second try.')
    expect(stuckWhile('starting')).toBe('Minecraft never finished starting, even on a second try.')
    expect(stuckWhile('loading_world')).toBe('Its world never finished loading, even on a second try.')
  })

  test('or once, where it was waited on once', () => {
    expect(stuckWhile('loading_world', 1)).toBe('Its world never finished loading.')
  })
})

const handle = 'machine-1' as RuntimeHandle
const server = { id: 'server-1' } as MinecraftServer
const vanilla = { loader: 'vanilla' as const, mods: [], gameVersion: '1.21.4', loaderVersion: null }

/**
 * One server's machine as a start sees it. `process` counts what ran on it: 1 is what was started
 * before the boot began, and every start or start again after it is the next. `answers` says
 * whether that one answers a ping, and `printed` what it wrote.
 */
function machine(options: {
  answers: (process: number) => boolean
  printed?: (process: number) => readonly string[]
  readyMs?: number
  stillApplies?: () => boolean
  stopFails?: boolean
  /** When the process before this one failed, where the provider started it again on its own. */
  failedAt?: (process: number) => Date | undefined
  pack?: Pick<PackContents, 'load' | 'leaveOutAfterCrash' | 'keepAfterCrash'>
}) {
  const seen = { process: 1, stops: 0, forceStops: 0, reprovisions: 0 }
  const lines = () => (options.printed?.(seen.process) ?? []).map((text) => ({ at: new Date(), text }))
  const runtime = {
    waitRunning: async () => {},
    endpoint: () => ({ host: 'server-1.test', port: 25565 }),
    observe: async () => {
      const failedAt = options.failedAt?.(seen.process)
      return { state: 'running', at: new Date(), ...(failedAt ? { failedAt } : {}) }
    },
    stop: async () => {
      seen.stops++
      if (options.stopFails) throw new Error('the machine did not stop in time')
    },
    forceStop: async () => {
      seen.forceStops++
    },
    start: async () => {
      seen.process++
    },
  } as unknown as Runtimes
  // As every adapter's: a stop, forced where it won't, then a start on the same compute.
  runtime.restart = async (handle) => {
    await runtime.stop(handle).catch(() => runtime.forceStop(handle))
    await runtime.start(handle)
  }
  const boot = new BootSequence({
    runtime,
    probe: {
      ping: async () => {
        if (!options.answers(seen.process)) throw new Error('Connection refused')
        return { online: 0, max: 20, version: '1.21.4' }
      },
    },
    access: { reconcile: async () => ({ restart: false }) } as unknown as AccessReconciler,
    artifacts: { refresh: async () => {} } as unknown as ArtifactService,
    logs: {
      recent: async () => lines(),
      async *tail() {
        yield* lines()
      },
    },
    timeouts: { runningMs: 1_000, readyMs: options.readyMs ?? 0 },
    packs: options.pack ?? null,
    console: { run: async () => '', runAll: async () => [] },
    rconPasswords: () => [],
  })
  const ctx: OperationContext = {
    op: { id: 'operation-1', kind: 'provision' } as OperationRecord,
    server,
    step: async () => {},
    stillApplies: async () => options.stillApplies?.() ?? true,
  }
  const reprovision = async () => {
    seen.reprovisions++
    seen.process++
    return handle
  }
  return { boot, ctx, seen, reprovision }
}

// A pack's first start on staging (2026-09-27) got to its world, then answered nothing: every
// retry waited another ten minutes on the same process, and nobody was told for half an hour.
describe('a start that stops answering', () => {
  test('is started once more, fresh, and is up when that one answers', async () => {
    const { boot, ctx, seen } = machine({ answers: (process) => process > 1 })
    await boot.run(ctx, server, handle, vanilla)
    expect(seen).toMatchObject({ stops: 1, process: 2 })
  })

  test('that hangs again fails for good, saying how far it got', async () => {
    const { boot, ctx, seen } = machine({
      answers: () => false,
      printed: () => [
        '[init] Starting the Minecraft server...',
        '[18:29:35] [Server thread/INFO]: Preparing level "world"',
      ],
      // Long enough for its output to move the steps on before the wait runs out.
      readyMs: 10,
    })
    const failed = await boot.run(ctx, server, handle, vanilla).then(
      () => null,
      (error: unknown) => error,
    )
    // For good: the operation's next attempt would only wait on the same process again.
    expect(failed).toBeInstanceOf(PermanentFailure)
    expect((failed as Error).message).toBe(stuckWhile('loading_world'))
    expect(seen).toMatchObject({ stops: 1, process: 2 })
  }, 15_000)

  test('where the operation has its own way back, fails at once, said as one wait', async () => {
    const { boot, ctx, seen } = machine({
      answers: () => false,
      printed: () => ['[18:29:35] [Server thread/INFO]: Preparing level "world"'],
      readyMs: 10,
    })
    const failed = await boot.run(ctx, server, handle, vanilla, undefined, { startAgainOnHang: false }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(PermanentFailure)
    expect((failed as Error).message).toBe(stuckWhile('loading_world', 1))
    // Its rollback or its going back is the fresh start: nothing here stops or starts it.
    expect(seen).toMatchObject({ stops: 0, process: 1 })
  }, 15_000)

  test('a machine that won’t stop is stopped by force before it starts again', async () => {
    const { boot, ctx, seen } = machine({ answers: (process) => process > 1, stopFails: true })
    await boot.run(ctx, server, handle, vanilla)
    expect(seen).toMatchObject({ stops: 1, forceStops: 1, process: 2 })
  })

  test('fails with what its output names, without being waited on again', async () => {
    const { boot, ctx, seen } = machine({
      answers: () => false,
      printed: () => ['[Server thread/ERROR]: java.lang.OutOfMemoryError: GC overhead limit exceeded'],
    })
    const failed = await boot.run(ctx, server, handle, vanilla).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(DiagnosedFailure)
    expect((failed as DiagnosedFailure).remedy).toBe('more_room')
    expect(seen).toMatchObject({ stops: 0, process: 1 })
  })

  test('starts a pack server again on what it named, and that start counts as its second', async () => {
    const learned: string[] = []
    const { boot, ctx, seen, reprovision } = machine({
      answers: () => false,
      printed: (process) =>
        process === 1
          ? [
              '[Server thread/ERROR]: java.awt.HeadlessException',
              '\tat com.example.window.Window.open(Window.java:10) ~[fancywindow-1.0.jar:?]',
            ]
          : [],
      pack: {
        load: async () => null,
        leaveOutAfterCrash: async (_sha512, mods) => {
          learned.push(...mods.map((mod) => mod.name))
          return ['mods/fancywindow-1.0.jar']
        },
        keepAfterCrash: async () => null,
      },
    })
    const modpack = {
      artifact: { sha512: 'pack', ref: { kind: 'remote', url: 'https://cdn.test/pack.mrpack' } },
    } as unknown as ServerRevision['modpack']
    const failed = await boot
      .run(ctx, server, handle, { ...vanilla, loader: 'fabric', modpack }, reprovision)
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(learned).toHaveLength(1)
    expect(failed).toBeInstanceOf(PermanentFailure)
    expect((failed as Error).message).toBe(stuckWhile('booting'))
    // Two long waits at most: once on the pack as it was, once on what it learned.
    expect(seen).toMatchObject({ reprovisions: 1, stops: 0, process: 2 })
  })
})

// Cabricality on staging (2026-09-28): it stopped over Equator, and Fly started it again three
// times on the same pack before giving up; only then did the pack learn it needs Equator.
describe('a start the provider starts again after it fails', () => {
  const modpack = {
    artifact: { sha512: 'pack', ref: { kind: 'remote', url: 'https://cdn.test/pack.mrpack' } },
  } as unknown as ServerRevision['modpack']
  const quilt = { ...vanilla, gameVersion: '1.18.2', loader: 'quilt' as const, modpack }
  const missingEquator = [
    '[main/ERROR]: Crashed! The full crash report has been saved to ./crash-reports/crash.txt',
    'Cabricality requires version [2.5.3, ∞) of equator, which is missing!',
  ]

  test('is not waited on: the pack learns what it named and starts again at once', async () => {
    const kept: string[] = []
    const failed = new Date(Date.now() + 1)
    const { boot, ctx, seen, reprovision } = machine({
      answers: (process) => process > 1,
      printed: (process) => (process === 1 ? missingEquator : []),
      failedAt: (process) => (process === 1 ? failed : undefined),
      readyMs: 60_000,
      pack: {
        load: async () => null,
        leaveOutAfterCrash: async () => [],
        keepAfterCrash: async (_sha512, mod) => {
          kept.push(mod)
          return 'mods/equator-1.18-2.5.3.jar'
        },
      },
    })
    const started = Date.now()
    await boot.run(ctx, server, handle, quilt, reprovision)
    expect(kept).toEqual(['equator'])
    expect(seen).toMatchObject({ reprovisions: 1, process: 2 })
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 15_000)

  test('a failure from before this start is not this start’s', async () => {
    const { boot, ctx, seen, reprovision } = machine({
      answers: () => true,
      printed: () => missingEquator,
      failedAt: () => new Date(Date.now() - 60_000),
      pack: {
        load: async () => null,
        leaveOutAfterCrash: async () => [],
        keepAfterCrash: async () => 'mods/equator-1.18-2.5.3.jar',
      },
    })
    await boot.run(ctx, server, handle, quilt, reprovision)
    expect(seen).toMatchObject({ reprovisions: 0, process: 1 })
  })

  test('one whose output names nothing is left to the provider’s start again', async () => {
    const { boot, ctx, seen } = machine({
      answers: (process) => process > 1 || Date.now() > answersAfter,
      printed: () => ['[Server thread/INFO]: Starting minecraft server version 1.18.2'],
      failedAt: () => new Date(Date.now() + 1),
      readyMs: 60_000,
    })
    const answersAfter = Date.now() + 3_000
    await boot.run(ctx, server, handle, vanilla)
    expect(seen).toMatchObject({ stops: 0, process: 1 })
  }, 15_000)
})

// Zombie Invade 100 Days on staging (2026-09-28): Forge stopped over a mod made for players' games
// and wrote its crash report, then its process ran on, answering nothing, for ten minutes.
describe('a start that writes its crash report and runs on', () => {
  const modpack = {
    artifact: { sha512: 'pack', ref: { kind: 'remote', url: 'https://cdn.test/pack.mrpack' } },
  } as unknown as ServerRevision['modpack']
  const forge = { ...vanilla, gameVersion: '1.20.1', loader: 'forge' as const, modpack }
  const crashed = [
    '[Server thread/ERROR]: java.awt.HeadlessException',
    '\tat com.example.window.Window.open(Window.java:10) ~[fancywindow-1.0.jar:?]',
    '[main/FATAL] [ne.mi.se.lo.ServerModLoader/]: Crash report saved to ./crash-reports/crash-2026-09-28_01.55.54-fml.txt',
  ]

  test('is not waited on: the pack learns what it named and starts again at once', async () => {
    const learned: string[] = []
    const { boot, ctx, seen, reprovision } = machine({
      answers: (process) => process > 1,
      printed: (process) => (process === 1 ? crashed : []),
      readyMs: 60_000,
      pack: {
        load: async () => null,
        leaveOutAfterCrash: async (_sha512, mods) => {
          learned.push(...mods.map((mod) => mod.name))
          return ['mods/fancywindow-1.0.jar']
        },
        keepAfterCrash: async () => null,
      },
    })
    const started = Date.now()
    await boot.run(ctx, server, handle, forge, reprovision)
    expect(learned).toHaveLength(1)
    expect(seen).toMatchObject({ reprovisions: 1, process: 2 })
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 15_000)

  test('one whose output names no cause is waited on as before', async () => {
    const { boot, ctx, seen } = machine({
      answers: () => Date.now() > answersAfter,
      printed: () => ['[main/FATAL]: Crash report saved to ./crash-reports/crash.txt'],
      readyMs: 60_000,
    })
    const answersAfter = Date.now() + 3_000
    await boot.run(ctx, server, handle, vanilla)
    expect(seen).toMatchObject({ stops: 0, process: 1 })
  }, 15_000)
})

// Trashed on staging (2026-09-27) while its first start hung, a server kept its machine running
// ten more minutes: the decommission waited behind a start that waited out its full time.
describe('a server sent to the trash while it starts', () => {
  test('is waited on no longer, and not started again', async () => {
    let trashed = false
    const { boot, ctx, seen } = machine({
      answers: () => false,
      readyMs: 60_000,
      stillApplies: () => !trashed,
    })
    setTimeout(() => {
      trashed = true
    }, 100)
    const started = Date.now()
    const ended = await boot.run(ctx, server, handle, vanilla).then(
      () => null,
      (error: unknown) => error,
    )
    expect(ended).toBeInstanceOf(NoLongerApplies)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(seen).toMatchObject({ stops: 0, process: 1 })
  }, 15_000)

  test('is not assumed when the server can’t be read', async () => {
    const { boot, ctx, seen } = machine({
      answers: (process) => process > 1,
      stillApplies: () => {
        throw new Error('Connection terminated unexpectedly')
      },
    })
    await boot.run(ctx, server, handle, vanilla)
    expect(seen).toMatchObject({ stops: 1, process: 2 })
  })
})
