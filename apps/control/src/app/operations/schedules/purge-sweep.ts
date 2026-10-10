// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Queues again the decommission or purge a deleted server still owes, until it converges: the
 * purge once its restore window has closed, and before that a decommission whose retries ran out.
 * Sending a server to the trash is `expiring.ts`'s or its owner's; the work itself is the
 * operations' (`handlers/winding-down.ts`).
 */
import { type Db, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { lockServer } from '../../servers/persistence.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { latestOfKind } from '../persistence.ts'

export function purging(deps: { db: Db; transitions: Pick<ServerTransitions, 'enqueue'> }) {
  const { db, transitions } = deps

  /**
   * Deleted servers converge (§9). One whose restore window has closed is purged; before that, a
   * decommission whose retries ran out is tried again, so its compute doesn't run on until the
   * purge. Each is tried once per failure, every sweep, until it succeeds; a purge overdue by an
   * hour is an admin alert.
   */
  const purgeSweep = async (now: Date): Promise<void> => {
    const deleted = await db
      .select({ id: schema.minecraftServers.id, purgeAfter: schema.minecraftServers.purgeAfter })
      .from(schema.minecraftServers)
      .where(eq(schema.minecraftServers.status, 'deleted'))
    for (const { id, purgeAfter } of deleted) {
      await db.transaction(async (tx) => {
        const server = await lockServer(tx, id)
        if (server?.lifecycle.status !== 'deleted') return
        const kind = purgeAfter !== null && purgeAfter <= now ? 'purge' : 'decommission'
        const last = await latestOfKind(tx, id, kind)
        if (last?.status === 'queued' || last?.status === 'running') return
        if (kind === 'decommission' && last?.status !== 'failed') return
        await transitions.enqueue(tx, server, kind, {
          requestedBy: `system:${kind}`,
          idempotencyKey: last === null ? kind : `${kind}:after:${last.id}`,
        })
      })
    }
  }

  return purgeSweep
}
