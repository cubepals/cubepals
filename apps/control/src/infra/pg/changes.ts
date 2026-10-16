// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A change signal over Postgres LISTEN: one connection, held from the first time the mark is
 * asked for. What sends on its channel is the database's own triggers (the route inputs' are in
 * migration 0082). While the connection is down the mark is null, and once it is back the mark
 * moves, for whatever was said meanwhile. Not for domain events, which are `events.ts`'s.
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import pg from 'pg'
import type { ChangeSignal } from '../../app/ports/changes.ts'

/** The channel the route inputs' triggers send on. */
export const ROUTES_CHANNEL = 'blockly_routes'

/** How long after a lost connection it is opened again. */
const RECONNECT_MS = SECOND_MS

export class PgChangeSignal implements ChangeSignal {
  readonly #connectionString: string
  readonly #channel: string
  #client: pg.Client | null = null
  #connecting: Promise<void> | null = null
  #held = false
  #closed = false
  #mark = 0

  constructor(connectionString: string, channel: string) {
    this.#connectionString = connectionString
    this.#channel = channel
  }

  mark(): number | null {
    if (!this.#held && !this.#closed) this.#ensureListening()
    return this.#held ? this.#mark : null
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#held = false
    await this.#client?.end().catch(() => undefined)
  }

  #ensureListening(): void {
    this.#connecting ??= this.#listen().finally(() => {
      this.#connecting = null
    })
  }

  async #listen(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.#connectionString,
      application_name: 'blockly-changes',
    })
    client.on('notification', (message) => {
      if (message.channel === this.#channel) this.#mark++
    })
    client.on('error', () => this.#lost(client))
    client.on('end', () => this.#lost(client))
    this.#client = client
    try {
      await client.connect()
      await client.query(`LISTEN ${this.#channel}`)
    } catch {
      this.#lost(client)
      return
    }
    if (this.#closed || this.#client !== client) return
    // Whatever was said before now went unheard.
    this.#mark++
    this.#held = true
  }

  /** The connection is gone: nothing is heard until it is back, a moment later. */
  #lost(client: pg.Client): void {
    if (this.#client !== client) return
    this.#held = false
    this.#client = null
    client.removeAllListeners()
    // Whatever the closing connection still says goes nowhere.
    client.on('error', () => undefined)
    client.end().catch(() => undefined)
    if (!this.#closed) setTimeout(() => this.mark(), RECONNECT_MS).unref()
  }
}
