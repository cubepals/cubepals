// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Removes the directories of a server's deleted worlds while it runs, since removing them takes an
 * `exec` on running compute. The command is `minecraft/worlds.ts`'s; deleting a world, and
 * queueing this, is `WorldService`'s.
 */
import type { Db } from '@blockly/db'
import { pruneWorldsCommand } from '../../../minecraft/worlds.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { awaitingPrune, markPruned } from '../../worlds/persistence.ts'
import type { OperationHandler } from '../runner.ts'
import type { ServerBinding } from './binding.ts'

export function pruningWorlds(deps: {
  db: Db
  runtime: Pick<Runtimes, 'exec'>
  bindingOf: ServerBinding['bindingOf']
}) {
  const { db, runtime, bindingOf } = deps

  /** Directories of deleted worlds, removed while the server runs (`exec` needs it running). */
  const pruneWorlds: OperationHandler = {
    kind: 'prune_worlds',
    phase: null,
    runsWhen: ['running'],
    async run(ctx) {
      const server = ctx.server
      const { handle } = await bindingOf(server.id)
      const worlds = await awaitingPrune(db, server.id, server.activeWorldId)
      if (handle === null || worlds.length === 0) return { status: 'succeeded' }
      const result = await runtime.exec(handle, pruneWorldsCommand(worlds.map((w) => w.levelName)), 120)
      if (result.exitCode !== 0) throw new Error(`Removing old worlds failed: ${result.stderr.trim()}`)
      await markPruned(
        db,
        worlds.map((w) => w.id),
        new Date(),
      )
      return { status: 'succeeded' }
    },
  }

  return pruneWorlds
}
