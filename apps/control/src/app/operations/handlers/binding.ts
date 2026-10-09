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
import type { Runtimes } from '../../runtimes/router.ts'
import { findServer, loadRuntime, saveApplied, saveHandle } from '../../servers/persistence.ts'
import type { DesiredRuntime } from '../../servers/specs.ts'
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
})

export function serverBinding(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'start' | 'stop' | 'forceStop'>
  jobs: Pick<JobQueue, 'enqueueEligibility'>
}) {
  const { db, runtime } = deps

  const progressSink = (ctx: OperationContext, server: MinecraftServer): ProgressSink => ({
    step: (step) => ctx.step(step),
    handle: (handle) => saveHandle(db, server.id, handle, server.regionKey),
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
