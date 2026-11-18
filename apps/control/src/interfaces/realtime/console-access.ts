// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What one realtime session may watch, by who its ticket was for. A person signed in watches the
 * consoles their account may, within its share a minute, while the sign-in stands. An operator,
 * from the operators' tools (`ops.ts console --follow`), watches the one console its ticket names,
 * for OPERATOR_WATCH_MS. How a console is followed is `server.node.ts`'s; this answers only who.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import type { ConsoleFeed } from '../../app/console/feed.ts'
import type { OperatorHolder, TicketHolder } from '../../app/ports/tickets.ts'

/** How long an operator's session may watch its console: long enough to see a server boot. */
export const OPERATOR_WATCH_MS = 15 * MINUTE_MS

export interface ConsoleAccess {
  /** Whether the session may open one more console now; when not, the watch waits its turn. */
  mayOpen(): Promise<boolean>
  /** Why the session may watch nothing more, which closes it; null while it may. */
  ended(): Promise<string | null>
  /** Whether the session may watch this server's console, now and on each recheck. */
  mayWatch(serverId: string): Promise<boolean>
}

/** A person's: their account's share of consoles, their sign-in, and the servers they may watch. */
export function personAccess(feed: ConsoleFeed, holder: TicketHolder): ConsoleAccess {
  return {
    mayOpen: () => feed.mayOpen(holder.userId),
    ended: async () => ((await feed.stillSignedIn(holder)) ? null : 'signed out'),
    mayWatch: (serverId) => feed.canWatch(holder.userId, serverId),
  }
}

/**
 * An operator's: the one server its ticket names, until `forMs` after the session opened. The
 * operators' API that issued the ticket checked the token and wrote the audit log.
 */
export function operatorAccess(
  holder: OperatorHolder,
  options: { forMs?: number; now?: () => number } = {},
): ConsoleAccess {
  const now = options.now ?? Date.now
  const until = now() + (options.forMs ?? OPERATOR_WATCH_MS)
  return {
    mayOpen: async () => true,
    ended: async () => (now() >= until ? 'watch over' : null),
    mayWatch: async (serverId) => serverId === holder.serverId,
  }
}
