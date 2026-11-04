// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Applies a changed spec to running servers nobody is playing on, a few a pass, through the same
 * `apply` as any change, and the owner's changes that waited for everyone to leave which the spec's
 * digest doesn't see (`servers/waiting.ts`). What a server's spec should be is `servers/specs.ts`'s;
 * applying it is the `apply` operation's (`handlers/updating.ts`).
 */
import { HOUR_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { listByStatus, lockServer } from '../../servers/persistence.ts'
import { loadApplied } from '../../servers/restart-wait.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { presenceFor } from '../../servers/usage.ts'
import { ownersWaiting } from '../../servers/waiting.ts'
import { activeOperation } from '../persistence.ts'
import { appliedDigests } from './placements.ts'

/** A move drift makes on a running server: what names it, what `apply` is given, and what of the owner's it brings. */
interface Move {
  key: string
  input?: { revisionId: string; boot?: true }
  waiting?: string
}

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
   * The owner's waiting changes drift brought to each running server. A boot that left them
   * waiting, as one whose takeover of the owner's own Grim settings didn't take would, isn't tried
   * again every pass; the owner can still take them from the page. Forgotten once nothing waits.
   */
  const brought = new Map<string, string>()

  /**
   * What a running server should be moved to: the drift digest it should be on, where it has
   * drifted from what was applied, or else the owner's changes that wait for everyone to leave;
   * null where neither, or where it was never applied. What it should run is worked out again only
   * once something it is worked out from has moved, or an hour on: what moves without a request (a
   * deploy's image, a key) comes with a new process, which has matched nothing yet.
   */
  const moveFor = async (
    server: MinecraftServer,
    binding: { handle: unknown; digest: string | null } | undefined,
  ): Promise<Move | null> => {
    if (binding === undefined) throw new Error(`Server ${server.id} has no runtime binding`)
    if (binding.handle === null || binding.digest === null) return null
    const inputs = `${server.version}:${server.desiredRevisionId}:${server.activeWorldId}:${binding.digest}`
    const matched = matches.get(server.id)
    if (matched?.inputs === inputs && Date.now() - matched.at < HOUR_MS) return null
    const desired = await specs.desired(db, server)
    // Drift is a change to what a server runs, not to its owner's plan: that waits for a start.
    if (binding.digest !== desired.driftDigest) {
      matches.delete(server.id)
      // Named for the move, from what was applied to what it should run.
      return { key: `drift:${binding.digest}→${desired.driftDigest}` }
    }
    const move = await waitingMove(server)
    if (move === null) matches.set(server.id, { inputs, at: Date.now() })
    return move
  }

  /** The owner's changes that wait for everyone to leave beyond the digest, where drift hasn't brought them yet. */
  const waitingMove = async (server: MinecraftServer): Promise<Move | null> => {
    const waiting = await ownersWaiting(db, server, await loadApplied(db, server.id))
    if (waiting === null) {
      brought.delete(server.id)
      return null
    }
    const what = `${waiting.revisionId}:${waiting.stopCheaters ?? 'as-set'}`
    if (brought.get(server.id) === what) return null
    return {
      key: `waiting:${what}`,
      // Stop cheaters changes nothing the configuration says, so the server boots for it.
      input: { revisionId: waiting.revisionId, ...(waiting.stopCheaters === null ? {} : { boot: true }) },
      waiting: what,
    }
  }

  /** Starts a move where the server still runs, remembering what of the owner's it brings. */
  const make = async (server: MinecraftServer, move: Move): Promise<void> => {
    const moved = await db.transaction(async (tx) => {
      const locked = await lockServer(tx, server.id)
      if (locked?.lifecycle.status !== 'running') return false
      const input = move.input === undefined ? {} : { input: move.input }
      await transitions.command(
        tx,
        locked,
        { type: 'apply' },
        { requestedBy: 'system:reconcile', idempotencyKey: move.key, ...input },
      )
      return true
    })
    if (moved && move.waiting !== undefined) brought.set(server.id, move.waiting)
  }

  /** Servers that stopped are forgotten. */
  const forgetStopped = (running: ReadonlyMap<string, unknown>) => {
    for (const remembered of [matches, brought])
      for (const id of remembered.keys()) if (!running.has(id)) remembered.delete(id)
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
    forgetStopped(applied)
    let drifted = 0
    for (const server of running) {
      if (drifted >= limit) break
      if ((online.get(server.id)?.length ?? 0) > 0) continue
      const move = await moveFor(server, applied.get(server.id))
      if (move === null || (await activeOperation(db, server.id)) !== null) continue
      await make(server, move)
      drifted++
    }
    return drifted
  }

  return drift
}
