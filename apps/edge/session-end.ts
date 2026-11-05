// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a player's connection through the front door went, watched from the moment it is handed to
 * mc-router until it closes, so that a dropped player's join says which side went quiet: the
 * longest the player sent nothing and when that began (a client in the game sends something every
 * fraction of a second, and the server gives up on one quiet for 15 to 30 s), how long the player
 * had been quiet when it ended, the most that waited here to go out to the player (a path toward
 * them that can't keep up), and which side closed first and how. A stretch in which the front door
 * stopped reading from the player because the way on to the server was full is the server side's,
 * not the player's, and is counted apart. A join keeps it as `detail.session` (`visits.ts`).
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
  /**
   * Stretches with nothing from the player in which the front door had stopped reading them,
   * because the way on to the server was full: the longest, how many were 5 s or more, whether the
   * session ended in one, and the most that waited here to go on to the server. Not the player's.
   */
  longestHeldMs: number
  heldStalls: number
  heldAtEnd: boolean
  mostQueuedUp: number
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
  const quiet = new Stretches(began)
  let down = began
  let mostQueued = 0
  let mostQueuedUp = 0
  let first: Pick<SessionEnd, 'closedFirst' | 'how' | 'error'> | null = null
  const ended = (closedFirst: SessionEnd['closedFirst'], how: SessionEnd['how'], error?: string) => {
    first ??= error === undefined ? { closedFirst, how } : { closedFirst, how, error }
  }

  player.on('data', () => quiet.heard(clock.now(), player.isPaused()))
  // `pipe` pauses the player's side while the way on to the server is full; a pause with nothing
  // waiting to go on is a connection being taken down, which says nothing about either side.
  player.on('pause', () => {
    if (server.destroyed || server.writableLength === 0) return
    quiet.held()
    mostQueuedUp = Math.max(mostQueuedUp, server.writableLength)
  })
  // Reading again: what follows, until the player's next bytes, is their own silence.
  player.on('resume', () => quiet.resumed(clock.now()))
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
      const sum = quiet.at(at)
      return {
        longestQuietMs: Math.round(sum.longest.ms),
        longestQuietFrom: wallAt(sum.longest.from),
        stalls: sum.stalls,
        quietAtEndMs: Math.round(sum.quietMs),
        longestHeldMs: Math.round(sum.longestHeldMs),
        heldStalls: sum.heldStalls,
        heldAtEnd: sum.heldAtEnd,
        mostQueuedUp,
        downQuietAtEndMs: Math.round(at - down),
        mostQueuedDown: mostQueued,
        ...(first ?? { closedFirst: 'player', how: 'closed' }),
      }
    },
  }
}

/**
 * The stretches between bytes from the player: each is the player's own silence, or, where the
 * front door paused reading them in it, held by the way on to the server.
 */
class Stretches {
  #from: number
  #held = false
  #longest: { ms: number; from: number }
  #stalls = 0
  #longestHeld = 0
  #heldStalls = 0

  constructor(began: number) {
    this.#from = began
    this.#longest = { ms: 0, from: began }
  }

  /** The front door stopped reading the player: the stretch under way isn't theirs. */
  held(): void {
    this.#held = true
  }

  /** The front door reads the player again at `at`: a held stretch ends there, and their own begins. */
  resumed(at: number): void {
    if (!this.#held) return
    this.#close(at)
    this.#from = at
    this.#held = false
  }

  /** Bytes from the player at `at`: the stretch before them ends, and one begins. */
  heard(at: number, stillPaused: boolean): void {
    this.#close(at)
    this.#from = at
    this.#held = stillPaused
  }

  /** What the stretches add up to at `at`, the one under way counted as if it ended then. */
  at(at: number) {
    const ms = at - this.#from
    const held = this.#held
    const stall = ms >= STALL_MS ? 1 : 0
    return {
      longest: !held && ms > this.#longest.ms ? { ms, from: this.#from } : this.#longest,
      stalls: this.#stalls + (held ? 0 : stall),
      quietMs: ms,
      longestHeldMs: held ? Math.max(this.#longestHeld, ms) : this.#longestHeld,
      heldStalls: this.#heldStalls + (held ? stall : 0),
      heldAtEnd: held,
    }
  }

  #close(at: number): void {
    const ms = at - this.#from
    if (this.#held) {
      if (ms >= STALL_MS) this.#heldStalls++
      this.#longestHeld = Math.max(this.#longestHeld, ms)
      return
    }
    if (ms >= STALL_MS) this.#stalls++
    if (ms > this.#longest.ms) this.#longest = { ms, from: this.#from }
  }
}
