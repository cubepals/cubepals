// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Brings a running server's access files in line with Blockly's record (§15.1). A stopped server
 * keeps its pending changes for its next boot, and a delivery that fails is recorded on the
 * entries rather than failing the operation. The reconciling itself is `AccessReconciler`'s.
 */
import type { Db } from '@blockly/db'
import { recordSyncError } from '../../access/persistence.ts'
import type { AccessReconciler } from '../../access/reconciler.ts'
import type { OperationHandler } from '../runner.ts'
import type { ServerBinding } from './binding.ts'

export function syncingAccess(deps: {
  db: Db
  access: Pick<AccessReconciler, 'reconcile'>
  bindingOf: ServerBinding['bindingOf']
}) {
  const { db, bindingOf } = deps

  const accessSync: OperationHandler = {
    kind: 'access_sync',
    phase: null,
    runsWhen: [
      'provisioning',
      'stopped',
      'starting',
      'running',
      'stopping',
      'updating',
      'restoring',
      'relocating',
      'failed',
    ],
    async run(ctx) {
      // A stopped server keeps its pending changes; the next boot delivers them.
      if (ctx.server.lifecycle.status !== 'running') return { status: 'succeeded' }
      const { handle } = await bindingOf(ctx.server.id)
      if (handle === null) return { status: 'succeeded' }
      try {
        await deps.access.reconcile(ctx.server, handle, 'full')
      } catch (error) {
        // Delivery problems are shown on the entries and retried at the next sync point; they never
        // hold up the server's other operations.
        await recordSyncError(db, ctx.server.id, error instanceof Error ? error.message : String(error))
      }
      return { status: 'succeeded' }
    },
  }

  return accessSync
}
