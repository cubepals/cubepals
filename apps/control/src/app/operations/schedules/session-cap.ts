// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Warns a run in game as it nears its end, then stops it there, the ordinary way. A run ends where
 * its plan's play in all runs out (Free's 20 hours, `accounts/play-total.ts`), or at a cap on one
 * run, which only an admin sets; the earliest. The end of the 20 stops it until the account has a
 * paid plan. The month's hours are the standing sweep's (`accounts/`), and the stop itself is the
 * `stop` operation's.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import { type Entitlements, entitlementsOf, planName } from '../../../domain/account/entitlements.ts'
import { METER_UNITS } from '../../../domain/account/meter.ts'
import { planOnSaleHere } from '../../../domain/account/on-sale.ts'
import type { AccountStanding } from '../../../domain/account/standing.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { announce } from '../../../minecraft/console.ts'
import { PORT_NAMES } from '../../../minecraft/runtime-spec.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import { type PlayTotal, playTotal } from '../../accounts/play-total.ts'
import type { Actor } from '../../actor.ts'
import { playEnded } from '../../insight/record.ts'
import type { EventBus } from '../../ports/events.ts'
import type { ConsoleTarget, ServerConsole } from '../../ports/minecraft.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { listByStatus, loadRuntime } from '../../servers/persistence.ts'
import type { MinecraftServerService } from '../../servers/service.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import {
  claimSessionWarning,
  fixPlayEnd,
  openSession,
  presenceFor,
  releasePlayEnd,
  releaseSessionWarning,
} from '../../servers/usage.ts'

/** Minutes left when a server is told its session is ending, in order. */
const SESSION_WARNINGS = [10, 2] as const

/** A session's end is the platform's own doing, not the owner's or an admin's. */
const ENDED_BY: Record<SessionEnd['reason'], Actor> = {
  session_cap: { kind: 'system', reason: 'session_cap' },
  free_hours: { kind: 'system', reason: 'play_total' },
}

/** What the players on a server are told, by why its session ends. */
const WARNING: Record<SessionEnd['reason'], (minutes: number) => string> = {
  session_cap: (minutes) =>
    `Server stops in ${minutes} minutes, saving the world first. You can join again right after.`,
  free_hours: (minutes) =>
    (() => {
      const paid = planOnSaleHere()
      return `The free trial ends in ${minutes} minutes. The world is saved and kept${paid === null ? '' : `, and ${planName(paid)} starts it again`}.`
    })(),
}

/** What a stop for each end is keyed by, with the session's start: one stop each. */
const KEYED: Record<SessionEnd['reason'], string> = {
  session_cap: 'session',
  free_hours: 'total',
}

/** When the session a server is in ends, and why; `minutes` is the cap, or the play it ends. */
interface SessionEnd {
  at: Date
  reason: 'session_cap' | 'free_hours'
  minutes: number
}

/**
 * Minutes of the plan's play in all left at `rate` units an hour, with how long that play is
 * (`minutes`). Null on a plan that counts none.
 */
function playLeft(
  total: PlayTotal | null,
  rate: number,
): { left: number; reason: 'free_hours'; minutes: number } | null {
  if (total === null) return null
  return { left: (total.left / rate) * 60, reason: 'free_hours', minutes: total.included * 60 }
}

