// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stops provider compute that runs with no running server behind it, and destroys compute that no
 * live binding holds: what a purged server or a move left behind. Compute whose server the
 * database doesn't know is stopped if it runs, and otherwise kept for an operator. Noticing a
 * stray machine as it changes is `reconcile.ts`'s too; a server's own end is the `purge`
 * operation's (`handlers/winding-down.ts`). Storage left beside a server's world goes as the sweep
 * ends (`leftovers.ts`).
 */
import { type Db, schema } from '@blockly/db'
import type { Runtimes } from '../../runtimes/router.ts'
import { findServer, loadRuntime, lockServer } from '../../servers/persistence.ts'
import { activeOperation } from '../persistence.ts'
import { clearingLeftovers } from './leftovers.ts'
import { SERVER_ID } from './reconcile.ts'
import { strayCompute } from './stray.ts'

export function clearingOrphans(deps: {
  db: Db
  runtime: Pick<
    Runtimes,
    | 'inventory'
    | 'providerOf'
    | 'providers'
    | 'destroy'
    | 'observeChanged'
    | 'sameCompute'
    | 'stop'
    | 'clearLeftovers'
  >
}) {
  const { db, runtime } = deps
  const clearLeftovers = clearingLeftovers(deps)

  /**
   * Running compute no running server accounts for is stopped, never destroyed: it is billed by
   * the hour, nobody can reach a server the edge doesn't route to, and a stopped machine keeps its
   * world. That covers a database restored from an older backup too: its newer servers stop, whole,
   * for an operator to look at. Returns how many it stopped.
   */
  const stopStrays = async (): Promise<number> => {
    let stopped = 0
    for (const stray of await strayCompute(db, runtime)) {
      // With the server's row held, so a start asked for since the listing waits for this stop
      // rather than being stopped under it; with work in flight now, it is left to the next sweep.
      const done = await db.transaction(async (tx) => {
        const { serverId } = stray
        if (serverId !== null) {
          if ((await lockServer(tx, serverId)) === null) return false
          if ((await activeOperation(tx, serverId)) !== null) return false
        }
        await runtime.stop(stray.handle)
        await tx.insert(schema.auditLog).values({
          actor: 'system:orphans',
          action: 'server.stray_compute_stopped',
          subjectType: 'server',
          subjectId: serverId ?? stray.key,
          data: { status: stray.status, known: serverId !== null },
        })
        return true
      })
      if (!done) continue
      console.warn(
        `orphans: stopped ${stray.key}, running with ${stray.status ?? 'no server here'} behind it`,
      )
      stopped++
    }
    return stopped
  }

  /**
   * Provider resources a purged server or a move left behind are destroyed. Scoped to this
   * deployment by the adapter. Compute whose server the database doesn't know is kept, and logged
   * each time it is seen: after the database is restored from a backup, that is every server made
   * since, and destroying a world can't be undone. A read that fails ends the sweep: an unreachable
   * database is not "nobody owns it".
   */
  const orphans = async (): Promise<void> => {
    await stopStrays()
    for await (const item of runtime.inventory()) {
      const owner = runtime.providerOf(item.handle)
      if (owner === null) continue
      // A key that isn't a server id belongs to no server, and would only make the query fail.
      const server = SERVER_ID.test(item.key) ? await findServer(db, item.key) : null
      if (server === null) {
        console.warn(`orphans: ${owner} holds ${item.key}, which no server here knows; kept for an operator`)
        continue
      }
      if (server.lifecycle.status === 'purged') {
        await runtime.destroy(owner, item.handle)
        continue
      }
      // Compute on a runtime its server isn't bound to was left by a move or a first start's
      // fallback (docs/runtimes.md): the server is elsewhere. Never while something is in flight
      // for it, since a move holds both until it changes the binding.
      const binding = await loadRuntime(db, server.id, runtime.providers)
      if (binding.provider === owner || binding.foreign) continue
      if ((await activeOperation(db, server.id)) !== null) continue
      await runtime.destroy(owner, item.handle)
    }
    await clearLeftovers()
  }

  return orphans
}
