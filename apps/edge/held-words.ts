// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a held join hears while its server wakes. It starts as the login hold (`hold.ts`): a login
 * query every 10 s, which a resume, up in about 2 s, never notices. A wake still going after a few
 * seconds is a boot, 35 s or more, so a client that can take a dialog (`dialog-hold.ts`) has its
 * login finished by the edge, and is told "Waking your world · about N seconds" as it counts down,
 * with a keep-alive between; every other client goes on with the queries.
 *
 * Not for asking for the wake, or for what happens once it is over: the caller lets the join in,
 * by passing it on (the login hold) or by a transfer (the dialog), or turns it away, each in the
 * words its state takes.
 */

import type { Socket } from 'node:net'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { DialogHold, dialogFor, loginStartOf } from './dialog-hold.ts'
import { type Held, LOGIN_QUERIES } from './hold.ts'
import type { HoldPackets } from './hold-packet-ids.ts'
import type { Join } from './notice.ts'

/**
 * How often the login hold asks, well inside the 30 s a client waits on a silent server; how long
 * it goes on before a dialog, past a resume and well before a client gives up; how often the
 * dialog's line is looked at, so its count goes down with the clock; and how often a configuring
 * client hears a keep-alive while its line stays the same.
 */
export const HOLD_TIMES = {
  queryEveryMs: 10 * SECOND_MS,
  dialogAfterMs: 4 * SECOND_MS,
  lookEveryMs: SECOND_MS,
  keepAliveEveryMs: 10 * SECOND_MS,
}

export interface Words<R> {
  client: Socket
  join: Join
  /** The login hold, which has every byte the client sent until the dialog takes over. */
  held: Held
  /** The wait itself: over when the server is up, the join is refused, or the hold gives up. */
  wait: Promise<R>
  /** The dialog's title: the server's name. */
  title: string
  /** The waking line as it stands now (`waking-line.ts`). */
  line: () => string
  /** What to do with a client that, configuring, sends far more than a waiting client does. */
  misbehaved: () => void
  /** For tests: a shorter hold. */
  times?: typeof HOLD_TIMES
}

/**
 * Speaks to the held client until `wait` is over; what it ended with, and the dialog where the
 * client was moved to one, which then has the client, configuring or about to.
 */
export async function speakWhile<R>(words: Words<R>): Promise<{ result: R; dialog: DialogHold | null }> {
  const { client, join, held } = words
  const times = words.times ?? HOLD_TIMES
  const ids = dialogFor(join)
  let dialog: DialogHold | null = null
  let looking: ReturnType<typeof setInterval> | undefined
  // A client from before 1.13 can't be spoken to while it waits: the caller waits only as long as it would.
  const queries =
    join.protocol >= LOGIN_QUERIES
      ? setInterval(() => client.write(held.ask()), times.queryEveryMs)
      : undefined

  const moveToDialog = (ids: HoldPackets) => {
    const start = loginStartOf(held.replay())
    if (start === null || held.refused || client.destroyed) return
    const moved = new DialogHold(ids)
    dialog = moved
    clearInterval(queries)
    client.removeAllListeners('data')
    client.on('data', (chunk: Buffer) => moved.receive(chunk) || words.misbehaved())
    client.write(moved.finishLogin(start))
    let shown: string | null = null
    let keptAt = Date.now()
    looking = setInterval(() => {
      if (!moved.configuring || client.destroyed) return
      const line = words.line()
      if (line !== shown) client.write(moved.dialog(words.title, line))
      else if (Date.now() - keptAt >= times.keepAliveEveryMs) client.write(moved.keepAlive())
      else return
      shown = line
      keptAt = Date.now()
    }, times.lookEveryMs)
  }
  const switching = ids === null ? undefined : setTimeout(() => moveToDialog(ids), times.dialogAfterMs)

  try {
    return { result: await words.wait, dialog }
  } finally {
    clearInterval(queries)
    clearTimeout(switching)
    clearInterval(looking)
  }
}
