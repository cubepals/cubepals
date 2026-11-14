// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's runtime binding as operations hold it: the compute its handle names, and the
 * configuration it was last booted with. It reads and writes the binding row and nothing else of
 * the server; what a boot changes in the server's status, and the power intervals it opens, are
 * each handler's own final transaction.
 */
import type { AppliedConfigJson, Db, Tx } from '@blockly/db'
import type { ServerStatus } from '../../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { PermanentFailure } from '../../errors.ts'
import type { JobQueue } from '../../ports/jobs.ts'
import type { ProgressSink, RuntimeHandle } from '../../ports/runtime.ts'
import { knownSlow } from '../../runtimes/hosts.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { findServer, loadRuntime, memoryKept, saveApplied, saveHandle } from '../../servers/persistence.ts'
import type { DesiredRuntime } from '../../servers/specs.ts'
import { tuning } from '../../tuning.ts'
import type { OperationContext, OperationHandler } from '../runner.ts'

export type ServerBinding = ReturnType<typeof serverBinding>

/** The configuration a server runs once `desired` has booted on it. */
export const appliedConfig = (server: MinecraftServer, desired: DesiredRuntime) => ({
  revisionId: desired.revision.id,
  worldId: desired.world.id,
  memoryTier: server.memoryTier,
  regionKey: server.regionKey,
  specDigest: desired.digest,
  driftDigest: desired.driftDigest,
  secretsVersion: desired.secretsVersion,
  proxyProtocol: desired.proxyProtocol,
  compat: desired.compat,
  placedStopCheaters: desired.stopCheaters,
  ...keyOf(desired),
})

/** The resume key a boot leaves its machine asleep on, and its parts (`resume-parts.ts`). */
const keyOf = (desired: DesiredRuntime) =>
  desired.spec.resumesOn === undefined
    ? {}
    : { resumesOn: desired.spec.resumesOn, resumeParts: desired.resumeParts }

/** What a server runs once the configuration it ran before, `previous`, booted again as `back`. */
export const bootedBack = (previous: AppliedConfigJson, back: DesiredRuntime): AppliedConfigJson => ({
  ...previous,
  specDigest: back.digest,
  driftDigest: back.driftDigest,
  proxyProtocol: back.proxyProtocol,
  compat: back.compat,
  placedStopCheaters: back.stopCheaters,
  ...keyOf(back),
})

export function serverBinding(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'start' | 'stop' | 'forceStop' | 'locate'>
  jobs: Pick<JobQueue, 'enqueueEligibility'>
}) {
  const { db, runtime } = deps

  /** The machine a handle names, as the provider calls it, kept on the operation (`machine:<id>`). */
  const machineOf = (handle: RuntimeHandle) =>
    runtime.locate(handle).names.find((name) => name.label === 'Machine')?.value ?? null

  /**
   * What a runtime is told of hosts as it provisions: whether one is known to be slow, by the
   * deployment's floor. With no floor nothing is offered, so no runtime asks and nothing is read.
   */
  const slowHosts = (): Pick<ProgressSink, 'slowHost'> => {
    const floorMhz = tuning().slowHostMhz ?? 0
    if (floorMhz <= 0) return {}
    return { slowHost: (provider, host) => knownSlow(db, provider, host, floorMhz) }
  }

  const progressSink = (ctx: OperationContext, server: MinecraftServer): ProgressSink => ({
    step: (step) => ctx.step(step),
    // Which machine the operation acted on, so its record says so after the provider forgets it.
    handle: async (handle) => {
      await saveHandle(db, server.id, handle, server.regionKey)
      const machine = machineOf(handle)
      if (machine !== null) await ctx.mark(`machine:${machine}`)
    },
    // A machine stopped though its last sleep kept its memory: the provider dropped what it kept.
    mark: async (mark) =>
      ctx.mark(mark === 'not_asleep' && (await memoryKept(db, server.id)) ? 'memory_lost' : mark),
    ...slowHosts(),
  })

  /** Starts compute and keeps the handle it comes back with, which may reach it at another address. */
  const startCompute = async (serverId: string, handle: RuntimeHandle): Promise<RuntimeHandle> => {
    const next = await runtime.start(handle)
    if (next !== handle) await saveHandle(db, serverId, next)
    return next
  }

  /**
   * What a server now runs, saved; its listing is looked at again, since trust is judged on the
   * revision the server booted (§15.3).
   */
  const booted = async (tx: Tx, serverId: string, config: AppliedConfigJson) => {
    await saveApplied(tx, serverId, config)
    await deps.jobs.enqueueEligibility([serverId], tx)
  }

  /** A server whose runtime another provider made is never touched: its world is elsewhere. */
  const bindingOf = async (serverId: string) => {
    const binding = await loadRuntime(db, serverId, runtime.providers)
    if (binding.foreign)
      throw new PermanentFailure(
        'This server is hosted somewhere Cubepals no longer runs servers, so it can’t be changed.',
        {
          cause: new Error(
            `bound to the ${binding.provider} provider; this deployment runs ${runtime.providers.join(', ')}`,
          ),
        },
      )
    return binding
  }

  /**
   * An operation that fails for good leaves its server failed, and a failed server holds no
   * compute (§10): what the attempt left running stops, so nothing runs that nobody can reach or
   * counts. A failure the handler settled itself (put back, stayed off) has left the phase, and
   * that server is left as it is.
   */
  const stopWhatFailed =
    (phases: readonly ServerStatus[]): NonNullable<OperationHandler['abandon']> =>
    async (op, _reason, ended) => {
      if (ended !== 'failed') return
      const server = await findServer(db, op.serverId)
      if (server === null || !phases.includes(server.lifecycle.status)) return
      const { handle } = await loadRuntime(db, op.serverId, runtime.providers)
      if (handle === null) return
      await runtime.stop(handle).catch(() => runtime.forceStop(handle))
    }

  return { bindingOf, progressSink, startCompute, booted, stopWhatFailed }
}
