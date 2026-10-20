// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One join the waiting room held, written as one line of the edge's log when it ends: when it
 * connected, when the wake was asked for, when the server was up, when the login went on to it,
 * and when the player left, with how it ended and what passed each way. The server's own log
 * says the rest by the same name: "UUID of player" as the login reaches it, "joined the game" once
 * the player is in the world.
 *
 * Not for anything but reading: nothing decides on it.
 */

/** A step of a held join, in the order they come. */
export type Step = 'connected' | 'wakeAsked' | 'up' | 'forwarded' | 'left'

/** What a held join's line says. */
export interface JoinRecord {
  hostname: string
  name: string | null
  /** When each step came, as ISO time; a step never reached is left out. */
  at: Partial<Record<Step, string>>
  /** How it ended: let in, turned away for a reason, or gone before either. */
  outcome: string
  /** Bytes from the player to the server, and back. */
  bytes: { fromPlayer: number; toPlayer: number }
}

export class JoinTrace {
  readonly #hostname: string
  readonly #now: () => Date
  readonly #at: Partial<Record<Step, string>> = {}
  #name: string | null = null
  #outcome = 'left while held'

  constructor(hostname: string, now: () => Date = () => new Date()) {
    this.#hostname = hostname
    this.#now = now
    this.mark('connected')
  }

  /** The step came now; a step that came already keeps its first time. */
  mark(step: Step): void {
    this.#at[step] ??= this.#now().toISOString()
  }

  named(name: string | undefined): void {
    this.#name = name ?? null
  }

  ended(outcome: string): void {
    this.#outcome = outcome
  }

  /** The line, once the player has left. */
  record(bytes: JoinRecord['bytes']): JoinRecord {
    this.mark('left')
    return { hostname: this.#hostname, name: this.#name, at: { ...this.#at }, outcome: this.#outcome, bytes }
  }
}
