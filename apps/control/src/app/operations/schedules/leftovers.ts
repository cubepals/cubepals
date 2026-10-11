// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Deletes storage a runtime holds beside a server's world that nothing uses: what a wake, a restore
 * or a move that failed partway made, or a delete that gave up while the provider still held it.
 * It bills until it goes, and nothing else would ever ask again. Which storage that is, is the
 * runtime's (`clearLeftovers` on the port); this decides when it is safe to ask: under the
 * server's lock, with nothing in flight for it, since a wake or a restore makes storage before its
 * handle names it. Compute nobody accounts for is `orphans.ts`'s, which runs this as it ends.
 */
import { type Db, schema } from '@blockly/db'
import type { Runtimes } from '../../runtimes/router.ts'
import { listBindings, loadRuntime, lockServer } from '../../servers/persistence.ts'
import { activeOperation } from '../persistence.ts'

export function clearingLeftovers(deps: { db: Db; runtime: Pick<Runtimes, 'providers' | 'clearLeftovers'> }) {
  const { db, runtime } = deps

  /**
   * One server's leftovers, by its current handle. A resting server's world is in the archive
   * store, so nothing its runtime holds is the world's only copy. Returns what was deleted.
   */
  const clearOne = async (serverId: string): Promise<readonly string[]> =>
    db.transaction(async (tx) => {
      const server = await lockServer(tx, serverId)
      if (server === null || server.lifecycle.status === 'purged') return []
      if ((await activeOperation(tx, serverId)) !== null) return []
      const { handle } = await loadRuntime(tx, serverId, runtime.providers)
      if (handle === null) return []
      const deleted = await runtime.clearLeftovers(handle, server.lifecycle.status === 'stored')
      if (deleted.length > 0)
        await tx.insert(schema.auditLog).values({
          actor: 'system:orphans',
          action: 'server.leftover_storage_deleted',
          subjectType: 'server',
          subjectId: serverId,
          data: { deleted, status: server.lifecycle.status },
        })
      return deleted
    })

  /** Every server bound to a runtime here. A read that fails ends the pass. Returns how many it deleted. */
  return async (): Promise<number> => {
    let count = 0
    for (const binding of await listBindings(db, runtime.providers)) {
      if (binding.handle === null) continue
      const deleted = await clearOne(binding.serverId)
      if (deleted.length === 0) continue
      console.warn(`orphans: deleted ${deleted.join(', ')}, left beside ${binding.serverId}'s world`)
      count += deleted.length
    }
    return count
  }
}
