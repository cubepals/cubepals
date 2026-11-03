// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The countdown players read in chat before a restart drops them: nobody playing is just sent away.
 * Asked of the game itself, so it speaks only to whoever is on, and best effort: asking who is on
 * waits at most `NOTICE_WAIT_MS`, as the word that turns them out does, and no line is waited for,
 * so a console that doesn't answer never holds the restart past when the countdown says. It gives
 * that word's why too (`restart-notice.ts`), so a restart nobody changed anything for claims no
 * change. Which operations restart, and when, is theirs (`bringing-up.ts`, `updating.ts`).
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { SECOND_MS } from '@blockly/contracts/durations'
import { announce, LIST_UUIDS, parseOnlinePlayers } from '../../../minecraft/console.ts'
import type { ConsoleTarget, ServerConsole } from '../../ports/minecraft.ts'
import { NOTICE_WAIT_MS, RESTARTING_FOR_A_CHANGE } from './restart-notice.ts'

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
 * where nobody is on, or the game doesn't say who is within `waitMs`. `why` is what turns them out
 * after (`restart-notice.ts`). `pause` waits that long; tests pass their own.
 */
export async function warnBeforeRestart(
  console: Pick<ServerConsole, 'run'>,
  target: ConsoleTarget,
  why: string,
  pause: (ms: number) => Promise<unknown> = sleep,
  waitMs = NOTICE_WAIT_MS,
): Promise<number> {
  const listed = await within(
    waitMs,
    console.run(target, LIST_UUIDS).then(parseOnlinePlayers, () => null),
  )
  if (listed === null || listed.online === 0) return 0
  for (const [index, seconds] of COUNTDOWN.entries()) {
    // Sent as its wait begins and never waited for: a line stuck in the console can't push the
    // restart back.
    void console.run(target, announce(restartLine(seconds, why))).catch(() => undefined)
    await pause((seconds - (COUNTDOWN[index + 1] ?? 0)) * SECOND_MS)
  }
  return listed.online
}

/** What `answer` gives, or `null` where it gives nothing in `ms`. */
async function within<T>(ms: number, answer: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, ms, null)
  })
  try {
    return await Promise.race([answer, late])
  } finally {
    clearTimeout(timer)
  }
}
