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
import { type Db, schema } from '@blockly/db'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { listBackups } from '../../backups/persistence.ts'
import { inFull, inPlainWords } from '../../errors.ts'
import { HostFull, RuntimeFull } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { lockServer } from '../../servers/persistence.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { lastActivity } from '../../servers/usage.ts'
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
   * The newest snapshot of the server's world, where it holds everything played (no player was
   * seen since it was taken: a sleep takes one after any session with players) and its region has
   * room for the server; else null.
   */
  const wholeSnapshot = async (server: MinecraftServer) => {
    const [newest] = (await listBackups(db, server.id))
      .filter((b) => b.tier === 'snapshot' && b.status === 'ready' && b.worldId === server.activeWorldId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const played = await lastActivity(db, server.id)
    if (newest?.snapshotHandle == null || (played !== null && played > newest.createdAt)) return null
    const { provider } = await bindingOf(server.id)
    const { spec } = await specs.desired(db, server)
    const size = { memoryMb: spec.resources.memoryMb, storageGb: spec.storage.sizeGb }
    const room = await runtime.hasRoom(provider, { regionKey: server.regionKey }, size).catch(() => false)
    return room ? newest : null
  }

  /**
   * A start with no room where it runs just now (on Boat, the plan's starts for the hour or day
   * are spent): it goes back to sleep rather than failing, so the next join or press tries again,
   * and asking again sooner can't make room. Where it is the server's own host that can't run it
   * (HostFull, StuckOnHost), asking again can't help either: with a snapshot that holds all its
   * play, it is rebuilt from it elsewhere and started there. Anything else is rethrown.
   */
  const refusedHere = async (ctx: OperationContext, error: unknown): Promise<OperationResult> => {
    const onHost = error instanceof HostFull || error instanceof StuckOnHost
    if (!onHost && !(error instanceof RuntimeFull)) throw error
    if (onHost) await ctx.mark('host_refused')
    const from = onHost ? await wholeSnapshot(ctx.server) : null
    if (onHost)
      console.warn(
        `operation ${ctx.op.kind} ${ctx.op.id}: its host can't run it, ${from === null ? 'and no snapshot holds all its play' : 'rebuilding it elsewhere'} (${inFull(error)})`,
      )
    await db.transaction(async (tx) => {
      const server = await lockServer(tx, ctx.server.id)
      if (server?.lifecycle.status !== 'starting') return
      const stopped = await transitions.outcome(tx, server, { type: 'refused', reason: 'idle' })
      if (from === null) return
      const actor = 'system:reconcile'
      await transitions.command(
        tx,
        stopped,
        { type: 'relocate' },
        {
          requestedBy: actor,
          idempotencyKey: `relocate:host:${ctx.op.id}`,
          input: { regionKey: server.regionKey, running: true, hostLost: true },
        },
      )
      await tx.insert(schema.auditLog).values({
        actor,
        action: 'server.relocation_scheduled',
        subjectType: 'server',
        subjectId: server.id,
        data: { reason: 'host', region: server.regionKey, backupId: from.id },
      })
    })
    const reason =
      from === null
        ? inPlainWords(error)
        : 'Its computer couldn’t run it, so it is moving to another, as it was.'
    return { status: 'failed', reason, detail: inFull(error) }
  }

  return { refusedHere }
}
