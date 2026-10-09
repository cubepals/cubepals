import type { Tx } from '@blockly/db'

/**
 * Events are hints for realtime clients and waiters, never the source of truth. Publishing takes
 * the domain transaction, so an event exists only if the write it describes committed. They carry
 * ids, statuses and counts only, so every one fits Postgres's 8 kB NOTIFY payload by construction
 * (§13): whoever needs more reads it.
 */
export type DomainEvent =
  | { type: 'server_changed'; serverId: string; ownerId: string; status: string; version: number }
  | {
      type: 'operation_progress'
      serverId: string
      ownerId: string
      operationId: string
      kind: string
      step: string | null
      status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    }
  | { type: 'access_changed'; serverId: string; ownerId: string; version: number }
  /** A backup was taken, restored from, deleted or expired. */
  | { type: 'backup_changed'; serverId: string; ownerId: string }
  /** A listing's eligibility, moderation or owner intent changed. */
  | { type: 'listing_changed'; serverId: string; ownerId: string }
  /** Who is on is read from presence by whoever forwards it; a list could outgrow NOTIFY. */
  | { type: 'presence'; serverId: string; ownerId: string; online: number }
  /**
   * A plan's session cap: the server was warned with `minutesLeft` to go, or stopped (0). The
   * page it reaches says what is about to happen, or what happened.
   */
  | { type: 'session_cap'; serverId: string; ownerId: string; minutes: number; minutesLeft: number }

export interface EventBus {
  publish(tx: Tx, event: DomainEvent): Promise<void>
  /** Resolves once listening; the returned function stops it. */
  subscribe(handler: (event: DomainEvent) => void): Promise<() => Promise<void>>
}
