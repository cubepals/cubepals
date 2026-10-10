// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Applies a changed spec to running servers nobody is playing on, a few a pass, through the same
 * `apply` as any change. What a server's spec should be is `servers/specs.ts`'s; applying it is the
 * `apply` operation's (`handlers/updating.ts`).
 */
import type { Db } from '@blockly/db'
import type { Runtimes } from '../../runtimes/router.ts'
import { listByStatus, loadRuntime, lockServer } from '../../servers/persistence.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { presenceFor } from '../../servers/usage.ts'
import { activeOperation } from '../persistence.ts'

export function drifting(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers'>
  specs: Pick<RuntimeSpecs, 'desired'>
  transitions: Pick<ServerTransitions, 'command'>
}) {
  const { db, runtime, specs, transitions } = deps

  /**
   * A running server whose spec no longer matches what it should run drifted: a key rotation, a
   * new pinned image, anything that changes the spec without a request. It is updated through
   * the same `apply` as any change, but only while nobody is playing, and a few at a time, so a
   * deploy that moves every spec doesn't restart the whole platform under its players.
   */
  const drift = async (limit: number): Promise<number> => {
    const running = await listByStatus(db, 'running')
    const online = await presenceFor(
      db,
      running.map((s) => s.id),
    )
    let applied = 0
    for (const server of running) {
      if (applied >= limit) break
      if ((online.get(server.id)?.length ?? 0) > 0) continue
      const binding = await loadRuntime(db, server.id, runtime.providers)
      if (binding.handle === null || binding.applied === null) continue
      const desired = await specs.desired(db, server)
      // Drift is a change to what a server runs, not to its owner's plan: that waits for a start.
      if ((binding.applied.driftDigest ?? binding.applied.specDigest) === desired.driftDigest) continue
      if ((await activeOperation(db, server.id)) !== null) continue
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked?.lifecycle.status !== 'running') return
        await transitions.command(
          tx,
          locked,
          { type: 'apply' },
          { requestedBy: 'system:reconcile', idempotencyKey: `drift:${desired.driftDigest}` },
        )
      })
      applied++
    }
    return applied
  }

  return drift
}