type Session = { startedAt: Date; warnedMinutes: number | null; playEndsAt: Date | null }

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
   * `session-check`: a server whose session ends (its plan's play in all runs out, or an admin
   * capped how long one run lasts) is told in game 10 and 2 minutes before, then stopped the
   * ordinary way, which saves the world first. Each warning goes out once, whatever restarts in
   * between, and one whose moment passed unseen is skipped rather than sent late. After a cap the
   * owner can start it again at once; after the play in all, with a paid plan.
   */
  const sessionCheck = async (now: Date): Promise<number> => {
    let stopped = 0
    const running = await listByStatus(db, 'running')
    for (const server of running) {
      const standing = await loadStanding(db, server.ownerId)
      const plan = entitlementsOf(standing)
      if (plan.maxSessionMinutes === null && plan.totalUnits === null) continue
      const session = await openSession(db, server.id)
      if (session === null) continue
      // The owner's servers running together spend the plan's play together.
      const rate = running
        .filter((s) => s.ownerId === server.ownerId)
        .reduce((sum, s) => sum + METER_UNITS[s.memoryTier], 0)
      const ends = [capEnd(plan, session), await playEnd(server, standing, plan, session, rate, now)]
      const end = ends.filter((e) => e !== null).sort((a, b) => a.at.getTime() - b.at.getTime())[0]
      if (end === undefined) continue
      const minutesLeft = (end.at.getTime() - now.getTime()) / MINUTE_MS
      if (minutesLeft <= 0) {
        await endSession(server, end, session.startedAt)
        stopped++
        continue
      }
      await warnSession(server, end, session, minutesLeft)
    }
    return stopped
  }

  const capEnd = (plan: Entitlements, session: Session): SessionEnd | null =>
    plan.maxSessionMinutes === null
      ? null
      : {
          at: new Date(session.startedAt.getTime() + plan.maxSessionMinutes * MINUTE_MS),
          reason: 'session_cap',
          minutes: plan.maxSessionMinutes,
        }

  /**
   * Where the plan's play in all (Free's 20 hours) runs out for this session. Once its first
   * warning is due, the end is fixed on the session, and never sooner than that warning's minutes
   * away: a run already past its play when it began being counted (as on the day Free changed) is
   * warned like any other, never cut off. An end fixed while play was nearly out holds only while
   * it still is: once more is left than the first warning's minutes (the plan changed, or how it
   * counts did), the end and its warnings are let go, and the run goes on to its new end.
   */
  const playEnd = async (
    server: MinecraftServer,
    standing: AccountStanding,
    plan: Entitlements,
    session: Session,
    rate: number,
    now: Date,
  ): Promise<SessionEnd | null> => {
    const play = playLeft(await playTotal(db, standing, plan, now), rate)
    if (play === null) return null
    const { left, reason, minutes } = play
    const first = SESSION_WARNINGS[0]
    if (session.playEndsAt !== null && left > first) await releasePlayEnd(db, server.id)
    else if (session.playEndsAt !== null) return { at: session.playEndsAt, reason, minutes }
    if (left > first) return { at: new Date(now.getTime() + left * MINUTE_MS), reason, minutes }
    const at = await fixPlayEnd(db, server.id, new Date(now.getTime() + Math.max(left, first) * MINUTE_MS))
    return at === null ? null : { at, reason, minutes }
  }

  /**
   * The end is reached: the ordinary stop, which winds the server down and saves its world. One
   * that ends the owner's play with someone still on is counted, once a session, with how many.
   */
  const endSession = async (server: MinecraftServer, end: SessionEnd, startedAt: Date): Promise<void> => {
    const key = `${KEYED[end.reason]}:${startedAt.toISOString()}`
    const online = (await presenceFor(db, [server.id])).get(server.id)?.length ?? 0
    await service.stop(ENDED_BY[end.reason], server.id, key, end.reason).catch(() => undefined)
    if (end.reason !== 'session_cap' && online > 0) await playEnded(db, server, end.reason, key, online)
    await sessionEvent(server, end.minutes, 0)
  }

  /** The last warning not yet sent whose moment has come, claimed before it is said. */
  const warnSession = async (
    server: MinecraftServer,
    end: SessionEnd,
    session: Session,
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
    const said = await tell(server, target, WARNING[end.reason](due), due)
    // Nothing was said, so nothing was warned: the next check says it, while there is still time.
    if (!said) await releaseSessionWarning(db, server.id, due, session.warnedMinutes)
    else await sessionEvent(server, end.minutes, due)
  }

  /**
   * Says the warning in game; whether it was said. Each one leaves a line with the server's answer,
   * "No player was found" when nobody was on to read it: players' clients keep no record, so
   * otherwise a warning nobody saw can't be told from one never sent.
   */
  const tell = async (
    server: MinecraftServer,
    target: ConsoleTarget,
    words: string,
    due: number,
  ): Promise<boolean> => {
    const answer = await deps.console
      .run(target, announce(words))
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
