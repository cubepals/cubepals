// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Takes a server down: stopped (its world saved and measured first), decommissioned into the trash
 * with its storage kept, or purged for good. Each ends what the server is billed for and who is on
 * it. Saving through the console is `game-console.ts`'s; when a server is purged is the purge
 * sweep's (`schedules.ts`).
 */
import { type Db, schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { entitlementsFor, grownDisk } from '../../../domain/account/entitlements.ts'
import type { StopReason } from '../../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { DATA_DIR } from '../../../minecraft/jars.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import { forgetPlayers } from '../../players/persistence.ts'
import type { PlayerService } from '../../players/service.ts'
import { type RuntimeHandle, runtimeKey } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { grownStorage, lockServer, recordDisk, saveHandle } from '../../servers/persistence.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { clearPresence, closeInterval } from '../../servers/usage.ts'
import type { OperationHandler } from '../runner.ts'
import type { ServerBinding } from './binding.ts'
import type { GameConsole } from './game-console.ts'

export function windingDown(deps: {
  db: Db
  runtime: Pick<Runtimes, 'stop' | 'forceStop' | 'decommission' | 'destroy' | 'exec'>
  transitions: Pick<ServerTransitions, 'outcome'>
  bindingOf: ServerBinding['bindingOf']
  windDown: GameConsole['windDown']
  players: Pick<PlayerService, 'snapshot'>
}) {
  const { db, runtime, transitions, bindingOf, windDown } = deps

  /**
   * What the world takes on disk, read while the server still runs, just saved: what
   * a resting copy costs, and whether the next start needs a bigger disk. Best effort: a server
   * that won't answer stops all the same.
   */
  const measureDisk = async (server: MinecraftServer, handle: RuntimeHandle) => {
    const read = await runtime.exec(handle, ['du', '-sk', DATA_DIR], 60).catch(() => null)
    if (read === null || read.exitCode !== 0) return
    const kilobytes = Number.parseInt(read.stdout.trim().split(/\s+/)[0] ?? '', 10)
    if (!Number.isFinite(kilobytes)) return
    const usedBytes = kilobytes * 1024
    const standing = await loadStanding(db, server.ownerId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    const current = Math.max(plan.storage.startGb, await grownStorage(db, server.id))
    await recordDisk(db, server.id, usedBytes, new Date(), grownDisk(plan, current, usedBytes) ?? undefined)
  }

  const stop: OperationHandler = {
    kind: 'stop',
    phase: 'stopping',
    runsWhen: ['stopping'],
    async run(ctx) {
      const server = ctx.server
      const { handle } = await bindingOf(server.id)
      if (handle !== null) {
        await ctx.step('saving')
        await windDown(server, handle)
        await measureDisk(server, handle)
        // One more exec, while the files are just saved and still cheap to read.
        await deps.players.snapshot(server, handle).catch(() => undefined)
        await ctx.step('stopping')
        await runtime.stop(handle)
      }
      const reason = (ctx.op.input.reason as StopReason | undefined) ?? 'user'
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked === null || locked.lifecycle.status !== 'stopping') return
        await closeInterval(tx, server.id, new Date())
        await clearPresence(tx, server.id)
        await transitions.outcome(tx, locked, { type: 'stopped', reason })
      })
      return { status: 'succeeded' }
    },
    /** A stop that failed for good is forced (§9): nothing runs on that nobody asked for. */
    async abandon(op, _reason, ended) {
      if (ended !== 'failed') return
      const { handle } = await bindingOf(op.serverId)
      if (handle === null) return
      await runtime.forceStop(handle)
      // Off is off: its time stops counting and nobody is on it.
      await db.transaction(async (tx) => {
        await closeInterval(tx, op.serverId, new Date())
        await clearPresence(tx, op.serverId)
      })
    },
  }

  const decommission: OperationHandler = {
    kind: 'decommission',
    phase: null,
    runsWhen: ['deleted'],
    async run(ctx) {
      const server = ctx.server
      const { handle } = await bindingOf(server.id)
      if (handle !== null) {
        await windDown(server, handle)
        await runtime.decommission(handle)
      }
      await db.transaction(async (tx) => {
        await closeInterval(tx, server.id, new Date())
        await clearPresence(tx, server.id)
      })
      return { status: 'succeeded' }
    },
  }

  const purge: OperationHandler = {
    kind: 'purge',
    phase: null,
    runsWhen: ['deleted'],
    async run(ctx) {
      const server = ctx.server
      const { handle, provider } = await bindingOf(server.id)
      await runtime.destroy(provider, handle ?? runtimeKey(server.id))
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked === null || locked.lifecycle.status !== 'deleted') return
        await saveHandle(tx, server.id, null)
        await tx.delete(schema.serverAccessEntries).where(eq(schema.serverAccessEntries.serverId, server.id))
        // Who played there goes with who could: with the server gone, nothing needs their names.
        await tx.delete(schema.serverPlayers).where(eq(schema.serverPlayers.serverId, server.id))
        await forgetPlayers(tx, server.id)
        // Its guestbook too: the notes were about a server that is no longer anywhere.
        await tx.delete(schema.serverStars).where(eq(schema.serverStars.serverId, server.id))
        await tx.delete(schema.serverNotes).where(eq(schema.serverNotes.serverId, server.id))
        // The provider's snapshots went with everything else.
        await tx
          .update(schema.backups)
          .set({ status: 'deleted' })
          .where(and(eq(schema.backups.serverId, server.id), eq(schema.backups.tier, 'snapshot')))
        // So does the copy a world rested in: it was the server's world, not a download of it,
        // and the store lets it go at the next sweep.
        await tx
          .update(schema.backups)
          .set({ status: 'deleted' })
          .where(and(eq(schema.backups.serverId, server.id), eq(schema.backups.trigger, 'stored')))
        await transitions.outcome(tx, locked, { type: 'purged' })
      })
      return { status: 'succeeded' }
    },
  }

  return { stop, decommission, purge }
}
