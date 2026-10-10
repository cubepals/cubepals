// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Warns a run in game as it nears its account's session cap, then stops it at the cap, the
 * ordinary way. Only an admin sets a cap; the month's run hours stay the real budget, and those are
 * the standing sweep's (`accounts/`). The stop itself is the `stop` operation's.
 */
import type { Db } from '@blockly/db'
import { type Entitlements, entitlementsFor } from '../../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { announce } from '../../../minecraft/console.ts'
import { PORT_NAMES } from '../../../minecraft/runtime-spec.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import type { Actor } from '../../actor.ts'
import type { EventBus } from '../../ports/events.ts'
import type { ConsoleTarget, ServerConsole } from '../../ports/minecraft.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { listByStatus, loadRuntime } from '../../servers/persistence.ts'
import type { MinecraftServerService } from '../../servers/service.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import { claimSessionWarning, openSession, releaseSessionWarning } from '../../servers/usage.ts'

/** Minutes left when a server on a capped plan is told its session is ending, in order. */
const SESSION_WARNINGS = [10, 2] as const

/** A session cap is the platform's own doing, not the owner's or an admin's. */
const SESSION_CAP: Actor = { kind: 'system', reason: 'session_cap' }

export function sessionCaps(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'endpoint'>
  console: ServerConsole
  specs: Pick<RuntimeSpecs, 'rconPasswords'>
  events: Pick<EventBus, 'publish'>
  service: Pick<MinecraftServerService, 'stop'>
}) {
  const { db, runtime, specs, events, service } = deps

  /**
   * `session-check`: a server whose account is held to a cap on how long one run may last (no plan
   * sets one; an admin can, on one account) is told in game 10 and 2 minutes before its session —
   * the run it is in now — reaches the cap, then stopped the ordinary way, which saves the world
   * first. Each warning goes out once, whatever
   * restarts in between, and one whose moment passed unseen is skipped rather than sent late. The
   * owner can start it again at once; the month's run hours stay the real budget.
   */
  const sessionCheck = async (now: Date): Promise<number> => {
    let stopped = 0
    for (const server of await listByStatus(db, 'running')) {
      const standing = await loadStanding(db, server.ownerId)
      const plan = entitlementsFor(standing.plan, standing.limitOverrides)
      if (plan.maxSessionMinutes === null) continue
      const session = await openSession(db, server.id)
      if (session === null) continue
      const minutesLeft = plan.maxSessionMinutes - (now.getTime() - session.startedAt.getTime()) / 60_000
      if (minutesLeft <= 0) {
        await endSession(server, plan.maxSessionMinutes, session.startedAt)
        stopped++
        continue
      }
      await warnSession(server, plan, session, minutesLeft)
    }
    return stopped
  }

  /** The cap is reached: the ordinary stop, which winds the server down and saves its world. */
  const endSession = async (server: MinecraftServer, cap: number, startedAt: Date): Promise<void> => {
    await service
      .stop(SESSION_CAP, server.id, `session:${startedAt.toISOString()}`, 'session_cap')
      .catch(() => undefined)
    await sessionEvent(server, cap, 0)
  }

  /** The last warning not yet sent whose moment has come, claimed before it is said. */
  const warnSession = async (
    server: MinecraftServer,
    plan: Entitlements,
    session: { startedAt: Date; warnedMinutes: number | null },
    minutesLeft: number,
  ): Promise<void> => {
    const due = SESSION_WARNINGS.filter((minutes) => minutesLeft <= minutes).at(-1)
    if (due === undefined) return
    if (session.warnedMinutes !== null && session.warnedMinutes <= due) return
    if (!(await claimSessionWarning(db, server.id, due))) return
    const { handle } = await loadRuntime(db, server.id, runtime.providers)
    if (handle === null) return
    const target = {
      endpoint: runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
      passwords: specs.rconPasswords(server.id),
    }
    const said = await tell(server, target, due)
    // Nothing was said, so nothing was warned: the next check says it, while there is still time.
    if (!said) await releaseSessionWarning(db, server.id, due, session.warnedMinutes)
    else await sessionEvent(server, plan.maxSessionMinutes ?? 0, due)
  }

  /**
   * Says the warning in game; whether it was said. Each one leaves a line with the server's answer,
   * "No player was found" when nobody was on to read it: players' clients keep no record, so
   * otherwise a warning nobody saw can't be told from one never sent.
   */
  const tell = async (server: MinecraftServer, target: ConsoleTarget, due: number): Promise<boolean> => {
    const answer = await deps.console
      .run(
        target,
        announce(`Server stops in ${due} minutes, saving the world first. You can join again right after.`),
      )
      .then((output) => ({ said: true, output: output.trim() }))
      .catch((error: unknown) => ({ said: false, output: String(error) }))
    const heard = answer.output ? ` (${answer.output})` : ''
    console.warn(
      `session-check: ${server.id} ${answer.said ? 'warned' : 'not warned'} at ${due} min left${heard}`,
    )
    return answer.said
  }

  const sessionEvent = async (
    server: MinecraftServer,
    minutes: number,
    minutesLeft: number,
  ): Promise<void> => {
    await db.transaction((tx) =>
      events.publish(tx, {
        type: 'session_cap',
        serverId: server.id,
        ownerId: server.ownerId,
        minutes,
        minutesLeft,
      }),
    )
  }

  return sessionCheck
}
