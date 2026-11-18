// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Restarts a running server that has stopped answering its console for minutes: a game hung on
 * its main thread, which the game's own watchdog no longer kills (`minecraft/watchdog.ts`). The
 * console's `list`, which the presence pass reads every minute (`presence.ts`), runs on that
 * thread, so a server whose game is stuck can't answer it, while its process, and often its
 * status ping, go on.
 *
 * A restart needs four things, so a slow network or a server still finding its feet never costs
 * anyone their game:
 *
 * - the console answered earlier in this run, as this process saw it: a run never heard has no
 *   answer to miss, and after a restart the server is heard again before it can be restarted again;
 * - nothing since, for `SILENT_MS`;
 * - the provider says it runs, on a host it can reach;
 * - the control plane reaches the rest: another server's console answered in the same pass, or
 *   this one's game port answers a status ping. Without either, the silence may be ours.
 *
 * Before the restart the JVM is asked for a thread dump (`SIGQUIT`), which lands in the server's
 * own log where the console and the crash explanations read it, as the watchdog's dump did. The
 * restart is the `restart` operation's, recorded as the system's (`system:silent`), and the log
 * says each one. Not for a server that stopped or crashed: the provider says so, and the
 * reconcile pass takes it from there.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import { PORT_NAMES } from '../../../minecraft/runtime-spec.ts'
import type { Actor } from '../../actor.ts'
import type { ReadinessProbe } from '../../ports/minecraft.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import type { MinecraftServerService } from '../../servers/service.ts'

/**
 * How long a console heard before may stay silent. The game's own watchdog gave a tick 60 s; this
 * is longer, since nothing is lost by waiting while a server works through something heavy, and
 * every reading that misses is a minute apart.
 */
export const SILENT_MS = 5 * MINUTE_MS

const SILENT: Actor = { kind: 'system', reason: 'silent' }

/** How long a status ping may take to say the control plane reaches the server. */
const PING_MS = 5_000

/** How long the thread dump's `kill` may take. */
const DUMP_SECONDS = 10

const warn = (what: string, serverId: string, error: unknown) =>
  console.warn(`silent: ${what}`, serverId, error instanceof Error ? error.message : error)

/** What one presence reading found of a running server's console. */
interface Reading {
  serverId: string
  handle: RuntimeHandle
  answered: boolean
}

export function silentRestarts(deps: {
  runtime: Pick<Runtimes, 'observe' | 'endpoint' | 'exec'>
  probe: Pick<ReadinessProbe, 'ping'>
  service: Pick<MinecraftServerService, 'restart'>
  /** `SILENT_MS` by default; tests shorten it. */
  silentMs?: number
}) {
  const { runtime, probe, service } = deps
  const silentMs = deps.silentMs ?? SILENT_MS
  /** When each running server's console last answered, in its present run. */
  const heardAt = new Map<string, number>()
  let readings: Reading[] = []
  /** Silences said to be unproven, by server and when it was last heard: each is said once. */
  const unproven = new Set<string>()

  /** One server's reading in the pass now going. */
  const note = (serverId: string, handle: RuntimeHandle, answered: boolean, at: Date) => {
    readings.push({ serverId, handle, answered })
    if (answered) heardAt.set(serverId, at.getTime())
  }

  /** Whether the server's game port answers a status ping. */
  const pings = async (handle: RuntimeHandle) => {
    const game = runtime.endpoint(handle, PORT_NAMES.game, 'control')
    return probe
      .ping(game, AbortSignal.timeout(PING_MS))
      .then(() => true)
      .catch(() => false)
  }

  /** Whether a silent server is to be restarted now, by the rules above. */
  const due = async (reading: Reading, others: boolean, now: number): Promise<boolean> => {
    const heard = heardAt.get(reading.serverId)
    if (heard === undefined || now - heard < silentMs) return false
    const seen = await runtime.observe(reading.handle).catch(() => null)
    if (seen?.state !== 'running' || seen.hostLost === true) return false
    if (others || (await pings(reading.handle))) return true
    const said = `${reading.serverId} ${heard}`
    if (!unproven.has(said))
      console.warn(
        `silent: ${reading.serverId} hasn't answered since ${new Date(heard).toISOString()}, but nothing shows we reach it`,
      )
    unproven.add(said)
    return false
  }

  /** Asks the JVM for a thread dump into the server's log, then restarts it. Whether it restarted. */
  const restart = async (reading: Reading, heard: number, at: Date): Promise<boolean> => {
    await runtime
      .exec(reading.handle, ['pkill', '-QUIT', '-x', 'java'], DUMP_SECONDS)
      .catch((error: unknown) => warn('thread dump', reading.serverId, error))
    try {
      await service.restart(SILENT, reading.serverId, `silent:${heard}`)
    } catch (error) {
      warn('restart', reading.serverId, error)
      return false
    }
    heardAt.delete(reading.serverId)
    const seconds = Math.round((at.getTime() - heard) / 1000)
    console.warn(`silent: restarted ${reading.serverId}, which hadn't answered its console for ${seconds} s`)
    return true
  }

  /** Forgets what is kept of servers that are no longer running. */
  const forget = (running: ReadonlySet<string>) => {
    for (const id of heardAt.keys()) if (!running.has(id)) heardAt.delete(id)
    for (const said of unproven) {
      const [id, heard] = said.split(' ')
      if (heardAt.get(id ?? '') !== Number(heard)) unproven.delete(said)
    }
  }

  /**
   * Ends the pass: forgets servers no longer running, and restarts each one silent past
   * `SILENT_MS`. How many it restarted.
   */
  const settle = async (at: Date): Promise<number> => {
    const pass = readings
    readings = []
    forget(new Set(pass.map((r) => r.serverId)))
    let restarted = 0
    for (const reading of pass.filter((r) => !r.answered)) {
      const others = pass.some((r) => r.answered && r.serverId !== reading.serverId)
      const heard = heardAt.get(reading.serverId)
      if (heard === undefined || !(await due(reading, others, at.getTime()))) continue
      if (await restart(reading, heard, at)) restarted++
    }
    return restarted
  }

  return { note, settle }
}

export type SilentRestarts = ReturnType<typeof silentRestarts>
