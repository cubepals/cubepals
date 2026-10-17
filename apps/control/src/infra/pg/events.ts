// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { SECOND_MS } from '@blockly/contracts/durations'
import type { Tx } from '@blockly/db'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import type { DomainEvent, EventBus } from '../../app/ports/events.ts'

const CHANNEL = 'blockly_events'

/** How long after a lost connection it is first opened again; each failed try doubles it. */
const RETRY_FIRST_MS = SECOND_MS
/** The longest wait between tries while Postgres stays away. */
const RETRY_MOST_MS = 30 * SECOND_MS

/**
 * Events over Postgres NOTIFY. Publishing inside the domain transaction means an event is
 * delivered only if the write committed. Listening holds one connection per process; a lost
 * connection is opened again, trying for as long as Postgres stays away, and anything missed
 * meanwhile is recovered by clients refetching, since events are hints.
 */
export class PgNotifyEventBus implements EventBus {
  readonly #connectionString: string
  readonly #handlers = new Set<(event: DomainEvent) => void>()
  #client: pg.Client | null = null
  #connecting: Promise<void> | null = null
  #closed = false
  #retryMs = RETRY_FIRST_MS

  constructor(connectionString: string) {
    this.#connectionString = connectionString
  }

  async publish(tx: Tx, event: DomainEvent): Promise<void> {
    await tx.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify(event)})`)
  }

  async subscribe(handler: (event: DomainEvent) => void): Promise<() => Promise<void>> {
    this.#handlers.add(handler)
    await this.#ensureListening()
    return async () => {
      this.#handlers.delete(handler)
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    await this.#client?.end().catch(() => undefined)
  }

  #ensureListening(): Promise<void> {
    if (this.#client !== null) return Promise.resolve()
    this.#connecting ??= this.#listen().finally(() => {
      this.#connecting = null
    })
    return this.#connecting
  }

  async #listen(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.#connectionString,
      application_name: 'blockly-events',
    })
    client.on('notification', (message) => {
      if (message.channel !== CHANNEL || !message.payload) return
      let event: DomainEvent
      try {
        event = JSON.parse(message.payload) as DomainEvent
      } catch {
        return
      }
      for (const handler of this.#handlers) handler(event)
    })
    client.on('error', () => this.#lost(client))
    client.on('end', () => this.#lost(client))
    try {
      await client.connect()
      await client.query(`LISTEN ${CHANNEL}`)
    } catch (error) {
      client.end().catch(() => undefined)
      throw error
    }
    if (this.#closed) {
      await client.end().catch(() => undefined)
      return
    }
    this.#client = client
  }

  /** The connection is gone: nothing is heard until it is back. */
  #lost(client: pg.Client): void {
    if (this.#client !== client) return
    this.#client = null
    client.removeAllListeners()
    // Whatever the closing connection still says goes nowhere.
    client.on('error', () => undefined)
    client.end().catch(() => undefined)
    if (this.#closed) return
    console.error('events: the connection to Postgres is lost; trying again until it is back')
    this.#retry()
  }

  #retry(): void {
    if (this.#closed || this.#handlers.size === 0) return
    const wait = this.#retryMs
    this.#retryMs = Math.min(wait * 2, RETRY_MOST_MS)
    setTimeout(() => {
      this.#ensureListening().then(
        () => {
          if (this.#client === null) return
          this.#retryMs = RETRY_FIRST_MS
          console.warn('events: listening again')
        },
        () => this.#retry(),
      )
    }, wait).unref()
  }
}
