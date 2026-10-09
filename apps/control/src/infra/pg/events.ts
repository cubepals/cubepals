import type { Tx } from '@blockly/db'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import type { DomainEvent, EventBus } from '../../app/ports/events.ts'

const CHANNEL = 'blockly_events'

/**
 * Events over Postgres NOTIFY. Publishing inside the domain transaction means an event is
 * delivered only if the write committed. Listening holds one connection per process; a lost
 * connection is re-established, and anything missed meanwhile is recovered by clients
 * refetching, since events are hints.
 */
export class PgNotifyEventBus implements EventBus {
  readonly #connectionString: string
  readonly #handlers = new Set<(event: DomainEvent) => void>()
  #client: pg.Client | null = null
  #connecting: Promise<void> | null = null
  #closed = false

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
    const reconnect = () => {
      if (this.#client !== client) return
      this.#client = null
      if (!this.#closed && this.#handlers.size > 0)
        setTimeout(() => void this.#ensureListening().catch(() => reconnect()), 1_000)
    }
    client.on('error', reconnect)
    client.on('end', reconnect)
    await client.connect()
    await client.query(`LISTEN ${CHANNEL}`)
    this.#client = client
  }
}
