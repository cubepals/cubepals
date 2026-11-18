// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { OperatorActor } from '../actor.ts'
import type { RealtimeTickets } from '../ports/tickets.ts'
import type { ConsoleFeed } from './feed.ts'

/** Where an operator's tools reach the realtime role, and the ticket that opens the one console. */
export interface OperatorWatchTicket {
  /** The WebSocket address, which every runtime that runs the operator CLI can open. */
  fallbackUrl: string
  ticket: string
}

/**
 * An operator watching a server's console live, through the realtime role as its owner would
 * (`ops.ts console --follow`), so a change to how consoles stream can be seen in production. Each
 * watch is in the audit log under the operator's name (`ConsoleFeed.operatorWatches`); its ticket
 * opens one session, for that one console, for a limited time (`interfaces/realtime/console-access.ts`).
 */
export class OperatorConsoleWatch {
  readonly #feed: Pick<ConsoleFeed, 'operatorWatches'>
  readonly #tickets: Pick<RealtimeTickets, 'issueForOperator'>
  readonly #realtime: { fallbackUrl: string }

  /** `realtime` is the web's own connect settings. */
  constructor(deps: {
    feed: Pick<ConsoleFeed, 'operatorWatches'>
    tickets: Pick<RealtimeTickets, 'issueForOperator'>
    realtime: { fallbackUrl: string }
  }) {
    this.#feed = deps.feed
    this.#tickets = deps.tickets
    this.#realtime = deps.realtime
  }

  async open(actor: OperatorActor, serverId: string): Promise<OperatorWatchTicket> {
    const id = await this.#feed.operatorWatches(actor, serverId)
    const ticket = await this.#tickets.issueForOperator({ operator: actor.name, serverId: id })
    return { fallbackUrl: this.#realtime.fallbackUrl, ticket }
  }
}
