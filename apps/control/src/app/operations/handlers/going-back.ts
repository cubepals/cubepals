// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server put back on the configuration it last ran, after a change to it didn't come up: with
 * the world from before the change where the change rewrote it, or removed files beside it. It
 * runs only once something else has failed, and says nothing to the owner as it goes; deciding to
 * go back, and what the owner reads afterwards, is the handler's.
 */
import type { AppliedConfigJson, Db } from '@blockly/db'
import { rewritesWorld } from '../../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { markReseed } from '../../access/persistence.ts'
import type { AccessReconciler } from '../../access/reconciler.ts'
import type { BackupRecord } from '../../backups/persistence.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { lockServer, saveHandle, setDesired } from '../../servers/persistence.ts'
import type { DesiredRuntime, RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { openInterval } from '../../servers/usage.ts'
import { enqueuePrune } from '../../worlds/service.ts'
import type { BootSequence } from '../boot.ts'
import type { OperationContext } from '../runner.ts'
import type { ServerBinding } from './binding.ts'

export type GoingBack = ReturnType<typeof goingBack>

export function goingBack(deps: {
  db: Db
  runtime: Pick<Runtimes, 'restore' | 'apply'>
  specs: Pick<RuntimeSpecs, 'forConfig'>
  access: Pick<AccessReconciler, 'reconcile'>
  boot: Pick<BootSequence, 'run'>
  transitions: ServerTransitions
  bindingOf: ServerBinding['bindingOf']
  progressSink: ServerBinding['progressSink']
  startCompute: ServerBinding['startCompute']
  booted: ServerBinding['booted']
}) {
  const { db, runtime, specs, boot, transitions, bindingOf, progressSink, startCompute, booted } = deps

  /** Puts back the configuration last applied, and the world from before the change if it rewrote it. */
  const rollBack = async (
    ctx: OperationContext,
    server: MinecraftServer,
    previous: AppliedConfigJson,
    desired: DesiredRuntime,
    /** The world from before the change; none where the change was to settings alone. */
    snapshot: BackupRecord | null,
    /** The operation going back: an update of a running server, or a start onto a change. */
    from: 'updating' | 'starting' = 'updating',
    /** The change removed files beside the world, as a new season does everyone's hearts. */
    removedFiles = false,
  ) => {
    const back = await specs.forConfig(db, server, {
      revisionId: previous.revisionId,
      worldId: previous.worldId,
      memoryTier: previous.memoryTier as MinecraftServer['memoryTier'],
    })
    let { handle } = await bindingOf(server.id)
    if (handle === null) throw new Error('The server has no runtime to go back on.')
    // Going back is one step to the owner: the boot steps it repeats would read as the change
    // still being applied.
    const quiet: OperationContext = { ...ctx, step: async () => {} }
    if (
      (rewritesWorld(back.revision, desired.revision) || removedFiles) &&
      snapshot !== null &&
      snapshot.snapshotHandle !== null
    ) {
      // The snapshot's access files are older than the record, as with any restore (§15.1): what
      // players changed in game is kept first, and the boot puts the record back on the files.
      await deps.access.reconcile(server, handle, 'import').catch(() => undefined)
      await markReseed(db, server.id)
      // The sink saves the new runtime's handle as soon as the restore issues it.
      handle = await runtime.restore(
        handle,
        { kind: 'snapshot', snapshot: snapshot.snapshotHandle },
        back.spec,
        progressSink(quiet, server),
      )
    } else {
      handle = await runtime.apply(handle, back.spec)
      await saveHandle(db, server.id, handle)
    }
    handle = await startCompute(server.id, handle)
    await boot.run(quiet, server, handle, back.revision, undefined, { startAgainOnHang: false })
    await putBack(
      server,
      { ...previous, specDigest: back.digest, driftDigest: back.driftDigest },
      { from, up: true },
    )
  }

  /**
   * What the server should run goes back to what it runs, and the update is over. After a
   * restore that went back, the server is as it was, running or stopped.
   */
  const putBack = (
    server: MinecraftServer,
    running: AppliedConfigJson,
    after: { from: 'updating' | 'restoring' | 'starting'; up: boolean } = { from: 'updating', up: true },
  ) =>
    db.transaction(async (tx) => {
      const locked = await lockServer(tx, server.id)
      if (locked === null || locked.lifecycle.status !== after.from) return
      const reverted = await setDesired(tx, locked, {
        revisionId: running.revisionId,
        memoryTier: running.memoryTier as MinecraftServer['memoryTier'],
        activeWorldId: running.worldId,
      })
      await booted(tx, server.id, running)
      if (after.from === 'starting') {
        // The start the owner asked for happened, on what the server ran before: it counts from now.
        await openInterval(tx, server.id, reverted.memoryTier, new Date())
        const started = await transitions.outcome(tx, reverted, { type: 'started' })
        await enqueuePrune(tx, transitions, started)
        return
      }
      await transitions.outcome(
        tx,
        reverted,
        after.from === 'updating'
          ? { type: 'updated', running: true }
          : { type: 'restored', running: after.up },
      )
    })

  return { rollBack, putBack }
}
