// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a player is told of a server resting because its owner's free trial's hours are all played.
 * Usually the player is a friend of the owner's, so it says whose server it is and that nothing is
 * wrong with them. It names no time: nothing brings the server back by itself.
 *
 * Not for deciding whether a server rests (the control plane's), or for other refusals (`agent.ts`).
 */

import { MOTD_CODE } from '../../packages/contracts/src/server-list.ts'
import { asleepMessage, width } from './asleep.ts'

/**
 * How wide a line of a refused join may be before the game wraps it: its disconnect screen draws
 * the reason at the screen's width less 50 (DisconnectedScreen.init, in the Java Edition client),
 * and the game never scales its screen below 320 wide (Window.calculateScale).
 */
export const REFUSAL_WIDTH = 320 - 50

/** The server's name in quotes where it fits on one line with `rest`; "This server" where not. */
function named(name: string | undefined, rest: string): string {
  // A name is the owner's words, never formatting: any codes in it are left out.
  const plain = name?.replace(MOTD_CODE, '').replace(/[§\n]/g, '').trim()
  const line = `“${plain}” ${rest}`
  return plain && width(line) <= REFUSAL_WIDTH ? line : `This server ${rest}`
}

/** What a join is told: whose server it is, why it rests, and that they'll know. */
export function restingJoin(name: string | undefined): string {
  return [
    named(name, 'is resting for now'),
    'Its owner’s free trial is used up.',
    'They’ll see on Cubepals that you came by.',
  ].join('\n')
}

/** What the server list shows: the server's own message, if any, then that it rests. */
export function restingStatus(motd: string | undefined): string {
  return asleepMessage(motd, 'Resting for now')
}
