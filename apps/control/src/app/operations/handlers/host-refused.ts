// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A start its runtime has no room for where the server is (§9). Where only the server's own host
 * can't run it, because Fly's volume ties it to a host with no room left, or because a resume
 * that hung wedged its machine, the server is rebuilt elsewhere in its region from a snapshot that
 * holds all its play, as off a lost host (`moving.ts`), and started there (docs/resume-fallback.md).
 * It never makes a rebuild that would lose play: that is the platform's admins' (`hosts_refused`).
 */
import { type Db, schema, type Tx } from '@blockly/db'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { listBackups } from '../../backups/persistence.ts'
import { inFull, inPlainWords, PermanentFailure } from '../../errors.ts'
import { HostFull, RuntimeFull } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { lockServer } from '../../servers/persistence.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { lastRunEnded } from '../../servers/usage.ts'
import { StuckOnHost } from '../resume.ts'
import type { OperationContext, OperationResult } from '../runner.ts'
import type { ServerBinding } from './binding.ts'

export function hostRefused(deps: {
  db: Db
  runtime: Pick<Runtimes, 'hasRoom'>
  specs: Pick<RuntimeSpecs, 'desired'>
  transitions: ServerTransitions
  bindingOf: ServerBinding['bindingOf']
}) {
  const { db, runtime, specs, transitions, bindingOf } = deps

  /**
   * The snapshot a sleep took of the server's world once its last run had ended, where there is
   * one and its region has room for the server; else null. Nothing ran on the world since, so it
   * holds everything played. Any other snapshot (a schedule's, an owner's) may have been taken
   * while people played, and is never one a rebuild starts from by itself.
   */
  const wholeSnapshot = async (server: MinecraftServer) => {
    const ended = await lastRunEnded(db, server.id)
    if (ended === null) return null
    const [newest] = (await listBackups(db, server.id))
      .filter((b) => b.tier === 'snapshot' && b.status === 'ready' && b.worldId === server.activeWorldId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    if (newest?.snapshotHandle == null || newest.trigger !== 'sleep' || newest.createdAt < ended) return null
    const { provider } = await bindingOf(server.id)
    const { spec } = await specs.desired(db, server)
    const size = { memoryMb: spec.resources.memoryMb, storageGb: spec.storage.sizeGb }
    const room = await runtime.hasRoom(provider, { regionKey: server.regionKey }, size).catch(() => false)
    return room ? newest : null
  }

  /**
   * The server back to sleep from starting, where it still is, and whatever `then` does with it
   * asleep, in one transaction.
   */
  const backToSleep = (
    ctx: OperationContext,
    then: (tx: Tx, asleep: MinecraftServer) => Promise<void> = async () => {},
  ) =>
    db.transaction(async (tx) => {
      const server = await lockServer(tx, ctx.server.id)
      if (server?.lifecycle.status !== 'starting') return
      await then(tx, await transitions.outcome(tx, server, { type: 'refused', reason: 'idle' }))
    })

  /**
   * The server's own host can't run it (HostFull, StuckOnHost), and asking again soon can't help.
   * With a sleep's snapshot that holds all its play, it is rebuilt from that snapshot elsewhere and
   * started there, its old storage kept beside it. Without one, the start fails for good: a join
   * is told so, and the platform's admins are (`hosts_refused`), where going back to sleep would
   * only have a waiting join ask again every few seconds.
   */
  const hostCantRun = async (ctx: OperationContext, error: Error): Promise<OperationResult> => {
    await ctx.mark('host_refused')
    const from = await wholeSnapshot(ctx.server)
    console.warn(
      `operation ${ctx.op.kind} ${ctx.op.id}: its host can't run it, ${from === null ? 'and no snapshot from a sleep holds all its play' : 'rebuilding it elsewhere'} (${inFull(error)})`,
    )
    if (from === null) throw new PermanentFailure(inPlainWords(error), { cause: error })
    await backToSleep(ctx, async (tx, asleep) => {
      const actor = 'system:reconcile'
      const regionKey = asleep.regionKey
      await transitions.command(
        tx,
        asleep,
        { type: 'relocate' },
        {
          requestedBy: actor,
          idempotencyKey: `relocate:host:${ctx.op.id}`,
          input: { regionKey, running: true, hostLost: true, fromBackup: from.id, keepStorage: true },
        },
      )
      await tx.insert(schema.auditLog).values({
        actor,
        action: 'server.relocation_scheduled',
        subjectType: 'server',
        subjectId: asleep.id,
        data: { reason: 'host', region: regionKey, backupId: from.id },
      })
    })
    const reason = 'Its computer couldn’t run it, so it is moving to another, as it was.'
    return { status: 'failed', reason, detail: inFull(error) }
  }

  /**
   * A start with no room where it runs just now (on Boat, the plan's starts for the hour or day
   * are spent): it goes back to sleep rather than failing, so the next join or press tries again,
   * and asking again sooner can't make room. Its own host refusing it is `hostCantRun`'s; anything
   * else is rethrown.
   */
  const refusedHere = async (ctx: OperationContext, error: unknown): Promise<OperationResult> => {
    if (error instanceof HostFull || error instanceof StuckOnHost) return hostCantRun(ctx, error)
    if (!(error instanceof RuntimeFull)) throw error
    // Not a wake that cost anything: a join asking again while there is no room is no flood.
    await ctx.mark('no_room')
    await backToSleep(ctx)
    return { status: 'failed', reason: inPlainWords(error), detail: inFull(error) }
  }

  return { refusedHere }
}
