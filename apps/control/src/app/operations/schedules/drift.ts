// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Applies a changed spec to running servers nobody is playing on, a few a pass, through the same
 * `apply` as any change. What a server's spec should be is `servers/specs.ts`'s; applying it is the
 * `apply` operation's (`handlers/updating.ts`).
 */
import { HOUR_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { listByStatus, lockServer } from '../../servers/persistence.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { presenceFor } from '../../servers/usage.ts'
import { activeOperation } from '../persistence.ts'
import { appliedDigests } from './placements.ts'

export function drifting(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers'>
  specs: Pick<RuntimeSpecs, 'desired'>
  transitions: Pick<ServerTransitions, 'command'>
}) {
  const { db, runtime, specs, transitions } = deps
  /** Each running server whose spec last matched what was applied, and from what, and when. */
  const matches = new Map<string, { inputs: string; at: number }>()

  /**
   * The drift digest a running server should be on, where it has drifted from what was applied;
   * null where it hasn't, or was never applied. What it should run is worked out again only once
   * something it is worked out from has moved, or an hour on: what moves without a request (a
   * deploy's image, a key) comes with a new process, which has matched nothing yet.
   */
  const driftedTo = async (
    server: MinecraftServer,
    binding: { handle: unknown; digest: string | null } | undefined,
  ): Promise<string | null> => {
    if (binding === undefined) throw new Error(`Server ${server.id} has no runtime binding`)
    if (binding.handle === null || binding.digest === null) return null
    const inputs = `${server.version}:${server.desiredRevisionId}:${server.activeWorldId}:${binding.digest}`
    const matched = matches.get(server.id)
    if (matched?.inputs === inputs && Date.now() - matched.at < HOUR_MS) return null
    const desired = await specs.desired(db, server)
    // Drift is a change to what a server runs, not to its owner's plan: that waits for a start.
    if (binding.digest === desired.driftDigest) {
      matches.set(server.id, { inputs, at: Date.now() })
      return null
    }
    matches.delete(server.id)
    return desired.driftDigest
  }

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
    const applied = await appliedDigests(
      db,
      running.map((s) => s.id),
      runtime.providers,
    )
    // Servers that stopped are forgotten.
    for (const id of matches.keys()) if (!applied.has(id)) matches.delete(id)
    let drifted = 0
    for (const server of running) {
      if (drifted >= limit) break
      if ((online.get(server.id)?.length ?? 0) > 0) continue
      const digest = await driftedTo(server, applied.get(server.id))
      if (digest === null || (await activeOperation(db, server.id)) !== null) continue
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked?.lifecycle.status !== 'running') return
        await transitions.command(
          tx,
          locked,
          { type: 'apply' },
          { requestedBy: 'system:reconcile', idempotencyKey: `drift:${digest}` },
        )
      })
      drifted++
    }
    return drifted
  }

  return drift
}
