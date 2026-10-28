// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Who a realtime ticket was issued to: the account, and the sign-in session that asked for it. */
export interface TicketHolder {
  userId: string
  sessionId: string
}

/**
 * A realtime session carries no cookie, so the api issues a short-lived ticket the browser puts in
 * the query string, and the realtime role checks it before opening the session. A ticket opens one
 * session; the browser asks for a new one each time it connects.
 */
export interface RealtimeTickets {
  issue(holder: TicketHolder): Promise<string>
  /**
   * Who the ticket was issued to, or null when it is forged, expired, for another deployment, or
   * has already opened a session.
   */
  verify(ticket: string): Promise<TicketHolder | null>
}
