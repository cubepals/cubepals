// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a player is told of a server resting because its owner's play is used up: for today, until
 * the owner's next day begins, or for now, once the free trial's hours are all played. Usually
 * the player is a friend of the owner's, so it says whose server it is and that nothing is wrong
 * with them, and never names a time of day: the owner's midnight is not the friend's, and the
 * game can't say a time in the friend's own. It says how long instead.
 *
 * Not for deciding whether a server rests (the control plane's), or for other refusals (`agent.ts`).
 */

// Copied into the image beside the agent (Dockerfile): the one place play coming back is worded.
import { waitFor } from '../../packages/contracts/src/play-today.ts'
import { MOTD_CODE } from '../../packages/contracts/src/server-list.ts'
import { asleepMessage, width } from './asleep.ts'

/**
 * How wide a line of a refused join may be before the game wraps it: its disconnect screen draws
 * the reason at the screen's width less 50 (DisconnectedScreen.init, in the Java Edition client),
 * and the game never scales its screen below 320 wide (Window.calculateScale).
 */
export const REFUSAL_WIDTH = 320 - 50

/** Why a server rests: its owner's play for today, or their free trial's hours, are used up. */
export type Resting = { for: 'today'; backAt: Date } | { for: 'trial' }

/** The server's name in quotes where it fits on one line with `rest`; "This server" where not. */
function named(name: string | undefined, rest: string): string {
  // A name is the owner's words, never formatting: any codes in it are left out.
  const plain = name?.replace(MOTD_CODE, '').replace(/[§\n]/g, '').trim()
  const line = `“${plain}” ${rest}`
  return plain && width(line) <= REFUSAL_WIDTH ? line : `This server ${rest}`
}

/** What a join is told: whose server it is, why it rests, when it is back, and that they'll know. */
export function restingJoin(resting: Resting, name: string | undefined, now: Date): string {
  const lines =
    resting.for === 'today'
      ? [
          named(name, 'is resting for today'),
          'Its owner’s play for today is used up.',
          `It’s back in ${waitFor(now, resting.backAt)}.`,
        ]
      : [named(name, 'is resting for now'), 'Its owner’s free trial is used up.']
  return [...lines, 'They’ll see on Cubepals that you came by.'].join('\n')
}

/** What the server list shows: the server's own message, if any, then that it rests. */
export function restingStatus(resting: Resting, motd: string | undefined, now: Date): string {
  const notice =
    resting.for === 'today'
      ? `Resting for today · back in ${waitFor(now, resting.backAt)}`
      : 'Resting for now'
  return asleepMessage(motd, notice)
}
