// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Puts a backup's world in place of the server's (§9), with a way back: the current world is
 * snapshotted first, and the server returns to it if the backup doesn't come up. Who can join is
 * never rewound (§15.1), and the server's other worlds stay as they were (`other-worlds.ts`).
 * Taking backups is `backups.ts`; rebuilding a lost host from one is `moving.ts`.
 */
import type { Db } from '@blockly/db'
import { diskForWorld, entitlementsFor } from '../../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { markReseed } from '../../access/persistence.ts'
import type { AccessReconciler } from '../../access/reconciler.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import { type BackupRecord, loadBackup } from '../../backups/persistence.ts'
import type { BackupService } from '../../backups/service.ts'
import { aside, inFull, PermanentFailure } from '../../errors.ts'
import type { ArchiveStore } from '../../ports/optional.ts'
import { type RestoreSource, RuntimeAtLimit, type RuntimeHandle } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { grownStorage, growStorage, lockServer, saveHandle } from '../../servers/persistence.ts'
import type { DesiredRuntime, RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { openInterval } from '../../servers/usage.ts'
import { reopenWorlds, type WorldRecord } from '../../worlds/persistence.ts'
import { enqueuePrune } from '../../worlds/service.ts'
import type { BootSequence } from '../boot.ts'
import { NoLongerApplies, type OperationContext, type OperationHandler } from '../runner.ts'
import { appliedConfig, bootedBack, type ServerBinding } from './binding.ts'
import type { GameConsole } from './game-console.ts'
import type { GoingBack } from './going-back.ts'
import { otherWorlds } from './other-worlds.ts'
import type { Rechecks } from './rechecks.ts'
import { IMPORT_LINK_SECONDS, type WorldCopies } from './world-copies.ts'

/**
 * A restore that ends with nothing to go back from: a server sent to the trash meanwhile, or one
 * the provider had no machine for, after waiting, and so never touched, which the queue tries
 * again later.
 */
const nothingToGoBackFrom = (error: unknown): boolean =>
  error instanceof NoLongerApplies || error instanceof RuntimeAtLimit

interface RestoringDeps {
  db: Db
  runtime: Pick<Runtimes, 'observe' | 'restore' | 'stop' | 'exec'>
  specs: Pick<RuntimeSpecs, 'desired' | 'forConfig'>
  access: Pick<AccessReconciler, 'reconcile'>
  boot: Pick<BootSequence, 'run'>
  transitions: ServerTransitions
  archives: ArchiveStore | null
  backups: Pick<BackupService, 'enforceRetention' | 'topLevelOf'>
  bindingOf: ServerBinding['bindingOf']
  progressSink: ServerBinding['progressSink']
  startCompute: ServerBinding['startCompute']
  booted: ServerBinding['booted']
  stopWhatFailed: ServerBinding['stopWhatFailed']
  mayBoot: Rechecks['mayBoot']
  preflight: Rechecks['preflight']
  windDown: GameConsole['windDown']
  copies: Pick<WorldCopies, 'capture' | 'pack'>
  putBack: GoingBack['putBack']
}

/** A backup's world put on the server's storage and booted, and the server stopped again after. */
function bringingBack(deps: RestoringDeps) {
  const { db, runtime, boot, bindingOf, progressSink, startCompute } = deps

  /**
   * Where a backup's world comes from: the provider's snapshot, or the archive store through a
   * link made just before the runtime uses it, with the sha256 the archive was written with.
   */
  const sourceOf = async (backup: BackupRecord): Promise<RestoreSource> => {
    if (backup.snapshotHandle !== null) return { kind: 'snapshot', snapshot: backup.snapshotHandle }
    if (deps.archives === null || backup.archiveKey === null)
      throw new PermanentFailure('This deployment keeps no archives, so this backup can’t be restored here.')
    const download = await deps.archives.presignGet(backup.archiveKey, IMPORT_LINK_SECONDS, 'runtime')
    return { kind: 'archive', download, sha256: backup.sha256 }
  }

  /**
   * A backup's world on the server's storage, booted while the server is `restoring`, where no
   * route reaches it, so the access record is back on the files before anyone can join (§9,
   * §15.1). It is left running, for `leaveAsAsked`.
   */
  const bringBack = async (
    ctx: OperationContext,
    server: MinecraftServer,
    backup: BackupRecord,
    target: DesiredRuntime,
  ): Promise<RuntimeHandle> => {
    const { handle } = await bindingOf(server.id)
    if (handle === null) throw new Error('The server has no storage to restore into.')
    const restored = await runtime.restore(
      handle,
      await sourceOf(backup),
      target.spec,
      progressSink(ctx, server),
    )
    await saveHandle(db, server.id, restored)
    const started = await startCompute(server.id, restored)
    await boot.run(ctx, server, started, target.revision, undefined, { startAgainOnHang: false })
    return started
  }

  /** A server that was stopped is stopped again; one that ran stays up. */
  const leaveAsAsked = async (server: MinecraftServer, started: RuntimeHandle, up: boolean) => {
    if (up) return
    await deps.windDown(server, started)
    await runtime.stop(started)
  }

  return { bringBack, leaveAsAsked }
}

export function restoring(deps: RestoringDeps) {
  const { db, runtime, transitions, specs, bindingOf, booted, stopWhatFailed, mayBoot, preflight, putBack } =
    deps
  const { bringBack, leaveAsAsked } = bringingBack(deps)
  const others = otherWorlds({ ...deps, pack: deps.copies.pack })

  /**
   * A backup gone while its restore waited its turn, before anything was touched: the server goes
   * on as it is, running or not, on what it ran.
   */
  const goneMeanwhile = async (server: MinecraftServer, binding: Awaited<ReturnType<typeof bindingOf>>) => {
    if (binding.handle === null || binding.applied === null)
      throw new PermanentFailure('That backup is no longer there.')
    const running = (await runtime.observe(binding.handle)).state === 'running'
    await putBack(server, binding.applied, { from: 'restoring', up: running })
    return { status: 'failed' as const, reason: 'That backup is no longer there, so nothing changed.' }
  }

  /**
   * A backup's world in place of the server's (§9). In-game access changes are kept first and
   * the current world is snapshotted to come back to; the access record is then re-imposed on
   * the boot, so a restore never rewinds who can join (§15.1). If the backup doesn't come up,
   * the server goes back to that snapshot.
   */
  const restore: OperationHandler = {
    kind: 'restore',
    phase: 'restoring',
    runsWhen: ['restoring'],
    abandon: stopWhatFailed(['restoring']),
    async run(ctx) {
      const server = ctx.server
      const input = ctx.op.input as { backupId: string; running: boolean; fromFailure?: boolean }
      const { up, refusal } = await mayBoot(server, input)
      const binding = await bindingOf(server.id)
      const chosen = await loadBackup(db, input.backupId)
      if (chosen === null || chosen.status !== 'ready') return goneMeanwhile(server, binding)
      if (binding.handle === null || binding.applied === null)
        throw new PermanentFailure('This server has no world to restore into.')
      const previous = binding.applied
      // A world download bigger than this disk has room for comes back on a bigger one, where the
      // plan's disks grow: the restore makes new storage from the spec anyway.
      if (chosen.tier === 'archive' && chosen.sizeBytes !== null) {
        const standing = await loadStanding(db, server.ownerId)
        const plan = entitlementsFor(standing.plan, standing.limitOverrides)
        const current = Math.max(plan.storage.startGb, await grownStorage(db, server.id))
        const bigger = diskForWorld(plan, current, chosen.sizeBytes)
        if (bigger !== null) await growStorage(db, server.id, bigger)
      }
      const desired = await specs.desired(db, server)
      await preflight(desired, null)
      if ((await runtime.observe(binding.handle)).state === 'running')
        await deps.access.reconcile(server, binding.handle, 'import').catch(() => undefined)
      // Every other world the server lists stays as it is now, whatever the backup holds.
      const besides = await others.besides(server.id, chosen)
      await ctx.step('saving')
      const before = await deps.copies.capture(server, binding.handle, previous, 'pre_restore')
      await markReseed(db, server.id)
      let left: WorldRecord[]
      try {
        const started = await bringBack(ctx, server, chosen, desired)
        left = await others.bringBack(started, before, besides)
        await leaveAsAsked(server, started, up)
      } catch (error) {
        if (nothingToGoBackFrom(error)) throw error
        await ctx.step('rolling_back')
        const quiet: OperationContext = { ...ctx, step: async () => {} }
        try {
          const back = await specs.forConfig(db, server, {
            revisionId: previous.revisionId,
            worldId: previous.worldId,
            memoryTier: previous.memoryTier as MinecraftServer['memoryTier'],
          })
          await leaveAsAsked(server, await bringBack(quiet, server, before, back), up)
          await putBack(server, bootedBack(previous, back), { from: 'restoring', up })
        } catch (again) {
          if (again instanceof NoLongerApplies) throw again
          throw new PermanentFailure(
            `The backup didn't start${aside(error)}, and going back to how the server was failed too${aside(again)}.`,
            { cause: new Error(`${inFull(error)}; going back: ${inFull(again)}`) },
          )
        }
        return {
          status: 'failed',
          reason: `The backup didn't start${aside(error)}. Your server is back as it was.`,
          detail: inFull(error),
        }
      }
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked === null || locked.lifecycle.status !== 'restoring') return
        await booted(tx, server.id, appliedConfig(locked, desired))
        // The backup brought back every world directory it held, deleted ones included.
        await reopenWorlds(tx, server.id, desired.world.id)
        await others.settle(tx, chosen, left, before)
        // Running again counts again; one that ran all along keeps the interval it has.
        if (up) await openInterval(tx, server.id, locked.memoryTier, new Date())
        const restored = await transitions.outcome(tx, locked, {
          type: 'restored',
          running: up,
          ...(refusal === null ? {} : { reason: 'policy' as const }),
        })
        if (up) await enqueuePrune(tx, transitions, restored)
      })
      await deps.backups.enforceRetention(server)
      if (refusal !== null)
        return { status: 'failed', reason: `The world is back, but the server stayed off: ${refusal}` }
      return { status: 'succeeded' }
    },
  }

  return restore
}
