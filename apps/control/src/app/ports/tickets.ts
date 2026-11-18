// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Who a realtime ticket was issued to: the account, and the sign-in session that asked for it. */
export interface TicketHolder {
  userId: string
  sessionId: string
}

/**
 * An operator watching one server's console from the operators' tools (`ops.ts console --follow`):
 * no account and no sign-in, only the name the operators' API was given and the server it was for.
 */
export interface OperatorHolder {
  operator: string
  serverId: string
}

/** Whoever a ticket opens a session for: a person signed in, or an operator watching one console. */
export type Holder = TicketHolder | OperatorHolder

/** Whether a session is an operator's, watching the one console its ticket names. */
export const isOperator = (holder: Holder): holder is OperatorHolder => 'operator' in holder

/**
 * A realtime session carries no cookie, so the api issues a short-lived ticket the browser puts in
 * the query string, and the realtime role checks it before opening the session. A ticket opens one
 * session; the browser asks for a new one each time it connects.
 */
export interface RealtimeTickets {
  issue(holder: TicketHolder): Promise<string>
  /** A ticket for an operator to watch one server's console, issued by the operators' API. */
  issueForOperator(holder: OperatorHolder): Promise<string>
  /**
   * Who the ticket was issued to, or null when it is forged, expired, for another deployment, or
   * has already opened a session.
   */
  verify(ticket: string): Promise<Holder | null>
}
