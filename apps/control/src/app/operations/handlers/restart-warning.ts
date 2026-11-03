// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The countdown players read in chat before a restart drops them: nobody playing is just sent away.
 * Asked of the game itself, so it speaks only to whoever is on, and best effort: a console that
 * doesn't answer delays nothing. It gives the same why as the word that turns them out
 * (`restart-notice.ts`), so a restart nobody changed anything for claims no change. Which operations
 * restart, and when, is theirs (`bringing-up.ts`, `updating.ts`).
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { SECOND_MS } from '@blockly/contracts/durations'
import { announce, LIST_UUIDS, parseOnlinePlayers } from '../../../minecraft/console.ts'
import type { ConsoleTarget, ServerConsole } from '../../ports/minecraft.ts'
import { RESTARTING_FOR_A_CHANGE } from './restart-notice.ts'

/** The seconds left at each line, first to last; the restart comes when the last runs out. */
export const COUNTDOWN = [10, 3] as const

/** What players read with so many seconds to go, before they are turned out with `why`. */
export function restartLine(seconds: number, why: string): string {
  if (seconds !== COUNTDOWN[0]) return `Restarting in ${seconds} seconds. See you in a minute.`
  const cause = why === RESTARTING_FOR_A_CHANGE ? ' for a change its owner made' : ''
  return `The server restarts in ${seconds} seconds${cause}. You can join again in about a minute.`
}

/**
 * Counts down to a restart for everyone on the server, then returns how many were warned: none
 * where nobody is on, or the game doesn't say who is. `why` is what turns them out after
 * (`restart-notice.ts`). `pause` waits that long; tests pass their own.
 */
export async function warnBeforeRestart(
  console: Pick<ServerConsole, 'run'>,
  target: ConsoleTarget,
  why: string,
  pause: (ms: number) => Promise<unknown> = sleep,
): Promise<number> {
  const listed = await console.run(target, LIST_UUIDS).then(parseOnlinePlayers, () => null)
  if (listed === null || listed.online === 0) return 0
  for (const [index, seconds] of COUNTDOWN.entries()) {
    await console.run(target, announce(restartLine(seconds, why))).catch(() => undefined)
    await pause((seconds - (COUNTDOWN[index + 1] ?? 0)) * SECOND_MS)
  }
  return listed.online
}
