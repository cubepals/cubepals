// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operator's notice on an account: one line, which every server the account owns shows in the
 * server list in place of its own message and says in its chat, and, where it names a time, the
 * limit it puts on the account then; and when a server's players hear it again. What it may say
 * is what a server's own message may (`revision.ts` `messageProblem`): it takes that message's place.
 *
 * Not for keeping it or applying its limit (`app/accounts/notice.ts`), or for saying it on a server
 * (`app/operations/schedules/notice-said.ts`).
 */
import { MINUTE_MS } from '@blockly/contracts/durations'

export interface AccountNotice {
  /** As the operator wrote it, with `&` or `§` formatting codes. */
  text: string
  setAt: Date
  /** Who set it, as the audit log names them (`operator:<name>`). */
  setBy: string
  /** When it limits the account; null for a notice that only tells. */
  limitAt: Date | null
  /** When that limit was put on the account; null until it was. */
  limitedAt: Date | null
}

/** How long the players on a server go before they hear the notice again. */
export const SAY_AGAIN_MS = 10 * MINUTE_MS

/** Who was on at a server's last reading, and when its players last heard the notice. */
export interface LastSaid {
  players: readonly string[]
  saidAt: Date | null
}

/**
 * Whether the players on now (`players`, by uuid) are told the notice: someone who wasn't on at the
 * last reading is, and everyone is again once `SAY_AGAIN_MS` has passed. Nobody on hears nothing.
 */
export function dueToSay(last: LastSaid | null, players: readonly string[], now: Date): boolean {
  if (players.length === 0) return false
  if (last === null || last.saidAt === null) return true
  const before = new Set(last.players)
  if (players.some((uuid) => !before.has(uuid))) return true
  return now.getTime() - last.saidAt.getTime() >= SAY_AGAIN_MS
}
