// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a player's connection through the front door went, watched from the moment it is handed to
 * mc-router until it closes, so that a dropped player's join says which side went quiet: the
 * longest the player sent nothing and when that began (a client in the game sends something every
 * fraction of a second, and the server gives up on one quiet for 15 to 30 s), how long the player
 * had been quiet when it ended, the most that waited here to go out to the player (a path toward
 * them that can't keep up), and which side closed first and how. A join keeps it as
 * `detail.session` (`visits.ts`).
 *
 * Not for deciding anything about a connection: `pipe` in `front.ts` relays it, and closes it.
 */
import type { Socket } from 'node:net'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'

/** A silence from a player in the game this long is a stall: their client sends at least once a second. */
const STALL_MS = 5 * SECOND_MS

export interface SessionEnd {
  /** The longest the player's side sent nothing, in milliseconds, and when that silence began. */
  longestQuietMs: number
  longestQuietFrom: string
  /** How many times the player's side was quiet for 5 s or more, the one it ended in included. */
  stalls: number
  /** How long the player's side had sent nothing when the connection closed. */
  quietAtEndMs: number
  /** How long since anything was passed on toward the player when it closed. */
  downQuietAtEndMs: number
  /** The most bytes waiting here, at once, to be written to the player. */
  mostQueuedDown: number
  /** Which side closed first: the player's connection or the server's, through mc-router. */
  closedFirst: 'player' | 'server'
  /** How that side closed: an error (`reset`, with its code), quiet both ways (`timeout`), or `closed`. */
  how: 'reset' | 'timeout' | 'closed'
  error?: string
}

/** What a session ends as, once its connection closes. */
export interface SessionWatch {
  end(): SessionEnd
}

/**
 * Watches `player`, the front door's connection from the player, and `server`, its connection on
 * to mc-router, from now: `end()` says how it went, called once the player's side has closed.
 */
export function watchSession(
  player: Socket,
  server: Socket,
  clock: { now: () => number; wall: () => number } = { now: () => performance.now(), wall: Date.now },
): SessionWatch {
  const began = clock.now()
  const wallAt = (at: number) => new Date(clock.wall() - (clock.now() - at)).toISOString()
  let up = began
  let down = began
  let longest = { ms: 0, from: began }
  let stalls = 0
  let mostQueued = 0
  let first: Pick<SessionEnd, 'closedFirst' | 'how' | 'error'> | null = null
  const ended = (closedFirst: SessionEnd['closedFirst'], how: SessionEnd['how'], error?: string) => {
    first ??= error === undefined ? { closedFirst, how } : { closedFirst, how, error }
  }

  player.on('data', () => {
    const at = clock.now()
    if (at - up >= STALL_MS) stalls++
    if (at - up > longest.ms) longest = { ms: at - up, from: up }
    up = at
  })
  server.on('data', () => {
    down = clock.now()
    mostQueued = Math.max(mostQueued, player.writableLength)
  })
  for (const [socket, side] of [
    [player, 'player'],
    [server, 'server'],
  ] as const) {
    socket.once('error', (error: NodeJS.ErrnoException) => ended(side, 'reset', error.code ?? error.message))
    socket.once('timeout', () => ended(side, 'timeout'))
    socket.once('end', () => ended(side, 'closed'))
    socket.once('close', () => ended(side, 'closed'))
  }

  return {
    end() {
      const at = clock.now()
      const quiet = at - up
      const still = quiet > longest.ms ? { ms: quiet, from: up } : longest
      return {
        longestQuietMs: Math.round(still.ms),
        longestQuietFrom: wallAt(still.from),
        stalls: stalls + (quiet >= STALL_MS ? 1 : 0),
        quietAtEndMs: Math.round(quiet),
        downQuietAtEndMs: Math.round(at - down),
        mostQueuedDown: mostQueued,
        ...(first ?? { closedFirst: 'player', how: 'closed' }),
      }
    },
  }
}
