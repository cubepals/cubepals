// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server whose Java is recording its start, started again in place as it goes to sleep, so that
 * the recording is written and the startup cache made without a second boot. Java writes a
 * recording only as it exits, and a sleep keeps Java running: the sleep used to be a stop for once,
 * and a start nobody waited for then made the cache and put the server back to sleep
 * (`schedules/recorded-starts.ts`), two boots for every change of what it runs. Here the machine
 * stays up: the cache's script is asked to start again (`START_AGAIN`), Java is told to stop, saves
 * and writes the recording, and the script makes the cache and starts the server with it
 * (`minecraft/start-cache.ts`). The sleep then goes on as ever.
 *
 * It is done once the cache's state no longer says it records and the game answers again. One that
 * isn't done in time (`WITHIN_MS`), or a machine where nothing records, is left to the stop it used
 * to be, and the start that follows it.
 *
 * Not for whether a sleep starts again (`handlers/winding-down.ts`), nor for anything the server's
 * status or its players see: the sleep it is part of says stopping throughout, so a join waits for
 * it as for any sleep.
 */
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { CACHE_STATE, RECORDS, START_AGAIN } from '../../../minecraft/start-cache.ts'

/**
 * How long a start again has to be done. Measured on the image a server runs, one CPU, Paper 26.2
 * with the Via plugins and Floodgate from its class path: the game answered again 48.8 s after it was
 * told to stop, the cache made between. Several times that, for a slower host.
 */
const WITHIN_MS = 4 * MINUTE_MS
/** How often it looks again. */
const EVERY_MS = 3 * SECOND_MS

export interface AgainDeps {
  /** A command on the server's machine: its exit code and output, or null where it couldn't run. */
  exec(
    command: readonly string[],
    timeoutSeconds: number,
  ): Promise<{ exitCode: number; stdout: string } | null>
  /** Whether the game answers a ping now. */
  answers(): Promise<boolean>
  wait(ms: number): Promise<void>
  now(): number
}

/** How a recording run is started again in place: `startedAgain`, or what a test holds in its place. */
export type StartAgain = (deps: AgainDeps) => Promise<boolean>

/** Whether the server started again in place and answers, its cache made from the run before. */
export async function startedAgain(deps: AgainDeps, within = WITHIN_MS): Promise<boolean> {
  const asked = await deps.exec(START_AGAIN, 30)
  if (asked?.exitCode !== 0) return false
  const until = deps.now() + within
  while (deps.now() < until) {
    await deps.wait(EVERY_MS)
    const state = await deps.exec(['sed', '-n', '2p', CACHE_STATE], 30)
    if (state?.exitCode === 0 && state.stdout.trim() !== RECORDS && (await deps.answers())) return true
  }
  return false
}
